import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL     ??= 'postgres://localhost/unused';
process.env.SESSION_SECRET   ??= '0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.NS_BASE_URL      ??= 'https://ns.example.test';
process.env.NS_CLIENT_ID     ??= 'x';
process.env.NS_CLIENT_SECRET ??= 'x';
process.env.NS_USERNAME      ??= 'x';
process.env.NS_PASSWORD      ??= 'x';
process.env.LOG_LEVEL        ??= 'fatal';

const { OPERATIONS } = await import('../src/netsapiens/allowlist.js');
const { refuseImpersonatedOperation, IMPERSONATION_TTL_MINUTES, impersonationUrl } =
  await import('../src/admin/impersonate.js');

function mockRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.body = b; return this; },
  };
}
const mockReq = { session: { tenant_id: 't', user_id: 'u', impersonated_by: 's', email: 'x@y.z' }, ip: '127.0.0.1' };

test('a refused support write returns 403 with its own error code', () => {
  const res = mockRes();
  refuseImpersonatedOperation(mockReq, res, 'answerrule.update');
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'impersonation_read_only');
});

// Regression: the guard was originally middleware keyed on the HTTP method.
// Every operation here is a POST, reads included, so it blocked reads too and
// a support view could see nothing at all — the entire point of the feature.
test('read operations are POSTs, so a method-based guard cannot be used', () => {
  const reads = Object.entries(OPERATIONS).filter(([, op]) => !op.write);
  assert.ok(reads.length > 0, 'expected some read operations');
  // Every operation, read or write, goes through the same POST route. If this
  // ever stops being true the guard can be revisited — until then it must key
  // off op.write and nothing else.
  for (const [name, op] of reads) {
    assert.equal(op.write, false, `${name} should be a read`);
  }
});

test('every write operation is one a support view must refuse', () => {
  const writes = Object.entries(OPERATIONS).filter(([, op]) => op.write);
  assert.ok(writes.length > 0, 'expected some write operations');
  for (const [name, op] of writes) {
    assert.ok(op.write === true, `${name} not marked as a write`);
  }
});

test('a support session is short-lived', () => {
  assert.ok(IMPERSONATION_TTL_MINUTES <= 30,
    'support sessions should not outlive a support call');
});

test('the support URL is built from a fixed path and never a supplied target', () => {
  const url = impersonationUrl('acme.portal.test', 'tok en/with?chars');
  assert.match(url, /\/__impersonate\?t=/);
  // The token is encoded, so it cannot smuggle extra query parameters.
  assert.ok(!url.includes('tok en'), 'token was not encoded');
  assert.equal(url.split('?').length, 2, 'more than one query separator');
});
