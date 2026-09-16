// Append-only audit trail.
//
// Every SkySwitch write goes through here, successful or not. This is the
// record you produce when a customer disputes a routing change, so a failure
// to write the audit row is treated as a real error rather than swallowed.
import { query } from './db.js';
import { logger } from './logger.js';

export async function record(entry) {
  const {
    tenantId = null, userId = null, actorEmail = null, nsDomain = null,
    op, target = null, params = null, before = null, after = null,
    result, error = null, durationMs = null, dedupeKey = null, ip = null,
  } = entry;

  try {
    await query(
      `INSERT INTO audit_log
         (tenant_id, user_id, actor_email, ns_domain, op, target, params,
          before_val, after_val, result, error, duration_ms, dedupe_key, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        tenantId, userId, actorEmail, nsDomain, op, target,
        params ? JSON.stringify(params) : null,
        before ? JSON.stringify(before) : null,
        after  ? JSON.stringify(after)  : null,
        result, error, durationMs, dedupeKey, ip,
      ],
    );
  } catch (err) {
    // Log loudly. We do not rethrow: losing the audit row must not also
    // roll back a change that already landed at SkySwitch.
    logger.error({ err, op, tenantId }, 'FAILED TO WRITE AUDIT ROW');
  }
}

// NetSapiens has no idempotency keys, so a client retry can double-apply a
// change. Callers pass a stable key and we refuse a repeat inside the window.
export async function alreadyApplied(dedupeKey, withinSeconds = 60) {
  if (!dedupeKey) return false;
  const { rows } = await query(
    `SELECT 1 FROM audit_log
      WHERE dedupe_key = $1 AND result = 'ok' AND at > now() - ($2 || ' seconds')::interval
      LIMIT 1`,
    [dedupeKey, String(withinSeconds)],
  );
  return rows.length > 0;
}

export async function listForTenant(tenantId, { limit = 100, before = null } = {}) {
  const { rows } = await query(
    `SELECT at, actor_email, op, target, result, error, duration_ms
       FROM audit_log
      WHERE tenant_id = $1 AND ($2::timestamptz IS NULL OR at < $2)
      ORDER BY at DESC
      LIMIT $3`,
    [tenantId, before, Math.min(limit, 500)],
  );
  return rows;
}
