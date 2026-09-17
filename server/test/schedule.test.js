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
