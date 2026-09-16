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
