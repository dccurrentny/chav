// "View as customer".
//
// Read-only by design. An operator can see exactly what the customer sees but
// cannot change anything while wearing their name — otherwise the audit trail
// would record a customer making a change that staff actually made, which is
// precisely the question the log exists to answer.
import crypto from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import * as audit from '../audit.js';

// The grant only has to survive a redirect.
const GRANT_TTL_SECONDS = 60;

// The session it produces is short: support looks, then leaves.
export const IMPERSONATION_TTL_MINUTES = 30;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createGrant({ userId, staffId, ip }) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO impersonation_grants (token_hash, user_id, staff_id, expires_at, ip)
     VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval, $5)`,
    [hashToken(token), userId, staffId, String(GRANT_TTL_SECONDS), ip ?? null],
  );
  return token;
}

/**
 * Redeem a grant.
 *
 * `tenantId` is the tenant owning the hostname the request arrived on, so a
 * grant minted for one customer cannot be redeemed on another's address. On
 * the shared portal there is no such hostname, so it is null and the grant's
 * own user decides the tenant — which is safe because the grant is
 * single-use, expires in 60 seconds, and only an operator can mint one.
 */
export async function redeemGrant(token, tenantId = null) {
  if (!token) return null;

  // Single-use: the UPDATE only matches while used_at is null, so a replayed
  // link finds nothing. Doing it in one statement avoids a check-then-use race.
  const { rows } = await query(
    `UPDATE impersonation_grants g
        SET used_at = now()
      WHERE g.token_hash = $1
        AND g.used_at IS NULL
        AND g.expires_at > now()
        AND EXISTS (
          SELECT 1 FROM users u
           WHERE u.id = g.user_id AND u.status = 'active'
             AND ($2::uuid IS NULL OR u.tenant_id = $2)
        )
      RETURNING g.user_id, g.staff_id,
                (SELECT tenant_id FROM users WHERE id = g.user_id) AS tenant_id,
                (SELECT email FROM staff WHERE id = g.staff_id) AS staff_email`,
    [hashToken(token), tenantId],
  );
  return rows[0] ?? null;
}

export async function createImpersonatedSession({ userId, staffId, ip, userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfSecret = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MINUTES * 60 * 1000);

  await query(
    `INSERT INTO sessions (token_hash, user_id, csrf_secret, expires_at, ip, user_agent, impersonated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [hashToken(token), userId, csrfSecret, expiresAt, ip ?? null,
     userAgent?.slice(0, 500) ?? null, staffId],
  );
  return { token, expiresAt };
}

export async function purgeExpiredGrants() {
  const { rowCount } = await query(
    "DELETE FROM impersonation_grants WHERE expires_at < now() - interval '1 day'");
  return rowCount;
}

/**
 * Refuse a state-changing operation attempted from a support view.
 *
 * Called by the caller that knows whether the operation writes — NOT as
 * blanket middleware. Every SkySwitch operation is a POST, reads included, so
 * a method-based guard would block reads and leave support unable to see
 * anything, which is the entire point of the feature.
 */
export function refuseImpersonatedOperation(req, res, opName) {
  audit.record({
    tenantId: req.session.tenant_id,
    userId: req.session.user_id,
    actorKind: 'staff',
    staffId: req.session.impersonated_by,
    actorEmail: req.session.email,
    op: 'impersonation.write_refused',
    target: opName,
    result: 'denied',
    ip: req.ip,
  }).catch(() => {});

  return res.status(403).json({
    error: 'impersonation_read_only',
    message: 'You are viewing this account as support. Leave support view to make changes.',
  });
}

export function impersonationUrl(hostname, token) {
  // hostname is the customer's own address, or the shared portal for a
  // customer that does not have one.
  // Fixed path, fixed scheme. Never built from anything the client supplied.
  const scheme = config.NODE_ENV === 'production' ? 'https' : 'http';
  return `${scheme}://${hostname}/__impersonate?t=${encodeURIComponent(token)}`;
}
