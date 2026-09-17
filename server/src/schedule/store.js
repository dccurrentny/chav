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
