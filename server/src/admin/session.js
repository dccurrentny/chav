// Staff sessions. Deliberately parallel to auth/session.js rather than shared:
// a different cookie name, a different table, and a shorter life. An operator
// session is far more powerful than a customer one, so it is cheaper to make
// them re-authenticate than to widen the blast radius of a stolen cookie.
import crypto from 'node:crypto';
import { query } from '../db.js';
import { isProd } from '../config.js';

export const ADMIN_COOKIE = 'portal_admin_sid';

// Shorter than the customer TTL on purpose.
const TTL_HOURS = 4;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createStaffSession(staffId, { ip, userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfSecret = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

  await query(
    `INSERT INTO staff_sessions (token_hash, staff_id, csrf_secret, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [hashToken(token), staffId, csrfSecret, expiresAt, ip ?? null, userAgent?.slice(0, 500) ?? null],
  );
  return { token, csrfSecret };
}

export async function loadStaffSession(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT s.csrf_secret, s.expires_at,
            st.id AS staff_id, st.email, st.name, st.role, st.status
       FROM staff_sessions s
       JOIN staff st ON st.id = s.staff_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row || row.status !== 'active') return null;
  return row;
}

export async function destroyStaffSession(token) {
  if (!token) return;
  await query('DELETE FROM staff_sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function destroyAllStaffSessions(staffId) {
  await query('DELETE FROM staff_sessions WHERE staff_id = $1', [staffId]);
}

export async function purgeExpiredStaffSessions() {
  const { rowCount } = await query('DELETE FROM staff_sessions WHERE expires_at < now()');
  return rowCount;
}

export function adminCookieOptions() {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',   // stricter than the customer portal: no cross-site sends at all
    path: '/',
    maxAge: TTL_HOURS * 3600 * 1000,
  };
}

export function checkStaffCsrf(req, session) {
  const sent = req.get('x-csrf-token');
  if (!sent || !session?.csrf_secret) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(session.csrf_secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
