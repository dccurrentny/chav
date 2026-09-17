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
process.env.ADMIN_HOSTNAME   ??= 'admin.example.test';

const { requireAdminHost, requireStaff, requireOwner } = await import('../src/admin/middleware.js');
const { ADMIN_COOKIE, adminCookieOptions } = await import('../src/admin/session.js');
const { COOKIE_NAME } = await import('../src/auth/session.js');

function mockRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.body = b; return this; },
  };
}

test('the console is not served on a customer hostname', () => {
  // The single most important boundary here: an operator endpoint reachable
  // from a customer's portal would hand that customer every other customer.
  for (const host of ['acme.portal.test', 'bolt.portal.test', 'evil.example.com', '']) {
    const res = mockRes();
    let nexted = false;
    requireAdminHost({ hostname: host }, res, () => { nexted = true; });
    assert.equal(nexted, false, `admin endpoints reachable on ${host}`);
    assert.equal(res.statusCode, 404);
  }
});

test('the console answers on its own hostname, case-insensitively', () => {
  for (const host of ['admin.example.test', 'ADMIN.example.TEST']) {
    let nexted = false;
    requireAdminHost({ hostname: host }, mockRes(), () => { nexted = true; });
    assert.equal(nexted, true, `rejected its own hostname: ${host}`);
  }
});

test('the admin cookie is a different cookie from the customer one', () => {
  // Sharing a name would let one be sent where the other is expected.
  assert.notEqual(ADMIN_COOKIE, COOKIE_NAME);
});

test('the admin cookie is httpOnly and strictly same-site', () => {
  const opts = adminCookieOptions();
  assert.equal(opts.httpOnly, true);
  assert.equal(opts.sameSite, 'strict');
});

test('the admin session is shorter-lived than a customer session', () => {
  // An operator cookie is far more powerful, so it should expire sooner.
  const adminMs = adminCookieOptions().maxAge;
  assert.ok(adminMs <= 4 * 3600 * 1000, 'admin session TTL is longer than 4 hours');
});

test('an unauthenticated request is refused', () => {
  const res = mockRes();
  requireStaff({ staff: null }, res, () => {});
  assert.equal(res.statusCode, 401);
});

test('only an owner may manage operators', () => {
  const res = mockRes();
  let nexted = false;
  requireOwner({ staff: { role: 'operator' } }, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);

  let ownerNexted = false;
  requireOwner({ staff: { role: 'owner' } }, mockRes(), () => { ownerNexted = true; });
  assert.equal(ownerNexted, true);
});
