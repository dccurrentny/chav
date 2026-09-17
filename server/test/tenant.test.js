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
process.env.ADMIN_HOSTNAME         ??= 'admin.example.test';
process.env.SHARED_PORTAL_HOSTNAME ??= 'portal.example.test';

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

test('a tenant with no extension set reports none, and never a default', async () => {
  // The frontend used to hardcode 2001, so every customer's portal asked about
  // the same extension. A wrong default is worse than nothing here: it would
  // show one customer another customer's line.
  const src = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../../public/app.js', import.meta.url), 'utf8'));

  assert.ok(!/EXTENSION\s*=\s*['"]\d+['"]/.test(src),
    'a hardcoded extension is back in the customer portal');
  assert.match(src, /mainExtension/,
    'the portal no longer reads the tenant extension');
  // And it must refuse to load rules rather than fall back.
  assert.match(src, /if \(!ext\)/,
    'the portal does not guard against a missing extension');
});

test('the shared portal has no tenant of its own', async () => {
  // It belongs to the provider. Resolving a tenant from it would mean showing
  // one customer's name and branding to everyone who visits the front door.
  const { isSharedPortal, isReservedHostname } = await import('../src/tenant.js');

  assert.equal(isSharedPortal('portal.example.test'), true);
  assert.equal(isSharedPortal('PORTAL.EXAMPLE.TEST'), true, 'hostname check is case-sensitive');
  assert.equal(isSharedPortal('acme.portal.example.test'), false);

  // Neither address the server answers on may be claimed by a customer.
  assert.equal(isReservedHostname('portal.example.test'), true);
  assert.equal(isReservedHostname('admin.example.test'), true);
  assert.equal(isReservedHostname('acme.portal.example.test'), false);
});

test('requireTenant admits the shared portal but not an unknown host', async () => {
  const { requireTenant } = await import('../src/tenant.js');
  let shared = false;
  requireTenant({ sharedPortal: true, tenant: null }, mockRes(), () => { shared = true; });
  assert.equal(shared, true, 'the shared portal was treated as an unknown host');

  const res = mockRes();
  let unknown = false;
  requireTenant({ sharedPortal: false, tenant: null }, res, () => { unknown = true; });
  assert.equal(unknown, false);
  assert.equal(res.statusCode, 404);
});
