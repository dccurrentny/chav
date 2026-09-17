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
  // The API calls this field `user`; it is the extension the rules belong to.
  const op = getOperation('answerrule.list');
  for (const bad of ['2001; DROP', '../../etc', '<script>', '', 'abcd', '99']) {
    assert.equal(op.params.safeParse({ user: bad }).success, false, `accepted ${bad}`);
  }
  assert.equal(op.params.safeParse({ user: '2001' }).success, true);
});

test('answerrule.update matches the published field names', () => {
  // Taken from SkySwitch's OpenAPI definition for object=answerrule&action=update.
  // These were wrong before — extension/forward_destination/forward_enable —
  // which would have failed every routing change a customer made.
  const op = getOperation('answerrule.update');
  const valid = {
    user: '2001', time_frame: 'Business Hours', order: 0, enable: 'yes',
    for_parameters: '2999', for_control: 'e',
  };
  assert.equal(op.params.safeParse(valid).success, true, 'the documented shape was rejected');

  // The old names must not be silently accepted.
  for (const stale of ['extension', 'forward_destination', 'forward_enable']) {
    const res = op.params.safeParse({ ...valid, [stale]: 'x' });
    assert.equal(res.success, false, `${stale} is still accepted`);
  }
});

test('answerrule.update requires the fields the API requires', () => {
  const op = getOperation('answerrule.update');
  const full = { user: '2001', time_frame: '*', order: 0, enable: 'yes' };
  for (const required of ['user', 'time_frame', 'order', 'enable']) {
    const partial = { ...full };
    delete partial[required];
    assert.equal(op.params.safeParse(partial).success, false,
      `${required} is documented as required but was optional`);
  }
});

test('feature toggles only accept the documented "e" and "d"', () => {
  const op = getOperation('answerrule.update');
  const base = { user: '2001', time_frame: '*', order: 0, enable: 'yes', for_parameters: '2999' };
  assert.equal(op.params.safeParse({ ...base, for_control: 'e' }).success, true);
  assert.equal(op.params.safeParse({ ...base, for_control: 'd' }).success, true);
  for (const bad of ['yes', 'no', 'true', 'enable', '1']) {
    assert.equal(op.params.safeParse({ ...base, for_control: bad }).success, false,
      `for_control accepted ${bad}`);
  }
});
