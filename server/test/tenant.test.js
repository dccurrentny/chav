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

const { requireTenant } = await import('../src/tenant.js');
const { requireAuth }   = await import('../src/auth/middleware.js');

function mockRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.body = b; return this; },
  };
}

test('an unknown hostname is not a portal', () => {
  const res = mockRes();
  let nexted = false;
  requireTenant({ tenant: null }, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'unknown_portal');
});

test('a suspended tenant answers exactly like an unknown one', () => {
  // Probing must not reveal which customers exist.
  const unknown = mockRes();
  requireTenant({ tenant: null }, unknown, () => {});
  const suspended = mockRes();
  requireTenant({ tenant: { id: 't1', status: 'suspended' } }, suspended, () => {});

  assert.equal(suspended.statusCode, unknown.statusCode);
  assert.deepEqual(suspended.body, unknown.body);
});

test('an active tenant passes through', () => {
  let nexted = false;
  requireTenant({ tenant: { id: 't1', status: 'active' } }, mockRes(), () => { nexted = true; });
  assert.equal(nexted, true);
});

test("a session cannot be replayed on another customer's hostname", () => {
  // Defence in depth behind host-only cookies: if a Domain attribute were ever
  // added by mistake, this is what still keeps the tenants apart.
  const res = mockRes();
  let nexted = false;
  requireAuth(
    { session: { tenant_id: 'acme' }, tenant: { id: 'bolt', status: 'active' } },
    res,
    () => { nexted = true; },
  );
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'wrong_portal');
});

test('a session on its own hostname passes', () => {
  let nexted = false;
  requireAuth(
    { session: { tenant_id: 'acme' }, tenant: { id: 'acme', status: 'active' } },
    mockRes(),
    () => { nexted = true; },
  );
  assert.equal(nexted, true);
});

test('an authenticated session with no resolved tenant is rejected', () => {
  const res = mockRes();
  requireAuth({ session: { tenant_id: 'acme' }, tenant: null }, res, () => {});
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'wrong_portal');
});
