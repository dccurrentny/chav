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

/**
 * Mint a grant for either a user or, when a customer has no accounts yet, the
 * tenant itself. Exactly one of userId and previewTenantId is given.
 */
export async function createGrant({ userId = null, previewTenantId = null, staffId, ip }) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO impersonation_grants
       (token_hash, user_id, preview_tenant_id, staff_id, expires_at, ip)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval, $6)`,
    [hashToken(token), userId, previewTenantId, staffId, String(GRANT_TTL_SECONDS), ip ?? null],
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
        AND (
          -- Either the named user is still usable and in scope for this
          -- hostname, or it is a tenant preview with no user at all.
          (g.user_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM users u
              WHERE u.id = g.user_id AND u.status = 'active'
                AND ($2::uuid IS NULL OR u.tenant_id = $2)))
          OR
          (g.preview_tenant_id IS NOT NULL
             AND ($2::uuid IS NULL OR g.preview_tenant_id = $2))
        )
      RETURNING g.user_id, g.preview_tenant_id, g.staff_id,
                COALESCE(
                  (SELECT tenant_id FROM users WHERE id = g.user_id),
                  g.preview_tenant_id) AS tenant_id,
                (SELECT email FROM staff WHERE id = g.staff_id) AS staff_email`,
    [hashToken(token), tenantId],
  );
  return rows[0] ?? null;
}

export async function createImpersonatedSession({ userId = null, previewTenantId = null,
                                                   staffId, ip, userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfSecret = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MINUTES * 60 * 1000);

  await query(
    `INSERT INTO sessions
       (token_hash, user_id, preview_tenant_id, csrf_secret, expires_at, ip, user_agent, impersonated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [hashToken(token), userId, previewTenantId, csrfSecret, expiresAt, ip ?? null,
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
 * How a change made from a support session is attributed.
 *
 * Support sessions were read-only at first, on the reasoning that an
 * impersonated write would record the customer making a change they did not
 * make. The answer to that is attribution, not refusal: an operator setting a
 * customer up has to be able to configure them, and a customer with no
 * accounts yet has nobody else who can.
 *
 * So the write is allowed and recorded as the OPERATOR — actor_kind 'staff',
 * their staff id, their email — in the customer's own activity list. It never
 * reads as the customer having done it, which was the only thing that made
 * this dangerous.
 */
export function actorFor(session) {
  if (session?.impersonated_by) {
    return {
      actorKind: 'staff',
      staffId: session.impersonated_by,
      actorEmail: session.staff_email,
      // Recorded so the row says which account was acted on, even in a
      // preview where there is no user to name.
      userId: session.user_id ?? null,
    };
  }
  return {
    actorKind: 'customer',
    staffId: null,
    actorEmail: session.email,
    userId: session.user_id,
  };
}

export function impersonationUrl(hostname, token) {
  // hostname is the customer's own address, or the shared portal for a
  // customer that does not have one.
  // Fixed path, fixed scheme. Never built from anything the client supplied.
  const scheme = config.NODE_ENV === 'production' ? 'https' : 'http';
  return `${scheme}://${hostname}/__impersonate?t=${encodeURIComponent(token)}`;
}
