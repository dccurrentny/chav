import crypto from 'node:crypto';
import { query } from '../db.js';
import { config, isProd } from '../config.js';

export const COOKIE_NAME = 'portal_sid';
const CSRF_HEADER = 'x-csrf-token';

// The cookie carries a random token; the database stores only its SHA-256.
// A dump of `sessions` therefore yields no usable session.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId, { ip, userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfSecret = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600 * 1000);

  await query(
    `INSERT INTO sessions (token_hash, user_id, csrf_secret, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [hashToken(token), userId, csrfSecret, expiresAt, ip ?? null, userAgent?.slice(0, 500) ?? null],
  );
  return { token, csrfSecret, expiresAt };
}

export async function loadSession(token) {
  if (!token) return null;
  const { rows } = await query(
    // A preview session has no user: it names the tenant directly, so the
    // tenant is joined through whichever of the two is set.
    `SELECT s.token_hash, s.csrf_secret, s.expires_at, s.impersonated_by,
            s.preview_tenant_id,
            u.id AS user_id, u.email, u.role, u.status AS user_status,
            t.id AS tenant_id, t.ns_domain, t.name AS tenant_name, t.status AS tenant_status,
            t.main_extension,
            st.email AS staff_email
       FROM sessions s
       LEFT JOIN users   u  ON u.id = s.user_id
       JOIN      tenants t  ON t.id = COALESCE(u.tenant_id, s.preview_tenant_id)
       LEFT JOIN staff   st ON st.id = s.impersonated_by
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  // A user disabled or a tenant suspended mid-session loses access at once.
  // A preview session has no user, so only the tenant applies.
  if (row.tenant_status !== 'active') return null;
  if (row.user_id && row.user_status !== 'active') return null;
  return row;
}

export async function destroySession(token) {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function destroyAllForUser(userId) {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export async function purgeExpired() {
  const { rowCount } = await query('DELETE FROM sessions WHERE expires_at < now()');
  return rowCount;
}

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: config.SESSION_TTL_HOURS * 3600 * 1000,
  };
}

// Double-submit CSRF: the secret lives in the session row and is echoed to the
// SPA via /api/auth/me, which a cross-origin page cannot read.
export function checkCsrf(req, session) {
  const sent = req.get(CSRF_HEADER);
  if (!sent || !session?.csrf_secret) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(session.csrf_secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
