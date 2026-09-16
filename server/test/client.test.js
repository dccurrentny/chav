import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// config.js validates the environment at import time, so populate it first.
process.env.DATABASE_URL   ??= 'postgres://localhost/unused';
process.env.SESSION_SECRET ??= '0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.NS_BASE_URL    ??= 'https://ns.example.test';
process.env.NS_CLIENT_ID   ??= 'x';
process.env.NS_CLIENT_SECRET ??= 'x';
process.env.NS_USERNAME    ??= 'x';
process.env.NS_PASSWORD    ??= 'x';
process.env.LOG_LEVEL      ??= 'fatal';

const { nsRequest, NsError, _resetTokenCache } = await import('../src/netsapiens/client.js');

const realFetch = globalThis.fetch;
beforeEach(() => _resetTokenCache());
afterEach(() => { globalThis.fetch = realFetch; });

// Regression: a transport failure while fetching the OAuth token used to escape
// as a raw TypeError. routes.js only recognises NsError, so the customer got
// "something went wrong on our side" and NO audit row was written for what was
// actually a SkySwitch outage.
test('token-endpoint transport failure surfaces as a retryable NsError', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };

  await assert.rejects(
    () => nsRequest('answerrule', 'read', { extension: '2001' }),
    (err) => {
      assert.ok(err instanceof NsError, `expected NsError, got ${err.constructor.name}`);
      assert.equal(err.retryable, true);
      assert.match(err.message, /token endpoint unreachable/);
      return true;
    },
  );
});

test('token-endpoint timeout surfaces as a retryable NsError', async () => {
  globalThis.fetch = async () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    throw err;
  };

  await assert.rejects(
    () => nsRequest('answerrule', 'read', { extension: '2001' }),
    (err) => err instanceof NsError && err.retryable === true && /timed out/.test(err.message),
  );
});

test('an API transport failure after a good token is also an NsError', async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new TypeError('fetch failed');
  };

  await assert.rejects(
    () => nsRequest('answerrule', 'read', { extension: '2001' }),
    (err) => err instanceof NsError && err.retryable === true && /API unreachable/.test(err.message),
  );
});

test('a non-2xx from the API is a non-retryable NsError with the status', async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('bad request', { status: 400 });
  };

  await assert.rejects(
    () => nsRequest('answerrule', 'update', { extension: '2001' }),
    (err) => err instanceof NsError && err.status === 400 && !err.retryable,
  );
});

test('a 5xx from the API is marked retryable', async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('upstream boom', { status: 502 });
  };

  await assert.rejects(
    () => nsRequest('answerrule', 'read', { extension: '2001' }),
    (err) => err instanceof NsError && err.retryable === true,
  );
});

// Regression: an MFA challenge response CARRIES an access_token. The original
// check was `if (!json.access_token) throw`, so the intermediate token was
// accepted as a working one and every later call failed with a 401 for no
// visible reason. Documented at pbx.readme.io/reference/getting-started.
test('an MFA challenge is rejected, not mistaken for a working token', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    mfa: 'mfa_required',
    mfa_vendor: 'google',
    mfa_type: 'authenticator',
    access_token: '51fdab21ca330f6b0c88b2a98ex8932s',
    expires_in: 3600,
    token_type: 'Bearer',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  await assert.rejects(
    () => nsRequest('answerrule', 'read', { extension: '2001' }),
    (err) => {
      assert.ok(err instanceof NsError);
      assert.equal(err.mfaRequired, true);
      assert.equal(err.retryable, false);
      assert.match(err.message, /multi-factor/i);
      return true;
    },
  );
});

// The password grant is a form POST; the refresh grant is a GET carrying its
// parameters in the query string. Sending one as the other fails.
test('the refresh grant is sent as a GET with query parameters', async () => {
  const seen = [];
  let call = 0;
  globalThis.fetch = async (url, opts) => {
    call += 1;
    seen.push({ url: String(url), method: opts?.method });
    if (call === 1) {
      // Password grant: hand back a token that is already due for refresh.
      return new Response(JSON.stringify({
        access_token: 'first', refresh_token: 'refresh-me', expires_in: 1,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (call === 2) {
      return new Response(JSON.stringify({
        access_token: 'second', refresh_token: 'refresh-me', expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  await nsRequest('answerrule', 'read', { extension: '2001' }).catch(() => {});
  // expires_in of 1s is inside the refresh skew, so the next call refreshes.
  await nsRequest('answerrule', 'read', { extension: '2001' }).catch(() => {});

  const refresh = seen.find((r) => r.url.includes('grant_type=refresh_token'));
  assert.ok(refresh, 'no refresh request was made');
  assert.equal(refresh.method, 'GET', 'refresh grant was not sent as a GET');
  assert.match(refresh.url, /client_id=/);
  assert.match(refresh.url, /refresh_token=refresh-me/);
});

test('the token endpoint is the documented path', async () => {
  // The FIRST request is the token exchange; the second is the API call. The
  // original assertion captured the last URL and so tested the wrong one.
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await nsRequest('answerrule', 'read', { extension: '2001' }).catch(() => {});
  assert.match(urls[0], /\/ns-api\/oauth2\/token\/$/);
});
