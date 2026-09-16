import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getOperation, OPERATIONS } from '../src/netsapiens/allowlist.js';

test('unknown operations are denied', () => {
  assert.equal(getOperation('answerrule.nuke'), null);
  assert.equal(getOperation(''), null);
});

test('prototype keys cannot reach an operation', () => {
  // Object.hasOwn guards against a caller asking for 'constructor' etc.
  assert.equal(getOperation('constructor'), null);
  assert.equal(getOperation('__proto__'), null);
  assert.equal(getOperation('toString'), null);
});

test('no operation declares a client-supplied domain', () => {
  // The domain must come from the session. If a schema ever accepts one,
  // a customer could aim a write at another customer's tenant.
  for (const [name, op] of Object.entries(OPERATIONS)) {
    const result = op.params.safeParse({ domain: 'someone-else.example', extension: '2001' });
    assert.equal(result.success, false, `${name} accepted a client-supplied domain`);
  }
});

test('write operations that mutate routing require admin', () => {
  for (const [name, op] of Object.entries(OPERATIONS)) {
    if (op.write) {
      assert.equal(op.role, 'admin', `${name} is a write but does not require admin`);
    }
  }
});

test('every write declares a read-back', () => {
  // A 200 from NetSapiens does not prove the change landed.
  for (const [name, op] of Object.entries(OPERATIONS)) {
    if (op.write) {
      assert.ok(op.readBack, `${name} is a write with no readBack declared`);
    }
  }
});

test('extension validation rejects injection-shaped input', () => {
  const op = getOperation('answerrule.list');
  for (const bad of ['2001; DROP', '../../etc', '<script>', '', 'abcd', '99']) {
    assert.equal(op.params.safeParse({ extension: bad }).success, false, `accepted ${bad}`);
  }
  assert.equal(op.params.safeParse({ extension: '2001' }).success, true);
});
