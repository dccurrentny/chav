import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL   ??= 'postgres://localhost/unused';
process.env.SESSION_SECRET ??= '0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL      ??= 'fatal';

const totp = await import('../src/admin/totp.js');

// The seed from RFC 6238 Appendix B, as base32.
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));

test('matches the RFC 6238 test vectors', () => {
  // The whole point of writing TOTP by hand rather than taking a dependency is
  // that it can be checked against the published vectors. These are the SHA-1
  // rows of Appendix B, truncated to the 6 digits every authenticator uses.
  const vectors = [
    [59,          '287082'],
    [1111111109,  '081804'],
    [1111111111,  '050471'],
    [1234567890,  '005924'],
    [2000000000,  '279037'],
    // Past 2^32 seconds: catches a counter written as 32-bit.
    [20000000000, '353130'],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(totp.codeForStep(RFC_SECRET, Math.floor(seconds / 30)), expected,
      `t=${seconds}`);
  }
});

test('base32 survives a round trip', () => {
  for (const n of [1, 5, 10, 20, 32]) {
    const buf = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255));
    assert.deepEqual(totp.base32Decode(totp.base32Encode(buf)), buf, `${n} bytes`);
  }
  // Authenticator apps show the secret uppercase and unpadded; accept what a
  // person might paste back.
  assert.deepEqual(totp.base32Decode('gezdgnbv'), totp.base32Decode('GEZDGNBV'));
});

test('a generated secret is 160 bits, as RFC 4226 asks', () => {
  assert.equal(totp.base32Decode(totp.generateSecret()).length, 20);
  assert.notEqual(totp.generateSecret(), totp.generateSecret());
});

test('accepts one step of clock drift either side, and no more', () => {
  const now = 1_700_000_000_000;
  const step = totp.currentStep(now);
  for (const delta of [-1, 0, 1]) {
    assert.deepEqual(totp.verifyCode(RFC_SECRET, totp.codeForStep(RFC_SECRET, step + delta), { now }),
      { ok: true, step: step + delta }, `delta ${delta}`);
  }
  for (const delta of [-2, 2]) {
    assert.equal(totp.verifyCode(RFC_SECRET, totp.codeForStep(RFC_SECRET, step + delta), { now }).ok,
      false, `delta ${delta} should be refused`);
  }
});

test('a code cannot be used twice', () => {
  // Someone reading a code over a shoulder has 30 seconds to use it. Recording
  // the step it matched is what closes that window.
  const now = 1_700_000_000_000;
  const step = totp.currentStep(now);
  const code = totp.codeForStep(RFC_SECRET, step);

  assert.deepEqual(totp.verifyCode(RFC_SECRET, code, { now }), { ok: true, step });
  assert.equal(totp.verifyCode(RFC_SECRET, code, { now, afterStep: step }).ok, false);
  // And the step before it is spent too, not just the exact one.
  assert.equal(totp.verifyCode(RFC_SECRET, totp.codeForStep(RFC_SECRET, step - 1),
    { now, afterStep: step }).ok, false);
  // The next one still works, or enrolling would lock you out for a window.
  assert.deepEqual(totp.verifyCode(RFC_SECRET, totp.codeForStep(RFC_SECRET, step + 1),
    { now, afterStep: step }), { ok: true, step: step + 1 });
});

test('a spent code is reported as reused, not as wrong', () => {
  // Right after enrolling, the code that confirmed the setup is already spent.
  // Telling someone who typed exactly what their app showed that they got it
  // wrong sends them hunting for a fault that is not there.
  const now = 1_700_000_000_000;
  const step = totp.currentStep(now);

  assert.deepEqual(totp.verifyCode(RFC_SECRET, totp.codeForStep(RFC_SECRET, step),
    { now, afterStep: step }), { ok: false, reason: 'reused' });
  assert.deepEqual(totp.verifyCode(RFC_SECRET, '000000', { now, afterStep: step }),
    { ok: false, reason: 'bad_code' });
});

test('rubbish input is refused rather than throwing', () => {
  const now = Date.now();
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, '  ', '12 34 56']) {
    assert.equal(totp.verifyCode(RFC_SECRET, bad, { now }).ok, false, JSON.stringify(bad));
  }
  // Spaces inside an otherwise good code are fine — people paste them.
  const step = totp.currentStep(now);
  const code = totp.codeForStep(RFC_SECRET, step);
  assert.deepEqual(totp.verifyCode(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { now }),
    { ok: true, step });
});

test('the otpauth URI carries what an authenticator app needs', () => {
  const uri = totp.otpauthUri({ secret: RFC_SECRET, email: 'aron@dccurrentny.com' });
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'otpauth:');
  assert.equal(parsed.searchParams.get('secret'), RFC_SECRET);
  assert.equal(parsed.searchParams.get('digits'), '6');
  assert.equal(parsed.searchParams.get('period'), '30');
  assert.equal(parsed.searchParams.get('algorithm'), 'SHA1');
  // The label has to name the system, or an operator with several codes in one
  // app cannot tell which is which.
  assert.match(decodeURIComponent(uri), /DC Current portal:aron@dccurrentny\.com/);
});

test('recovery codes are distinct, and compare ignoring formatting', () => {
  const codes = totp.generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);

  // They get written on paper and typed back in. Case and dashes must not
  // decide whether someone gets back into their account.
  const one = codes[0];
  assert.equal(totp.hashRecoveryCode(one), totp.hashRecoveryCode(one.toLowerCase()));
  assert.equal(totp.hashRecoveryCode(one), totp.hashRecoveryCode(one.replace(/-/g, '')));
  assert.equal(totp.hashRecoveryCode(one), totp.hashRecoveryCode(` ${one} `));
  assert.notEqual(totp.hashRecoveryCode(one), totp.hashRecoveryCode(codes[1]));
});
