import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL   ??= 'postgres://localhost/unused';
process.env.SESSION_SECRET ??= '0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL      ??= 'fatal';

const { currentCell, DAYS } = await import('../src/schedule/store.js');

test('the live hour is the customer’s local hour, not the server’s', () => {
  // A dispatcher schedule that follows the server's clock would send calls to
  // the wrong person for most of the day.
  const t = new Date('2026-09-17T14:30:00Z');   // Thursday 14:30 UTC
  assert.deepEqual(currentCell('UTC', t),                { day: DAYS.indexOf('Thu'), hour: 14 });
  assert.deepEqual(currentCell('America/New_York', t),   { day: DAYS.indexOf('Thu'), hour: 10 });
  assert.deepEqual(currentCell('America/Los_Angeles', t),{ day: DAYS.indexOf('Thu'), hour: 7 });
});

test('midnight rolls the day over in the right direction', () => {
  // 04:00 UTC Friday is midnight Friday in New York — the hour AND the day
  // both have to come from the customer's zone.
  const t = new Date('2026-09-18T04:00:00Z');
  assert.deepEqual(currentCell('America/New_York', t), { day: DAYS.indexOf('Fri'), hour: 0 });
  // Same instant is still Friday 04:00 in UTC.
  assert.deepEqual(currentCell('UTC', t), { day: DAYS.indexOf('Fri'), hour: 4 });
});

test('the week starts on Monday', () => {
  // The grid is rendered Mon..Sun, so day 0 must be Monday or every row is
  // shifted against what the customer painted.
  assert.equal(DAYS[0], 'Mon');
  assert.equal(DAYS[6], 'Sun');
  assert.equal(DAYS.length, 7);
});

/* ------------------------------------------------- overrides and countdown */

const { resolveAt, resolveUntil } = await import('../src/schedule/store.js');

const YOSSI = { id: 'd-yossi', name: 'Yossi', target: '101', colour: '#2F6FED' };
const MOSHE = { id: 'd-moshe', name: 'Moshe', target: '102', colour: '#17794A' };

// A week with Yossi on every hour, so anything else in a test is the override
// talking and not the grid.
function everyHour(destId) {
  return Array.from({ length: 7 }, () => Array(24).fill(destId));
}

function snap({ grid = everyHour(YOSSI.id), overrides = [] } = {}) {
  return { destinations: [YOSSI, MOSHE], grid, overrides };
}

const ovr = (o) => ({
  id: o.id ?? 'o1',
  destination_id: o.dest === undefined ? MOSHE.id : o.dest,
  destination_name: o.dest === null ? null : (o.name ?? MOSHE.name),
  target: o.dest === null ? null : (o.target ?? MOSHE.target),
  colour: '#17794A',
  starts_at: o.from,
  ends_at: o.to,
  note: o.note ?? null,
});

test('an override beats the week while it lasts', () => {
  const s = snap({ overrides: [ovr({ from: '2026-09-17T12:00:00Z', to: '2026-09-17T18:00:00Z' })] });

  assert.equal(resolveAt(s, 'UTC', new Date('2026-09-17T11:59:00Z')).name, 'Yossi');
  const during = resolveAt(s, 'UTC', new Date('2026-09-17T14:00:00Z'));
  assert.equal(during.name, 'Moshe');
  assert.equal(during.target, '102');
  assert.equal(during.source, 'override');
  // And it stops mattering on its own, without anyone cancelling it.
  assert.equal(resolveAt(s, 'UTC', new Date('2026-09-17T18:00:00Z')).name, 'Yossi');
});

test('the later override wins when two cover the same moment', () => {
  // "Moshe until six" then "actually Yossi from four" has to mean Yossi at
  // five, or a correction silently does nothing.
  const s = snap({
    grid: everyHour(null),
    overrides: [
      ovr({ id: 'a', from: '2026-09-17T12:00:00Z', to: '2026-09-17T18:00:00Z' }),
      ovr({ id: 'b', dest: YOSSI.id, name: 'Yossi', target: '101',
            from: '2026-09-17T16:00:00Z', to: '2026-09-17T18:00:00Z' }),
    ],
  });
  assert.equal(resolveAt(s, 'UTC', new Date('2026-09-17T14:00:00Z')).name, 'Moshe');
  assert.equal(resolveAt(s, 'UTC', new Date('2026-09-17T17:00:00Z')).name, 'Yossi');
});

test('an override pointing at nobody routes nowhere, and says so', () => {
  // Distinct from "no override": the engine must leave the phone system alone
  // rather than fall through to the week.
  const s = snap({ overrides: [ovr({ dest: null, from: '2026-09-17T12:00:00Z', to: '2026-09-17T18:00:00Z' })] });
  const at = resolveAt(s, 'UTC', new Date('2026-09-17T14:00:00Z'));
  assert.equal(at.target, null);
  assert.equal(at.source, 'override-none');
});

test('an override that has not started yet changes nothing', () => {
  const s = snap({ overrides: [ovr({ from: '2026-09-18T12:00:00Z', to: '2026-09-18T18:00:00Z' })] });
  assert.equal(resolveAt(s, 'UTC', new Date('2026-09-17T14:00:00Z')).name, 'Yossi');
});

test('the countdown ends on the half hour when the override does', () => {
  // The shift clock is the number people act on. Rounding it to the next whole
  // hour would tell someone they have 40 minutes when their cover starts in 10.
  const s = snap({ overrides: [ovr({ from: '2026-09-17T12:00:00Z', to: '2026-09-17T17:30:00Z' })] });
  const { current, until, next } = resolveUntil(s, 'UTC', new Date('2026-09-17T14:00:00Z'));
  assert.equal(current.name, 'Moshe');
  assert.equal(until.toISOString(), '2026-09-17T17:30:00.000Z');
  assert.equal(next.name, 'Yossi');
});

test('the countdown finds the hour the week hands over', () => {
  const grid = everyHour(YOSSI.id);
  for (let day = 0; day < 7; day++) for (let hr = 18; hr < 24; hr++) grid[day][hr] = MOSHE.id;
  const { current, until, next } = resolveUntil(snap({ grid }), 'UTC', new Date('2026-09-17T14:20:00Z'));
  assert.equal(current.name, 'Yossi');
  assert.equal(until.toISOString(), '2026-09-17T18:00:00.000Z');
  assert.equal(next.name, 'Moshe');
});

test('one person all week has no end time rather than a wrong one', () => {
  const { current, until, next } = resolveUntil(snap(), 'UTC', new Date('2026-09-17T14:20:00Z'));
  assert.equal(current.name, 'Yossi');
  assert.equal(until, null);
  assert.equal(next, null);
});

test('an upcoming override is what the countdown counts down to', () => {
  const s = snap({ overrides: [ovr({ from: '2026-09-17T15:30:00Z', to: '2026-09-17T18:00:00Z' })] });
  const { current, until, next } = resolveUntil(s, 'UTC', new Date('2026-09-17T14:20:00Z'));
  assert.equal(current.name, 'Yossi');
  assert.equal(until.toISOString(), '2026-09-17T15:30:00.000Z');
  assert.equal(next.name, 'Moshe');
});

test('an unassigned hour is nothing scheduled, not a stale destination', () => {
  const grid = everyHour(null);
  assert.equal(resolveAt(snap({ grid }), 'UTC', new Date('2026-09-17T14:00:00Z')), null);
});

test('the grid is read in the customer’s zone, not the server’s', () => {
  // 02:00 UTC Friday is 22:00 Thursday in New York. Whoever is painted into
  // Thursday 22:00 is who should be on.
  const grid = everyHour(null);
  grid[DAYS.indexOf('Thu')][22] = MOSHE.id;
  const s = snap({ grid });
  assert.equal(resolveAt(s, 'America/New_York', new Date('2026-09-18T02:00:00Z')).name, 'Moshe');
  assert.equal(resolveAt(s, 'UTC', new Date('2026-09-18T02:00:00Z')), null);
});

test('the countdown turns the hour on the customer’s clock, not on UTC', () => {
  // Kolkata is +05:30, so its hours change at half past the UTC hour. Anchoring
  // the walk to UTC hours would put every handover 30 minutes late.
  const grid = everyHour(YOSSI.id);
  grid[DAYS.indexOf('Thu')][18] = MOSHE.id;   // 18:00 in Kolkata = 12:30 UTC
  const { until, next } = resolveUntil(snap({ grid }), 'Asia/Kolkata',
    new Date('2026-09-17T11:00:00Z'));
  assert.equal(until.toISOString(), '2026-09-17T12:30:00.000Z');
  assert.equal(next.name, 'Moshe');
});
