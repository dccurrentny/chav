import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL   ??= 'postgres://localhost/unused';
process.env.SESSION_SECRET ??= '0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL      ??= 'fatal';

const { FEATURES, FEATURE_NAMES, DEFAULT_FEATURES, withDependencies,
        operationsFor, featureForOperation } = await import('../src/features.js');
const { OPERATIONS } = await import('../src/netsapiens/allowlist.js');

test('every operation a feature grants actually exists', () => {
  // A feature naming an operation that is not in the allowlist would silently
  // grant nothing, and the customer would see a button that always fails.
  for (const [name, f] of Object.entries(FEATURES)) {
    for (const op of f.operations) {
      assert.ok(Object.hasOwn(OPERATIONS, op), `${name} grants unknown operation ${op}`);
    }
  }
});

test('every operation is reachable through some feature', () => {
  // An operation no feature grants can never be called, which is a silent
  // dead end rather than a deliberate restriction.
  for (const name of Object.keys(OPERATIONS)) {
    assert.ok(featureForOperation(name), `${name} is not granted by any feature`);
  }
});

test('dependencies are pulled in automatically', () => {
  // Editing rules without being able to read them is not a usable state.
  const got = withDependencies(['forwarding_edit']);
  assert.ok(got.includes('forwarding_view'),
    'enabling editing did not enable viewing');
});

test('the defaults are read-only', () => {
  // A new customer should not be able to change their routing before anyone
  // has decided they should.
  const ops = operationsFor([...DEFAULT_FEATURES]);
  for (const op of ops) {
    assert.equal(OPERATIONS[op].write, false,
      `${op} can write but is on by default for a new customer`);
  }
});

test('an unknown feature grants nothing', () => {
  assert.deepEqual(withDependencies(['not_a_feature']), []);
  assert.equal(operationsFor(['not_a_feature']).size, 0);
});

test('the schedule can be granted without free rein over rules', () => {
  // A customer can be given the schedule — which writes forwarding on their
  // behalf — without being given forwarding_edit.
  assert.ok(FEATURE_NAMES.includes('schedule'));
  assert.ok(!FEATURES.schedule.operations.includes('answerrule.delete'),
    'the schedule can delete rules, which is more than it needs');
});
