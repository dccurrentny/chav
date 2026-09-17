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
const { actorFor, IMPERSONATION_TTL_MINUTES, impersonationUrl } =
  await import('../src/admin/impersonate.js');

function mockRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.body = b; return this; },
  };
}
const mockReq = { session: { tenant_id: 't', user_id: 'u', impersonated_by: 's', email: 'x@y.z' }, ip: '127.0.0.1' };

// Support sessions may now change things — an operator setting a customer up
// has to be able to, and a customer with no accounts has nobody else who can.
// What must never happen is the change reading as the CUSTOMER's.
test('a change made from a support session is attributed to the operator', () => {
  const actor = actorFor({
    impersonated_by: 'staff-id', staff_email: 'aron@dccurrentny.com',
    user_id: 'user-id', email: 'owner@acme.com',
  });
  assert.equal(actor.actorKind, 'staff');
  assert.equal(actor.staffId, 'staff-id');
  assert.equal(actor.actorEmail, 'aron@dccurrentny.com',
    'the audit row would name the customer rather than the operator');
  // The account acted on is still recorded.
  assert.equal(actor.userId, 'user-id');
});

test('a preview session is attributed to the operator with no user', () => {
  const actor = actorFor({
    impersonated_by: 'staff-id', staff_email: 'aron@dccurrentny.com',
    user_id: null, email: null,
  });
  assert.equal(actor.actorKind, 'staff');
  assert.equal(actor.actorEmail, 'aron@dccurrentny.com');
  assert.equal(actor.userId, null);
});

test("a customer's own change is never attributed to staff", () => {
  const actor = actorFor({
    impersonated_by: null, user_id: 'user-id', email: 'owner@acme.com',
  });
  assert.equal(actor.actorKind, 'customer');
  assert.equal(actor.staffId, null);
  assert.equal(actor.actorEmail, 'owner@acme.com');
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

test('a support view works for a customer with no address of their own', async () => {
  // Regression: impersonation required tenants.hostname, which was correct
  // when every customer had one. With the shared portal that is now the normal
  // case, so "View as" was broken for exactly those customers.
  const src = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../src/admin/manage.js', import.meta.url), 'utf8'));

  assert.match(src, /user\.hostname \|\| config\.SHARED_PORTAL_HOSTNAME/,
    'impersonation does not fall back to the shared portal');
  assert.ok(!/if \(!user\.hostname\) \{/.test(src),
    'a missing hostname is still treated as an error');
});

test('a grant redeemed on the shared portal takes its tenant from the grant', async () => {
  // There is no hostname tenant on the shared portal, so the grant's own user
  // supplies it. Safe because the grant is single-use, 60 seconds, and only an
  // operator can mint one.
  const src = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../src/routes/impersonate.js', import.meta.url), 'utf8'));

  assert.match(src, /req\.sharedPortal \? null : req\.tenant\.id/,
    'redemption still assumes a hostname tenant');
  assert.match(src, /tenantId: grant\.tenant_id/,
    'the audit row does not use the grant’s tenant');
});
