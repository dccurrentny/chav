import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL     ??= 'postgres://localhost/unused';
process.env.SESSION_SECRET   ??= '0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL        ??= 'fatal';

const { SETTABLE, SECRET_KEYS } = await import('../src/settings.js');

test('only SkySwitch keys are settable from the console', () => {
  // This list is what stops the settings table becoming a way to reconfigure
  // arbitrary internals — SESSION_SECRET or DATABASE_URL must never be in it.
  for (const key of SETTABLE) {
    assert.match(key, /^NS_/, `${key} is settable but is not a SkySwitch setting`);
  }
  assert.ok(!SETTABLE.includes('SESSION_SECRET'));
  assert.ok(!SETTABLE.includes('DATABASE_URL'));
  assert.ok(!SETTABLE.includes('ADMIN_HOSTNAME'));
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
