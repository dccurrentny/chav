// Time-based one-time passwords for the staff console (RFC 6238).
//
// Built on node:crypto rather than a dependency. TOTP is an HMAC, a counter
// and a truncation; the whole algorithm is below and is small enough to read,
// which matters more here than in most places — this is the second factor on
// an account that can reach every customer.
//
// Fixed at the parameters every authenticator app assumes: SHA-1, 6 digits,
// a 30-second step. SHA-1 is not a weakness here: TOTP's security comes from
// the shared secret and the 30-second window, not from collision resistance,
// and an app that cannot be enrolled is worse than one using HMAC-SHA1.
import crypto from 'node:crypto';

export const DIGITS = 6;
export const PERIOD_SECONDS = 30;

// One step either side of now. Covers ordinary clock drift between a phone and
// the server without widening the guessing window more than it has to.
export const SKEW_STEPS = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648, no padding) — what authenticator apps expect. */
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error('not valid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh secret. 20 bytes is the RFC 4226 recommendation for HMAC-SHA1. */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** The code for one 30-second step. */
export function codeForStep(secretBase32, step) {
  const counter = Buffer.alloc(8);
  // The counter is 64-bit; writing the low 32 bits leaves the high word zero,
  // which is correct until the year 5000-odd.
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const hmac = crypto.createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();

  // Dynamic truncation, RFC 4226 section 5.3.
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / PERIOD_SECONDS);
}

/**
 * Check a code.
 *
 * Returns `{ ok: true, step }`, or `{ ok: false, reason }`. The STEP comes back
 * because the caller has to record it: without storing the last accepted step,
 * a code stays valid for its whole window and anyone who reads it over a
 * shoulder can reuse it.
 *
 * `afterStep` is that stored value. A code matching a step at or before it is
 * reported as 'reused' rather than 'bad_code' — the difference matters to the
 * person typing, who has entered exactly what their app showed them and needs
 * to be told to wait for the next one, not that they got it wrong.
 */
export function verifyCode(secretBase32, code, { now = Date.now(), afterStep = null } = {}) {
  const cleaned = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { ok: false, reason: 'bad_code' };

  const here = currentStep(now);
  let reused = false;

  for (let delta = -SKEW_STEPS; delta <= SKEW_STEPS; delta++) {
    const step = here + delta;
    // Constant-time: both sides are fixed-length digit strings.
    const expected = Buffer.from(codeForStep(secretBase32, step));
    const got = Buffer.from(cleaned);
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) continue;

    if (afterStep !== null && step <= afterStep) { reused = true; continue; }
    return { ok: true, step };
  }
  return { ok: false, reason: reused ? 'reused' : 'bad_code' };
}

/**
 * The otpauth:// URI an authenticator app reads from a QR code.
 *
 * The issuer appears as the account's name in the app, so it has to say which
 * system this is — an operator with several codes needs to tell them apart.
 */
export function otpauthUri({ secret, email, issuer = 'DC Current portal' }) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

/* ------------------------------------------------------- recovery codes */

// Ten codes, each 80 bits of entropy, shown once. Formatted in groups because
// they get written down and typed back in by someone who has lost their phone.
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT) {
  return Array.from({ length: n }, () => {
    const raw = base32Encode(crypto.randomBytes(10)).slice(0, 16);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  });
}

// Hashed, not encrypted, and with SHA-256 rather than argon2: these are 80-bit
// random strings, not chosen passwords, so there is nothing for a slow hash to
// defend against and a fast one keeps the login path fast.
export function hashRecoveryCode(code) {
  return crypto.createHash('sha256')
    .update(String(code).replace(/[\s-]/g, '').toUpperCase())
    .digest('hex');
}
