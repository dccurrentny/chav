import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../db.js';
import { logger } from '../logger.js';
import { verifyPassword } from '../auth/password.js';
import { createStaffSession, destroyStaffSession, adminCookieOptions, ADMIN_COOKIE } from './session.js';
import { requireStaff } from './middleware.js';
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

adminAuthRouter.get('/me', requireStaff, (req, res) => {
  res.json({
    // id is needed so the console can mark "you" in the operator list and
    // refuse to offer you a disable button for your own account.
    id: req.staff.staff_id,
    email: req.staff.email,
    name: req.staff.name,
    role: req.staff.role,
    csrfToken: req.staff.csrf_secret,
  });
});
