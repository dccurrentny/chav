// Reading and writing a customer's dispatch schedule.
import { query, withTransaction } from '../db.js';

export const DAYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

export async function destinationsFor(tenantId) {
  const { rows } = await query(
    `SELECT id, name, target, colour, position
       FROM tenant_destinations WHERE tenant_id = $1
      ORDER BY position, created_at`,
    [tenantId]);
  return rows;
}

export async function addDestination(tenantId, { name, target, colour }) {
  const { rows } = await query(
    `INSERT INTO tenant_destinations (tenant_id, name, target, colour, position)
     VALUES ($1,$2,$3,$4,
       COALESCE((SELECT max(position) + 1 FROM tenant_destinations WHERE tenant_id = $1), 0))
     RETURNING id, name, target, colour, position`,
    [tenantId, name, target, colour ?? '#2F6FED']);
  return rows[0];
}

export async function updateDestination(tenantId, id, patch) {
  const { rows } = await query(
    `UPDATE tenant_destinations
        SET name   = COALESCE($3, name),
            target = COALESCE($4, target),
            colour = COALESCE($5, colour)
      WHERE tenant_id = $1 AND id = $2
      RETURNING id, name, target, colour, position`,
    [tenantId, id, patch.name ?? null, patch.target ?? null, patch.colour ?? null]);
  return rows[0] ?? null;
}

// Cascades to the schedule: hours that pointed here become unassigned rather
// than pointing at something that no longer exists.
export async function removeDestination(tenantId, id) {
  const { rowCount } = await query(
    'DELETE FROM tenant_destinations WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  return rowCount > 0;
}

/** The week as a 7x24 grid of destination ids, with null for "leave alone". */
export async function scheduleFor(tenantId) {
  const { rows } = await query(
    'SELECT day_of_week, hour_of_day, destination_id FROM tenant_schedule WHERE tenant_id = $1',
    [tenantId]);

  const grid = Array.from({ length: 7 }, () => Array(24).fill(null));
  for (const r of rows) grid[r.day_of_week][r.hour_of_day] = r.destination_id;
  return grid;
}

/**
 * Replace the whole week.
 *
 * One transaction, so a half-applied schedule can never be what the engine
 * reads next: an hour pointing somewhere unintended is worse than the save
 * failing outright.
 */
export async function setSchedule(tenantId, grid) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM tenant_schedule WHERE tenant_id = $1', [tenantId]);
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const dest = grid[day]?.[hour] ?? null;
        if (!dest) continue;   // unassigned hours are simply absent
        await client.query(
          `INSERT INTO tenant_schedule (tenant_id, day_of_week, hour_of_day, destination_id)
           VALUES ($1,$2,$3,$4)`,
          [tenantId, day, hour, dest]);
      }
    }
  });
}

/* ------------------------------------------------------------- overrides */

export async function overridesFor(tenantId, { includePast = false } = {}) {
  const { rows } = await query(
    `SELECT o.id, o.destination_id, o.starts_at, o.ends_at, o.note, o.created_by,
            d.name AS destination_name, d.target, d.colour
       FROM tenant_overrides o
       LEFT JOIN tenant_destinations d ON d.id = o.destination_id
      WHERE o.tenant_id = $1 AND ($2 OR o.ends_at > now())
      ORDER BY o.starts_at`,
    [tenantId, includePast]);
  return rows;
}

export async function addOverride(tenantId, { destinationId, startsAt, endsAt, note, createdBy }) {
  const { rows } = await query(
    `INSERT INTO tenant_overrides
       (tenant_id, destination_id, starts_at, ends_at, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, destination_id, starts_at, ends_at, note`,
    [tenantId, destinationId ?? null, startsAt, endsAt, note ?? null, createdBy ?? null]);
  return rows[0];
}

export async function removeOverride(tenantId, id) {
  const { rowCount } = await query(
    'DELETE FROM tenant_overrides WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  return rowCount > 0;
}

/**
 * Everything needed to answer "who is on, and until when", in one read.
 *
 * The countdown has to look ahead across a week, and doing that with a query
 * per hour was 300-odd round trips for one page load. Read once, decide in
 * memory.
 */
export async function snapshotFor(tenantId) {
  const [destinations, grid, overrides] = await Promise.all([
    destinationsFor(tenantId),
    scheduleFor(tenantId),
    overridesFor(tenantId),
  ]);
  return { destinations, grid, overrides };
}

/**
 * What should be live at an instant: an override if one covers it, otherwise
 * the weekly grid. The one place that decides, so the engine and the countdown
 * the customer is reading cannot disagree about who is on.
 *
 * Returns null for "nothing scheduled — leave the phone system alone".
 */
export function resolveAt(snapshot, timezone, at) {
  const t = at.getTime();

  // The latest-starting override wins, so "and actually, until four" said
  // after "until six" does what the customer meant.
  let winner = null;
  for (const o of snapshot.overrides) {
    const from = new Date(o.starts_at).getTime();
    const to = new Date(o.ends_at).getTime();
    if (from <= t && t < to && (!winner || from >= new Date(winner.starts_at).getTime())) {
      winner = o;
    }
  }
  if (winner) {
    return {
      target: winner.destination_id ? winner.target : null,
      name: winner.destination_id ? winner.destination_name : null,
      colour: winner.colour ?? null,
      source: winner.destination_id ? 'override' : 'override-none',
      endsAt: winner.ends_at,
      overrideId: winner.id,
      note: winner.note ?? null,
    };
  }

  const { day, hour } = currentCell(timezone, at);
  if (day < 0) return null;

  const id = snapshot.grid[day]?.[hour] ?? null;
  const dest = id ? snapshot.destinations.find((d) => d.id === id) : null;
  if (!dest) return null;

  return {
    target: dest.target,
    name: dest.name,
    colour: dest.colour,
    source: 'schedule',
    destinationId: dest.id,
    day,
    hour,
  };
}

/**
 * When the current destination stops being current, and who takes over.
 *
 * Checks every hour boundary in the coming week plus every moment an override
 * starts or ends — an override need not begin on the hour, and a countdown
 * that ignored that would tell someone they were on for another 40 minutes
 * when their cover started in 10. Bounded to a week; past that "no change
 * scheduled" is the honest answer.
 */
export function resolveUntil(snapshot, timezone, from = new Date()) {
  const current = resolveAt(snapshot, timezone, from);
  const currentTarget = current?.target ?? null;
  const horizon = from.getTime() + 7 * 24 * 3600_000;

  const marks = new Set();
  const first = nextLocalHour(timezone, from).getTime();
  for (let i = 0; i < 24 * 7; i++) marks.add(first + i * 3600_000);
  for (const o of snapshot.overrides) {
    for (const stamp of [new Date(o.starts_at).getTime(), new Date(o.ends_at).getTime()]) {
      if (stamp > from.getTime() && stamp <= horizon) marks.add(stamp);
    }
  }

  for (const stamp of [...marks].sort((a, b) => a - b)) {
    const at = new Date(stamp);
    const next = resolveAt(snapshot, timezone, at);
    if ((next?.target ?? null) !== currentTarget) return { current, until: at, next };
  }
  return { current, until: null, next: null };
}

// The next time the grid can move: the top of the hour on the CUSTOMER's
// clock. Rounding on the server's clock instead is right in New York and wrong
// in Kolkata, whose hours turn at half past the UTC hour.
function nextLocalHour(timezone, from) {
  const p = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(from).forEach((x) => { p[x.type] = x.value; });

  const into = Number(p.minute) * 60_000 + Number(p.second) * 1000 + from.getMilliseconds();
  return new Date(from.getTime() + 3600_000 - into);
}

/** The same answer, for a caller that has no snapshot in hand. */
export async function effectiveAt(tenantId, timezone, at = new Date()) {
  return resolveAt(await snapshotFor(tenantId), timezone, at);
}

export async function effectiveUntil(tenantId, timezone, from = new Date()) {
  return resolveUntil(await snapshotFor(tenantId), timezone, from);
}

export async function stateFor(tenantId) {
  const { rows } = await query(
    `SELECT applied_target, applied_at, last_error, last_attempt
       FROM tenant_schedule_state WHERE tenant_id = $1`,
    [tenantId]);
  return rows[0] ?? null;
}

export async function recordApplied(tenantId, { target = null, error = null }) {
  await query(
    `INSERT INTO tenant_schedule_state (tenant_id, applied_target, applied_at, last_error, last_attempt)
     VALUES ($1,$2, CASE WHEN $3::text IS NULL THEN now() ELSE NULL END, $3, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         applied_target = CASE WHEN $3::text IS NULL THEN EXCLUDED.applied_target
                               ELSE tenant_schedule_state.applied_target END,
         applied_at     = CASE WHEN $3::text IS NULL THEN now()
                               ELSE tenant_schedule_state.applied_at END,
         last_error     = $3,
         last_attempt   = now()`,
    [tenantId, target, error]);
}

/** Which cell is live right now, in the customer's own timezone. */
export function currentCell(timezone, now = new Date()) {
  // Intl gives the weekday and hour in the target zone without a date library,
  // and without the server's own clock zone mattering.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: 'numeric', hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);

  // hour12:false renders midnight as 24 in some environments.
  return { day: DAYS.indexOf(weekday), hour: hour === 24 ? 0 : hour };
}
