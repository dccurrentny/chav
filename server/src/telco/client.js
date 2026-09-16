// SkySwitch Telco API client.
//
// A different server from the PBX: different host, different credentials, and
// in general a different authentication scheme. Rather than guess which, the
// scheme is configured (TELCO_AUTH_STYLE) and this client implements the three
// that cover essentially every REST API of this kind.
//
// The request shape below is a plain REST call — method, path, JSON body. If
// the Telco API turns out to use an object/action convention like the PBX, that
// belongs in the operation definitions, not here.
import { config } from '../config.js';
import { getTelcoSettings } from '../settings.js';
import { logger } from '../logger.js';
import { NsError } from '../netsapiens/client.js';

export const AUTH_STYLES = Object.freeze(['bearer', 'basic', 'oauth2']);

let cachedToken = null;    // oauth2 only
let inFlight = null;

export function _resetTelcoToken() {
  cachedToken = null;
  inFlight = null;
}

async function creds() {
  const s = await getTelcoSettings();
  const v = Object.fromEntries(Object.entries(s).map(([k, x]) => [k, x.value]));
  const style = (v.TELCO_AUTH_STYLE || 'bearer').toLowerCase();

  // Which fields are required depends on the scheme, so validate per style
  // rather than demanding everything.
  let required;
  if (style === 'basic')       required = ['TELCO_BASE_URL', 'TELCO_USERNAME', 'TELCO_PASSWORD'];
  else if (style === 'oauth2') required = ['TELCO_BASE_URL', 'TELCO_CLIENT_ID', 'TELCO_CLIENT_SECRET',
                                           'TELCO_USERNAME', 'TELCO_PASSWORD'];
  else                         required = ['TELCO_BASE_URL', 'TELCO_API_KEY'];

  const missing = required.filter((k) => !v[k]);
  return { values: v, style, missing, configured: missing.length === 0 };
}

function transportError(err) {
  return new NsError(
    err.name === 'TimeoutError'
      ? 'SkySwitch Telco API timed out'
      : `SkySwitch Telco API unreachable: ${err.message}`,
    { retryable: true },
  );
}

async function oauthToken(c) {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.accessToken;

  inFlight ??= (async () => {
    const v = c.values;
    // Configurable: SkySwitch documents this on telco.readme.io and it is not
    // worth hard-coding a path from memory when getting it wrong looks like an
    // authentication failure.
    const url = new URL(v.TELCO_TOKEN_PATH || '/oauth2/token', v.TELCO_BASE_URL).toString();
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: v.TELCO_CLIENT_ID,
          client_secret: v.TELCO_CLIENT_SECRET,
          username: v.TELCO_USERNAME,
          password: v.TELCO_PASSWORD,
        }),
        signal: AbortSignal.timeout(config.NS_TIMEOUT_MS),
      });
    } catch (err) {
      throw transportError(err);
    }
    if (!res.ok) {
      throw new NsError(`Telco token request failed (${res.status})`, {
        status: res.status, retryable: res.status >= 500,
      });
    }
    const json = await res.json().catch(() => null);
    if (!json?.access_token) throw new NsError('Telco token response had no access_token');
    cachedToken = {
      accessToken: json.access_token,
      expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    };
    return cachedToken.accessToken;
  })().finally(() => { inFlight = null; });

  return inFlight;
}

async function authHeader(c) {
  const v = c.values;
  if (c.style === 'basic') {
    const b64 = Buffer.from(`${v.TELCO_USERNAME}:${v.TELCO_PASSWORD}`).toString('base64');
    return `Basic ${b64}`;
  }
  if (c.style === 'oauth2') {
    return `Bearer ${await oauthToken(c)}`;
  }
  return `Bearer ${v.TELCO_API_KEY}`;
}

/**
 * Call the Telco API.
 *
 * `path` comes from an operation definition, never from a client, and query
 * parameters are built here so a value can never smuggle in a second one.
 */
export async function telcoRequest(method, path, { query = {}, body = null } = {}) {
  const c = await creds();
  if (!c.configured) {
    throw new NsError('The SkySwitch Telco API is not connected on this server', {
      notConfigured: true,
      missing: c.missing,
      retryable: false,
    });
  }

  const url = new URL(path, c.values.TELCO_BASE_URL);
  for (const [k, val] of Object.entries(query)) {
    if (val !== undefined && val !== null) url.searchParams.set(k, String(val));
  }

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: await authHeader(c),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.NS_TIMEOUT_MS),
    });
  } catch (err) {
    const e = transportError(err);
    e.durationMs = Date.now() - started;
    throw e;
  }

  // An expired oauth2 token looks like any other 401; drop it and try once.
  if (res.status === 401 && c.style === 'oauth2' && cachedToken) {
    _resetTelcoToken();
    return telcoRequest(method, path, { query, body });
  }

  const durationMs = Date.now() - started;
  const text = await res.text();

  if (!res.ok) {
    throw new NsError(`SkySwitch Telco API returned ${res.status}`, {
      status: res.status,
      detail: text.slice(0, 500),
      retryable: res.status >= 500 || res.status === 429,
      durationMs,
    });
  }

  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { data, durationMs };
}

/** Used by the console's Test connection button for the Telco server. */
export async function testTelcoConnection() {
  _resetTelcoToken();
  const c = await creds();
  if (!c.configured) return { ok: false, reason: 'not_configured', missing: c.missing };

  try {
    // No universally safe read endpoint is known for this API yet, so prove
    // reachability and credentials as far as we can without inventing a path:
    // build the auth header (which performs the oauth2 exchange when that is
    // the configured style) and make one request to the base URL.
    const header = await authHeader(c);
    const res = await fetch(new URL('/', c.values.TELCO_BASE_URL), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: header },
      signal: AbortSignal.timeout(config.NS_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'auth_failed', detail: `Server answered ${res.status}` };
    }
    return { ok: true, detail: `Server reachable (HTTP ${res.status})` };
  } catch (err) {
    logger.warn({ err: err.message }, 'telco connection test failed');
    return { ok: false, reason: 'auth_failed', detail: err.message };
  }
}
