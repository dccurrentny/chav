import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../db.js';
import { logger } from '../logger.js';
import { verifyPassword } from './password.js';
import { createSession, destroySession, cookieOptions, COOKIE_NAME } from './session.js';
import { requireAuth } from './middleware.js';

export const authRouter = express.Router();

// Per-IP ceiling. The per-account lockout below is the one that stops a
// targeted attack; this one stops a single host spraying many accounts.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many sign-in attempts. Wait 15 minutes.' },
});

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_MIN = 15;

async function isLockedOut(email) {
  const { rows } = await query(
    `SELECT count(*)::int AS failures
       FROM login_attempts
      WHERE email = $1
        AND successful = false
        AND at > now() - ($2 || ' minutes')::interval`,
    [email, String(LOCKOUT_WINDOW_MIN)],
  );
  return (rows[0]?.failures ?? 0) >= LOCKOUT_THRESHOLD;
}

function recordAttempt(email, ip, successful) {
  return query(
    'INSERT INTO login_attempts (email, ip, successful) VALUES ($1,$2,$3)',
    [email, ip ?? null, successful],
  ).catch((err) => logger.error({ err }, 'failed to record login attempt'));
}

const credentials = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', message: 'Enter an email and password.' });
    }
    const { email, password } = parsed.data;
    const ip = req.ip;

    if (await isLockedOut(email)) {
      return res.status(429).json({
        error: 'locked_out',
        message: `Too many failed attempts. Try again in ${LOCKOUT_WINDOW_MIN} minutes.`,
      });
    }

    const { rows } = await query(
      `SELECT u.id, u.email, u.password_hash, u.status, t.status AS tenant_status
         FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE u.email = $1`,
      [email],
    );
    const user = rows[0];

    // Always run a verify, even with no such user, so response time does not
    // reveal whether the address exists.
    const DUMMY = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const ok = await verifyPassword(user?.password_hash ?? DUMMY, password);

    if (!user || !ok || user.status !== 'active' || user.tenant_status !== 'active') {
      await recordAttempt(email, ip, false);
      return res.status(401).json({ error: 'invalid_credentials', message: 'Email or password is incorrect.' });
    }

    await recordAttempt(email, ip, true);
    const { token, csrfSecret } = await createSession(user.id, { ip, userAgent: req.get('user-agent') });
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

    res.cookie(COOKIE_NAME, token, cookieOptions());
    res.json({ ok: true, csrfToken: csrfSecret });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    await destroySession(req.sessionToken);
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// The SPA calls this on boot to learn who it is and to pick up the CSRF token.
authRouter.get('/me', requireAuth, (req, res) => {
  res.json({
    email: req.session.email,
    role: req.session.role,
    tenant: { name: req.session.tenant_name, domain: req.session.ns_domain },
    csrfToken: req.session.csrf_secret,
  });
});
