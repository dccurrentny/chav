import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../db.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { verifyPassword } from '../auth/password.js';
import { createStaffSession, destroyStaffSession, adminCookieOptions, ADMIN_COOKIE } from './session.js';
import { requireStaff, requireStaffCsrf } from './middleware.js';
import * as mfa from './mfa.js';
import * as audit from '../audit.js';

export const adminAuthRouter = express.Router();

// Tighter than the customer portal: fewer attempts, longer window. There are
// a handful of operators, so a legitimate user never comes near this.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many sign-in attempts. Wait 15 minutes.' },
});

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_MIN = 15;

async function isLockedOut(email) {
  const { rows } = await query(
    `SELECT count(*)::int AS failures FROM staff_login_attempts
      WHERE email = $1 AND successful = false AND at > now() - ($2 || ' minutes')::interval`,
    [email, String(LOCKOUT_WINDOW_MIN)],
  );
  return (rows[0]?.failures ?? 0) >= LOCKOUT_THRESHOLD;
}

function recordAttempt(email, ip, successful) {
  return query(
    'INSERT INTO staff_login_attempts (email, ip, successful) VALUES ($1,$2,$3)',
    [email, ip ?? null, successful],
  ).catch((err) => logger.error({ err }, 'failed to record staff login attempt'));
}

const credentials = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

adminAuthRouter.post('/login', limiter, async (req, res, next) => {
  try {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', message: 'Enter an email and password.' });
    }
    const { email, password } = parsed.data;

    if (await isLockedOut(email)) {
      return res.status(429).json({
        error: 'locked_out',
        message: `Too many failed attempts. Try again in ${LOCKOUT_WINDOW_MIN} minutes.`,
      });
    }

    const { rows } = await query(
      'SELECT id, email, name, password_hash, role, status FROM staff WHERE email = $1',
      [email],
    );
    const staff = rows[0];

    // Constant work whether or not the account exists.
    const DUMMY = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const ok = await verifyPassword(staff?.password_hash ?? DUMMY, password);

    if (!staff || !ok || staff.status !== 'active') {
      await recordAttempt(email, req.ip, false);
      await audit.record({
        actorKind: 'staff', actorEmail: email, op: 'staff.login',
        result: 'denied', error: 'invalid credentials', ip: req.ip,
      });
      return res.status(401).json({ error: 'invalid_credentials', message: 'Email or password is incorrect.' });
    }

    await recordAttempt(email, req.ip, true);

    // The password was right, which is not the same as being signed in. When a
    // second factor is enrolled, nothing is issued here but a challenge — no
    // cookie, no session row, nothing any other route would accept.
    const { enabled } = await mfa.statusFor(staff.id);
    if (enabled) {
      const challenge = await mfa.createChallenge(staff.id, req.ip);
      await audit.record({
        actorKind: 'staff', staffId: staff.id, actorEmail: staff.email,
        op: 'staff.login.password', result: 'ok', ip: req.ip,
      });
      return res.json({
        ok: false,
        mfaRequired: true,
        mfaToken: challenge.token,
        expiresInSeconds: challenge.expiresInSeconds,
      });
    }

    const { token, csrfSecret } = await createStaffSession(staff.id, {
      ip: req.ip, userAgent: req.get('user-agent'),
    });
    await query('UPDATE staff SET last_login_at = now() WHERE id = $1', [staff.id]);
    await audit.record({
      actorKind: 'staff', staffId: staff.id, actorEmail: staff.email,
      op: 'staff.login', result: 'ok', ip: req.ip,
    });

    res.cookie(ADMIN_COOKIE, token, adminCookieOptions());
    res.json({ ok: true, csrfToken: csrfSecret });
  } catch (err) {
    next(err);
  }
});

// Step two. Rate limited by the same limiter as the password step: a stolen
// password plus unlimited code guesses would defeat the whole point.
adminAuthRouter.post('/login/mfa', limiter, async (req, res, next) => {
  try {
    const parsed = z.object({
      mfaToken: z.string().min(1).max(200),
      code: z.string().max(20).optional(),
      recoveryCode: z.string().max(40).optional(),
    }).safeParse(req.body ?? {});
    if (!parsed.success || (!parsed.data.code && !parsed.data.recoveryCode)) {
      return res.status(400).json({ error: 'invalid_input', message: 'Enter the code from your authenticator app.' });
    }

    const result = await mfa.answerChallenge(parsed.data.mfaToken, parsed.data, req.ip);

    if (!result.ok) {
      await audit.record({
        actorKind: 'staff', staffId: result.staffId ?? null,
        op: 'staff.login.mfa', result: 'denied', error: result.reason, ip: req.ip,
      });
      const messages = {
        no_challenge: 'That sign-in attempt expired. Start again.',
        too_many_attempts: 'Too many incorrect codes. Sign in again.',
        not_enrolled: 'This account has no authenticator set up.',
        bad_code: 'That code is not right. Codes change every 30 seconds.',
        reused: 'That code has already been used. Wait for your app to show the next one.',
      };
      return res.status(401).json({
        error: result.reason,
        message: messages[result.reason] ?? 'That code was not accepted.',
      });
    }

    const { rows } = await query(
      'SELECT id, email, name, role, status FROM staff WHERE id = $1', [result.staffId]);
    const staff = rows[0];
    if (!staff || staff.status !== 'active') {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Email or password is incorrect.' });
    }

    const { token, csrfSecret } = await createStaffSession(staff.id, {
      ip: req.ip, userAgent: req.get('user-agent'),
    });
    await query('UPDATE staff SET last_login_at = now() WHERE id = $1', [staff.id]);
    await audit.record({
      actorKind: 'staff', staffId: staff.id, actorEmail: staff.email,
      op: 'staff.login', result: 'ok', ip: req.ip,
      target: result.usedRecoveryCode ? 'used a recovery code' : null,
    });

    res.cookie(ADMIN_COOKIE, token, adminCookieOptions());
    res.json({ ok: true, csrfToken: csrfSecret, usedRecoveryCode: !!result.usedRecoveryCode });
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------- enrolment */

adminAuthRouter.get('/2fa', requireStaff, async (req, res, next) => {
  try {
    const st = await mfa.statusFor(req.staff.staff_id);
    res.json({
      enabled: st.enabled,
      recoveryCodesLeft: st.recovery_codes_left,
      required: config.ADMIN_REQUIRE_2FA,
    });
  } catch (err) { next(err); }
});

adminAuthRouter.post('/2fa/setup', requireStaff, requireStaffCsrf, async (req, res, next) => {
  try {
    // Re-running setup on an account that already has it working would replace
    // a secret the operator is relying on. Turn it off deliberately first.
    const st = await mfa.statusFor(req.staff.staff_id);
    if (st.enabled) {
      return res.status(409).json({
        error: 'already_enabled',
        message: 'Two-factor is already on for this account. Turn it off first to set up a new app.',
      });
    }
    const { secret, uri } = await mfa.beginEnrolment(req.staff.staff_id, req.staff.email);
    res.json({ secret, uri });
  } catch (err) { next(err); }
});

adminAuthRouter.post('/2fa/confirm', requireStaff, requireStaffCsrf, async (req, res, next) => {
  try {
    const parsed = z.object({ code: z.string().min(1).max(20) }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', message: 'Enter the six-digit code.' });
    }
    const out = await mfa.confirmEnrolment(req.staff.staff_id, parsed.data.code);
    if (!out.ok) {
      return res.status(400).json({
        error: out.reason,
        message: {
          not_started: 'Start the setup again — no authenticator secret is pending.',
          reused: 'That code has already been used. Wait for the next one your app shows.',
        }[out.reason] ?? 'That code is not right. Check your phone\u2019s clock if it keeps failing.',
      });
    }
    await audit.record({
      actorKind: 'staff', staffId: req.staff.staff_id, actorEmail: req.staff.email,
      op: 'staff.2fa.enable', result: 'ok', ip: req.ip,
    });
    // The only time these exist in plaintext.
    res.json({ ok: true, recoveryCodes: out.recoveryCodes });
  } catch (err) { next(err); }
});

adminAuthRouter.post('/2fa/disable', requireStaff, requireStaffCsrf, async (req, res, next) => {
  try {
    const parsed = z.object({
      code: z.string().max(20).optional(),
      recoveryCode: z.string().max(40).optional(),
    }).safeParse(req.body ?? {});
    const st = await mfa.statusFor(req.staff.staff_id);
    if (!st.enabled) return res.json({ ok: true, enabled: false });

    // Turning off the second factor needs the second factor. A stolen session
    // cookie must not be enough to remove the thing protecting the account.
    const challenge = await mfa.createChallenge(req.staff.staff_id, req.ip);
    const result = await mfa.answerChallenge(challenge.token, parsed.data ?? {}, req.ip);
    if (!result.ok) {
      return res.status(403).json({
        error: 'bad_code',
        message: 'Enter a current code, or a recovery code, to turn two-factor off.',
      });
    }

    await mfa.disableFor(req.staff.staff_id);
    await audit.record({
      actorKind: 'staff', staffId: req.staff.staff_id, actorEmail: req.staff.email,
      op: 'staff.2fa.disable', result: 'ok', ip: req.ip,
    });
    res.json({ ok: true, enabled: false });
  } catch (err) { next(err); }
});

adminAuthRouter.post('/logout', async (req, res, next) => {
  try {
    if (req.staff) {
      await audit.record({
        actorKind: 'staff', staffId: req.staff.staff_id, actorEmail: req.staff.email,
        op: 'staff.logout', result: 'ok', ip: req.ip,
      });
    }
    await destroyStaffSession(req.staffToken);
    res.clearCookie(ADMIN_COOKIE, { ...adminCookieOptions(), maxAge: undefined });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

adminAuthRouter.get('/me', requireStaff, async (req, res, next) => {
  try {
  const st = await mfa.statusFor(req.staff.staff_id);
  res.json({
    twoFactor: {
      enabled: st.enabled,
      required: config.ADMIN_REQUIRE_2FA,
      recoveryCodesLeft: st.recovery_codes_left,
    },
    // id is needed so the console can mark "you" in the operator list and
    // refuse to offer you a disable button for your own account.
    id: req.staff.staff_id,
    email: req.staff.email,
    name: req.staff.name,
    role: req.staff.role,
    csrfToken: req.staff.csrf_secret,
  });
  } catch (err) { next(err); }
});
