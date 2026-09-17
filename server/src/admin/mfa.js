// Storage and state for the staff second factor.
//
// Kept apart from totp.js, which is pure algorithm and has no database in it,
// so the maths can be tested against the RFC vectors on its own.
import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as totp from './totp.js';

// A challenge only has to survive someone reading a code off their phone.
const CHALLENGE_TTL_MINUTES = 5;

// Six digits is a million guesses; at five tries per challenge and a new
// password needed for each challenge, brute force is not the way in.
export const MAX_MFA_ATTEMPTS = 5;

// Same derivation as app_settings, different info string, so the two cannot
// decrypt each other's values even though both come from SESSION_SECRET.
const KEY = crypto.hkdfSync(
  'sha256',
  Buffer.from(config.SESSION_SECRET, 'utf8'),
  Buffer.from('portal-settings-v1-salt'),
  Buffer.from('staff totp secret encryption'),
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

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/* ------------------------------------------------------------ enrolment */

/** Start enrolment. Stores an unconfirmed secret and returns it once. */
export async function beginEnrolment(staffId, email) {
  const secret = totp.generateSecret();
  await query(
    'UPDATE staff SET totp_secret_enc = $2, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = $1',
    [staffId, encrypt(secret)],
  );
  return { secret, uri: totp.otpauthUri({ secret, email }) };
}

/**
 * Finish enrolment: the code proves the app actually holds the secret.
 *
 * Recovery codes are issued here and nowhere else, so there is exactly one
 * moment they exist in plaintext and it is the moment they are shown.
 */
export async function confirmEnrolment(staffId, code) {
  const secret = await secretFor(staffId);
  if (!secret) return { ok: false, reason: 'not_started' };

  const check = totp.verifyCode(secret, code);
  if (!check.ok) return { ok: false, reason: check.reason };
  const step = check.step;

  const codes = totp.generateRecoveryCodes();
  await withTransaction(async (client) => {
    await client.query(
      'UPDATE staff SET totp_confirmed_at = now(), totp_last_step = $2 WHERE id = $1',
      [staffId, step]);
    await client.query('DELETE FROM staff_recovery_codes WHERE staff_id = $1', [staffId]);
    for (const c of codes) {
      await client.query(
        'INSERT INTO staff_recovery_codes (staff_id, code_hash) VALUES ($1,$2)',
        [staffId, totp.hashRecoveryCode(c)]);
    }
  });
  return { ok: true, recoveryCodes: codes };
}

export async function disableFor(staffId) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE staff SET totp_secret_enc = NULL, totp_confirmed_at = NULL, totp_last_step = NULL
        WHERE id = $1`, [staffId]);
    await client.query('DELETE FROM staff_recovery_codes WHERE staff_id = $1', [staffId]);
  });
}

async function secretFor(staffId) {
  const { rows } = await query('SELECT totp_secret_enc FROM staff WHERE id = $1', [staffId]);
  const enc = rows[0]?.totp_secret_enc;
  if (!enc) return null;
  try {
    return decrypt(enc);
  } catch {
    // SESSION_SECRET was rotated. Say so rather than reporting a wrong code:
    // the operator needs to re-enrol, and a "bad code" message would send them
    // hunting for the wrong fault.
    logger.error({ staffId }, 'could not decrypt a staff TOTP secret');
    throw new Error('undecryptable_secret');
  }
}

export async function statusFor(staffId) {
  const { rows } = await query(
    `SELECT totp_confirmed_at IS NOT NULL AS enabled,
            totp_secret_enc IS NOT NULL   AS started,
            (SELECT count(*)::int FROM staff_recovery_codes
              WHERE staff_id = $1 AND used_at IS NULL) AS recovery_codes_left
       FROM staff WHERE id = $1`, [staffId]);
  return rows[0] ?? { enabled: false, started: false, recovery_codes_left: 0 };
}

/* ----------------------------------------------------------- challenges */

export async function createChallenge(staffId, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO staff_mfa_challenges (token_hash, staff_id, expires_at, ip)
     VALUES ($1,$2, now() + ($3 || ' minutes')::interval, $4)`,
    [hashToken(token), staffId, String(CHALLENGE_TTL_MINUTES), ip ?? null]);
  return { token, expiresInSeconds: CHALLENGE_TTL_MINUTES * 60 };
}

/**
 * Spend a challenge against a code or a recovery code.
 *
 * Every failure path deletes or counts against the challenge, so a stolen
 * password cannot be paired with unlimited guesses.
 */
export async function answerChallenge(token, { code, recoveryCode }, ip) {
  if (!token) return { ok: false, reason: 'no_challenge' };

  // Count the attempt before checking it. Crashing mid-verify must not hand
  // back a free guess.
  const { rows } = await query(
    `UPDATE staff_mfa_challenges
        SET attempts = attempts + 1
      WHERE token_hash = $1 AND expires_at > now()
      RETURNING staff_id, attempts`,
    [hashToken(token)]);
  const challenge = rows[0];
  if (!challenge) return { ok: false, reason: 'no_challenge' };

  if (challenge.attempts > MAX_MFA_ATTEMPTS) {
    await query('DELETE FROM staff_mfa_challenges WHERE token_hash = $1', [hashToken(token)]);
    return { ok: false, reason: 'too_many_attempts', staffId: challenge.staff_id };
  }

  const staffId = challenge.staff_id;

  if (recoveryCode) {
    // Single-use, enforced by the UPDATE matching only an unused row.
    const { rowCount } = await query(
      `UPDATE staff_recovery_codes SET used_at = now()
        WHERE staff_id = $1 AND code_hash = $2 AND used_at IS NULL`,
      [staffId, totp.hashRecoveryCode(recoveryCode)]);
    if (!rowCount) return { ok: false, reason: 'bad_code', staffId };

    await query('DELETE FROM staff_mfa_challenges WHERE token_hash = $1', [hashToken(token)]);
    return { ok: true, staffId, usedRecoveryCode: true };
  }

  const secret = await secretFor(staffId);
  if (!secret) return { ok: false, reason: 'not_enrolled', staffId };

  const { rows: last } = await query('SELECT totp_last_step FROM staff WHERE id = $1', [staffId]);
  const stored = last[0]?.totp_last_step;
  const check = totp.verifyCode(secret, code, {
    afterStep: stored === null || stored === undefined ? null : Number(stored),
  });
  if (!check.ok) return { ok: false, reason: check.reason, staffId };

  await query('UPDATE staff SET totp_last_step = $2 WHERE id = $1', [staffId, check.step]);
  await query('DELETE FROM staff_mfa_challenges WHERE token_hash = $1', [hashToken(token)]);
  return { ok: true, staffId };
}

export async function purgeExpiredChallenges() {
  const { rowCount } = await query('DELETE FROM staff_mfa_challenges WHERE expires_at < now()');
  return rowCount;
}
