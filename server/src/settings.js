// Settings an operator can change from the console, stored encrypted.
//
// Precedence: a value set here overrides the matching environment variable, so
// an installation can start from portal.env and move to console-managed
// settings without a migration step or a restart.
import crypto from 'node:crypto';
import { query } from './db.js';
import { config } from './config.js';
import { logger } from './logger.js';

// Keys an operator may set. Anything else is refused — this list is what stops
// the settings table from becoming a way to reconfigure arbitrary internals.
export const SETTABLE = Object.freeze([
  'NS_BASE_URL', 'NS_CLIENT_ID', 'NS_CLIENT_SECRET', 'NS_USERNAME', 'NS_PASSWORD',
]);

// Values that must never be echoed back to a browser, even to an operator.
// The console shows whether they are set, never what they are.
export const SECRET_KEYS = Object.freeze(['NS_CLIENT_SECRET', 'NS_PASSWORD']);

// The encryption key is derived from SESSION_SECRET rather than being a second
// secret to manage. The trade-off is explicit: rotating SESSION_SECRET makes
// these values undecryptable and they must be re-entered in the console — which
// is a small job now that the console exists, and is documented in the runbook.
const KEY = crypto.hkdfSync(
  'sha256',
  Buffer.from(config.SESSION_SECRET, 'utf8'),
  Buffer.from('portal-settings-v1-salt'),
  Buffer.from('app_settings value encryption'),
  32,
);

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(KEY), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function decrypt(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(KEY), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// Read on every SkySwitch call, so cache briefly. Short enough that a change
// takes effect without a restart, long enough not to query per request.
const CACHE_TTL_MS = 15_000;
let cache = null;   // { at, values }

export function invalidateSettingsCache() {
  cache = null;
}

async function loadStored() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.values;

  const values = {};
  try {
    const { rows } = await query('SELECT key, value_enc FROM app_settings');
    for (const row of rows) {
      if (!SETTABLE.includes(row.key)) continue;
      try {
        values[row.key] = decrypt(row.value_enc);
      } catch {
        // Almost always a rotated SESSION_SECRET. Fall back to the environment
        // rather than failing the request, and say so once per cache period.
        logger.error({ key: row.key },
          'could not decrypt a stored setting — has SESSION_SECRET changed? ' +
          're-enter SkySwitch settings in the console');
      }
    }
  } catch (err) {
    // A settings table that is missing or unreachable must not take SkySwitch
    // down when portal.env already has working values.
    logger.error({ err: err.message }, 'could not read app_settings; using environment only');
  }

  cache = { at: Date.now(), values };
  return values;
}

/** Effective value for a key: stored first, then the environment. */
export async function getSetting(key) {
  const stored = await loadStored();
  return stored[key] || config[key] || null;
}

/** All SkySwitch settings, resolved, with where each came from. */
export async function getNsSettings() {
  const stored = await loadStored();
  const out = {};
  for (const key of SETTABLE) {
    const value = stored[key] || config[key] || null;
    out[key] = {
      value,
      set: Boolean(value),
      source: stored[key] ? 'console' : (config[key] ? 'file' : null),
    };
  }
  return out;
}

/** What the console may see: presence and origin, never a secret's value. */
export async function describeNsSettings() {
  const all = await getNsSettings();
  const out = {};
  for (const [key, info] of Object.entries(all)) {
    out[key] = {
      set: info.set,
      source: info.source,
      value: SECRET_KEYS.includes(key) ? null : info.value,
    };
  }
  return out;
}

export async function setSettings(entries, staffId) {
  const keys = Object.keys(entries);
  const bad = keys.filter((k) => !SETTABLE.includes(k));
  if (bad.length) throw new Error(`not a settable key: ${bad.join(', ')}`);

  for (const [key, value] of Object.entries(entries)) {
    if (value === null || value === '') {
      // Clearing falls back to whatever portal.env has, which may be nothing.
      await query('DELETE FROM app_settings WHERE key = $1', [key]);
      continue;
    }
    await query(
      `INSERT INTO app_settings (key, value_enc, updated_by, updated_at)
       VALUES ($1,$2,$3, now())
         ON CONFLICT (key) DO UPDATE
           SET value_enc = EXCLUDED.value_enc,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
      [key, encrypt(value), staffId ?? null],
    );
  }
  invalidateSettingsCache();
}
