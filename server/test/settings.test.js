import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL     ??= 'postgres://localhost/unused';
process.env.SESSION_SECRET   ??= '0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL        ??= 'fatal';

const { SETTABLE, SECRET_KEYS, PBX_KEYS, TELCO_KEYS } = await import('../src/settings.js');

test('only SkySwitch connection keys are settable from the console', () => {
  // This list is what stops the settings table becoming a way to reconfigure
  // arbitrary internals — SESSION_SECRET or DATABASE_URL must never be in it.
  for (const key of SETTABLE) {
    assert.match(key, /^(NS|TELCO)_/, `${key} is settable but is not a connection setting`);
  }
  assert.ok(!SETTABLE.includes('SESSION_SECRET'));
  assert.ok(!SETTABLE.includes('DATABASE_URL'));
  assert.ok(!SETTABLE.includes('ADMIN_HOSTNAME'));
});

test('the two servers are configured separately and do not share keys', () => {
  // SkySwitch's PBX and Telco APIs have different hosts and credentials.
  // A key belonging to both would mean changing one silently changed the other.
  const shared = PBX_KEYS.filter((k) => TELCO_KEYS.includes(k));
  assert.deepEqual(shared, [], 'a setting key is shared between the two servers');
  assert.deepEqual([...PBX_KEYS, ...TELCO_KEYS].sort(), [...SETTABLE].sort());
});

test('every credential-shaped Telco key is marked secret', () => {
  for (const key of ['TELCO_API_KEY', 'TELCO_PASSWORD', 'TELCO_CLIENT_SECRET']) {
    assert.ok(SECRET_KEYS.includes(key), `${key} is a credential but is not marked secret`);
  }
  // The auth style and token path are configuration, not secrets — they are
  // shown in the console so an operator can see what is set.
  assert.ok(!SECRET_KEYS.includes('TELCO_AUTH_STYLE'));
  assert.ok(!SECRET_KEYS.includes('TELCO_TOKEN_PATH'));
});

test('the credential-shaped settings are marked secret', () => {
  // Anything marked secret is never echoed back to a browser.
  assert.ok(SECRET_KEYS.includes('NS_CLIENT_SECRET'));
  assert.ok(SECRET_KEYS.includes('NS_PASSWORD'));
  for (const key of SECRET_KEYS) {
    assert.ok(SETTABLE.includes(key), `${key} is marked secret but is not settable`);
  }
});

test('every secret key is a subset of the settable keys', () => {
  const extra = SECRET_KEYS.filter((k) => !SETTABLE.includes(k));
  assert.deepEqual(extra, []);
});

test('every operation names the server it belongs to', async () => {
  // SkySwitch has two API servers that speak differently. An operation without
  // a server, or with an unknown one, would be dispatched somewhere arbitrary.
  const { OPERATIONS } = await import('../src/netsapiens/allowlist.js');
  for (const [name, op] of Object.entries(OPERATIONS)) {
    assert.ok(['pbx', 'telco'].includes(op.server), `${name} has no valid server`);
    if (op.server === 'pbx') {
      assert.ok(op.object && op.action, `${name} is a pbx operation without object/action`);
    } else {
      assert.ok(op.method && op.path, `${name} is a telco operation without method/path`);
    }
  }
});

test('a customer set to its own credentials never falls back to the shared ones', async () => {
  // The choice used to be inferred from whether the fields happened to be
  // filled. That turns a half-finished local setup into a reseller-
  // credentialled one, which is the opposite of what choosing local means.
  const src = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../src/settings.js', import.meta.url), 'utf8'));

  assert.match(src, /if \(mode !== 'own'\) return getNsSettings\(\)/,
    'the shared credentials are not gated on the stated mode');
  // An incomplete 'own' set is reported as unset, not substituted.
  assert.match(src, /Reported as unset rather than substituted/,
    'an incomplete local set may still fall through to the shared credentials');
});
