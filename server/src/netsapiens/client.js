// NetSapiens API client.
//
// Holds the reseller credentials and the OAuth2 token for the whole process.
// Nothing here is per-viewer: the browser never sees a NetSapiens token, and
// the token is refreshed centrally rather than once per customer session.
import { config } from '../config.js';
import { getNsSettingsForTenant } from '../settings.js';
import crypto from 'node:crypto';
import { logger } from '../logger.js';

const NS_API_PATH = '/ns-api/';

export class NsError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'NsError';
    Object.assign(this, extra);
  }
}

// One cached token PER CREDENTIAL SET. A single shared token was fine while
// every tenant used the same credentials; now that a customer can have its
// own, caching one token globally would hand one customer another's token.
const tokens = new Map();     // credential fingerprint -> { accessToken, ... }
const inFlight = new Map();   // credential fingerprint -> Promise

// Refresh this far before actual expiry so a request never races the clock.
const EXPIRY_SKEW_MS = 60_000;

function tokenUrl(baseUrl) {
  return new URL('/ns-api/oauth2/token/', baseUrl).toString();
}

function inspectUrl(baseUrl) {
  return new URL('/ns-api/oauth2/read?format=json', baseUrl).toString();
}

// Resolved per call rather than read once at startup, so credentials saved in
// the console take effect without restarting the service, and so a customer
// with its own credentials gets those.
async function nsCreds(tenantId) {
  const s = await getNsSettingsForTenant(tenantId);
  const values = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.value]));
  const missing = Object.entries(values).filter(([, v]) => !v).map(([k]) => k);

  // Identifies the credential set without holding its secrets in a Map key.
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify([values.NS_BASE_URL, values.NS_CLIENT_ID, values.NS_USERNAME]))
    .digest('hex');

  return {
    values,
    missing,
    configured: missing.length === 0,
    fingerprint,
    source: Object.values(s)[0]?.source ?? null,
  };
}

// Every transport failure in this module becomes an NsError. Leaking a raw
// fetch error makes routes.js report a portal fault and skip the audit row
// when the real cause is a SkySwitch outage.
function transportError(err, what) {
  return new NsError(
    err.name === 'TimeoutError'
      ? `SkySwitch ${what} timed out`
      : `SkySwitch ${what} unreachable: ${err.message}`,
    { retryable: true },
  );
}

async function requestToken(params, baseUrl, { method = 'POST' } = {}) {
  let res;
  try {
    if (method === 'GET') {
      // The refresh grant is documented as a GET carrying its parameters in
      // the query string, not as a form POST like the password grant.
      const url = new URL(tokenUrl(baseUrl));
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(config.NS_TIMEOUT_MS),
      });
    } else {
      res = await fetch(tokenUrl(baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(config.NS_TIMEOUT_MS),
      });
    }
  } catch (err) {
    throw transportError(err, 'token endpoint');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new NsError(`token request failed (${res.status})`, {
      status: res.status,
      // Never log the body wholesale — it can echo credentials.
      detail: text.slice(0, 200),
      retryable: res.status >= 500,
    });
  }

  const json = await res.json().catch(() => null);

  // Checked before access_token, because an MFA challenge carries one: it is an
  // intermediate token that only completes the mfa grant. Accepting it would
  // look like success and then fail every subsequent call with a 401.
  if (json?.mfa === 'mfa_required') {
    throw new NsError(
      'That SkySwitch subscriber has multi-factor authentication enabled. ' +
      'A server cannot answer an MFA prompt — use a dedicated API subscriber without MFA.',
      { notConfigured: true, retryable: false, mfaRequired: true },
    );
  }

  if (!json?.access_token) throw new NsError('token response had no access_token');

  // NetSapiens reports expires_in in seconds; default to 1h when absent.
  const ttlMs = (Number(json.expires_in) || 3600) * 1000;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Date.now() + ttlMs,
    // The token states what it can reach. Kept so a request can be checked
    // against it before it is sent.
    scope: json.scope ?? null,
    domain: json.domain ?? null,
  };
}

async function refreshToken(creds) {
  const v = creds.values;
  const cached = tokens.get(creds.fingerprint);
  // Prefer the refresh grant; fall back to password when it is gone or stale.
  if (cached?.refreshToken) {
    try {
      return await requestToken({
        grant_type: 'refresh_token',
        client_id: v.NS_CLIENT_ID,
        client_secret: v.NS_CLIENT_SECRET,
        refresh_token: cached.refreshToken,
      }, v.NS_BASE_URL, { method: 'GET' });
    } catch (err) {
      logger.warn({ err: err.message }, 'refresh grant failed, falling back to password grant');
    }
  }
  return requestToken({
    grant_type: 'password',
    client_id: v.NS_CLIENT_ID,
    client_secret: v.NS_CLIENT_SECRET,
    username: v.NS_USERNAME,
    password: v.NS_PASSWORD,
  }, v.NS_BASE_URL);
}

async function getToken(creds) {
  if (!creds.configured) {
    // Distinct from an outage: nothing is wrong with SkySwitch, this server has
    // simply never been given credentials. Not retryable — retrying cannot help.
    throw new NsError('SkySwitch is not connected on this server', {
      notConfigured: true,
      missing: creds.missing,
      retryable: false,
    });
  }

  const fp = creds.fingerprint;
  const cached = tokens.get(fp);
  if (cached && Date.now() < cached.expiresAt - EXPIRY_SKEW_MS) return cached;

  // Single-flight per credential set: concurrent callers await one refresh.
  if (!inFlight.has(fp)) {
    inFlight.set(fp, refreshToken(creds)
      .then((tok) => { tokens.set(fp, tok); return tok; })
      .finally(() => { inFlight.delete(fp); }));
  }
  return inFlight.get(fp);
}

/**
 * Call the NetSapiens single-endpoint API.
 *
 * `params.domain` is set by the caller in routes.js from the session's tenant
 * and is never accepted from the client — see netsapiens/routes.js.
 */
export async function nsRequest(object, action, params = {}, { retryOn401 = true, tenantId = null } = {}) {
  const started = Date.now();

  const creds = await nsCreds(tenantId);
  // getToken can itself fail on a SkySwitch outage; requestToken already
  // converts that to an NsError, so callers see one error type either way.
  const tok = await getToken(creds);
  const token = tok.accessToken;

  // A token below Reseller scope reaches exactly one domain. If the request is
  // for a different one SkySwitch would refuse it, but refusing here says why,
  // and means a misconfiguration cannot quietly send one customer's request
  // under another customer's credentials.
  if (params.domain && tok.domain && tok.scope !== 'Reseller' &&
      String(tok.domain).toLowerCase() !== String(params.domain).toLowerCase()) {
    throw new NsError(
      `These SkySwitch credentials are scoped to ${tok.domain} (${tok.scope}) ` +
      `and cannot act on ${params.domain}. Give this customer its own credentials, ` +
      'or use a Reseller-scope subscriber for the shared ones.',
      { notConfigured: true, retryable: false, scopeMismatch: true },
    );
  }

  const url = new URL(NS_API_PATH, creds.values.NS_BASE_URL);
  url.searchParams.set('object', object);
  url.searchParams.set('action', action);
  url.searchParams.set('format', 'json');

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) body.set(k, String(v));
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(config.NS_TIMEOUT_MS),
    });
  } catch (err) {
    const e = transportError(err, 'API');
    e.durationMs = Date.now() - started;
    throw e;
  }

  // A token can be revoked server-side before its stated expiry. Drop the
  // cache and try exactly once more.
  if (res.status === 401 && retryOn401) {
    tokens.delete(creds.fingerprint);
    return nsRequest(object, action, params, { retryOn401: false, tenantId });
  }

  const durationMs = Date.now() - started;
  const text = await res.text();

  if (!res.ok) {
    throw new NsError(`SkySwitch API returned ${res.status}`, {
      status: res.status,
      detail: text.slice(0, 500),
      retryable: res.status >= 500 || res.status === 429,
      durationMs,
    });
  }

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Some NetSapiens actions answer with a bare string on success.
    data = { raw: text };
  }
  return { data, durationMs };
}

/**
 * Try the stored credentials and report whether they work.
 *
 * Used by the console's "Test connection" button. Drops the cached token first
 * so it tests what is configured now, not what happened to work earlier.
 */
export async function testConnection(tenantId = null) {
  _resetTokenCache();
  const creds = await nsCreds(tenantId);
  if (!creds.configured) {
    return { ok: false, reason: 'not_configured', missing: creds.missing };
  }
  try {
    const { accessToken: token } = await getToken(creds);

    // Ask SkySwitch what this token can reach. Far more useful than "it
    // worked": the scope is what decides the blast radius of these credentials.
    let info = null;
    try {
      const res = await fetch(inspectUrl(creds.values.NS_BASE_URL), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(config.NS_TIMEOUT_MS),
      });
      if (res.ok) info = await res.json().catch(() => null);
    } catch {
      // Inspection is a bonus; a token we already hold means the credentials work.
    }

    return {
      ok: true,
      scope: info?.scope ?? null,
      domain: info?.domain ?? null,
      territory: info?.territory ?? null,
      detail: info?.scope
        ? `Signed in as ${info.uid ?? 'the API subscriber'} with ${info.scope} scope.`
        : 'SkySwitch accepted these credentials.',
    };
  } catch (err) {
    return {
      ok: false,
      reason: err.notConfigured ? 'not_configured' : 'auth_failed',
      // Safe to surface: this is our own upstream, and the text helps an
      // operator tell a wrong password from an unreachable host.
      detail: err.message,
    };
  }
}

// Exposed for tests and for operational reset.
export function _resetTokenCache() {
  tokens.clear();
  inFlight.clear();
}
