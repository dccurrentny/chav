// NetSapiens API client.
//
// Holds the reseller credentials and the OAuth2 token for the whole process.
// Nothing here is per-viewer: the browser never sees a NetSapiens token, and
// the token is refreshed centrally rather than once per customer session.
import { config, NS_CONFIGURED, missingNsSettings } from '../config.js';
import { logger } from '../logger.js';

const NS_API_PATH = '/ns-api/';

export class NsError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'NsError';
    Object.assign(this, extra);
  }
}

// Single cached token for the process, plus the in-flight promise so a burst
// of concurrent requests triggers one refresh rather than N.
let cached = null;        // { accessToken, refreshToken, expiresAt }
let inFlight = null;

// Refresh this far before actual expiry so a request never races the clock.
const EXPIRY_SKEW_MS = 60_000;

function tokenUrl() {
  return new URL('/ns-api/oauth2/token/?format=json', config.NS_BASE_URL).toString();
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

async function requestToken(body) {
  let res;
  try {
    res = await fetch(tokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(config.NS_TIMEOUT_MS),
    });
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
  if (!json?.access_token) throw new NsError('token response had no access_token');

  // NetSapiens reports expires_in in seconds; default to 1h when absent.
  const ttlMs = (Number(json.expires_in) || 3600) * 1000;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Date.now() + ttlMs,
  };
}

async function refreshToken() {
  // Prefer the refresh grant; fall back to password when it is gone or stale.
  if (cached?.refreshToken) {
    try {
      return await requestToken({
        grant_type: 'refresh_token',
        client_id: config.NS_CLIENT_ID,
        client_secret: config.NS_CLIENT_SECRET,
        refresh_token: cached.refreshToken,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'refresh grant failed, falling back to password grant');
    }
  }
  return requestToken({
    grant_type: 'password',
    client_id: config.NS_CLIENT_ID,
    client_secret: config.NS_CLIENT_SECRET,
    username: config.NS_USERNAME,
    password: config.NS_PASSWORD,
  });
}

async function getToken() {
  if (!NS_CONFIGURED) {
    // Distinct from an outage: nothing is wrong with SkySwitch, this server has
    // simply never been given credentials. Not retryable — retrying cannot help.
    throw new NsError('SkySwitch is not connected on this server', {
      notConfigured: true,
      missing: missingNsSettings,
      retryable: false,
    });
  }
  if (cached && Date.now() < cached.expiresAt - EXPIRY_SKEW_MS) {
    return cached.accessToken;
  }
  // Single-flight: concurrent callers await the same refresh.
  inFlight ??= refreshToken()
    .then((tok) => {
      cached = tok;
      return tok.accessToken;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Call the NetSapiens single-endpoint API.
 *
 * `params.domain` is set by the caller in routes.js from the session's tenant
 * and is never accepted from the client — see netsapiens/routes.js.
 */
export async function nsRequest(object, action, params = {}, { retryOn401 = true } = {}) {
  const started = Date.now();

  // getToken can itself fail on a SkySwitch outage; requestToken already
  // converts that to an NsError, so callers see one error type either way.
  const token = await getToken();

  const url = new URL(NS_API_PATH, config.NS_BASE_URL);
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
    cached = null;
    return nsRequest(object, action, params, { retryOn401: false });
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

// Exposed for tests and for operational reset.
export function _resetTokenCache() {
  cached = null;
  inFlight = null;
}
