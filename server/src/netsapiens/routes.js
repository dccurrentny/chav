import express from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { getOperation, OPERATION_NAMES } from './allowlist.js';
import { nsRequest, NsError } from './client.js';
import { requireAuth, requireCsrf } from '../auth/middleware.js';
import * as audit from '../audit.js';
import { logger } from '../logger.js';

export const nsRouter = express.Router();

nsRouter.use(requireAuth, requireCsrf);

// Writes are the expensive, rate-limited path — NetSapiens throttles, and a
// runaway grid save could otherwise fire 168 updates.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.session?.user_id ?? req.ip,
  message: { error: 'rate_limited', message: 'Too many changes at once. Wait a minute and retry.' },
});

nsRouter.get('/operations', (req, res) => {
  // What this specific caller may invoke, so the UI can hide the rest.
  const allowed = OPERATION_NAMES.filter((name) => {
    const op = getOperation(name);
    return op.role !== 'admin' || req.session.role === 'admin';
  });
  res.json({ operations: allowed });
});

nsRouter.post('/:operation', writeLimiter, async (req, res, next) => {
  const name = req.params.operation;
  const op = getOperation(name);
  const s = req.session;

  // Default deny: an unlisted operation does not exist as far as the API is concerned.
  if (!op) {
    return res.status(404).json({ error: 'unknown_operation', message: `No such operation: ${name}` });
  }

  if (op.role === 'admin' && s.role !== 'admin') {
    await audit.record({
      tenantId: s.tenant_id, userId: s.user_id, actorEmail: s.email, nsDomain: s.ns_domain,
      op: name, result: 'denied', error: 'role', ip: req.ip,
    });
    return res.status(403).json({
      error: 'forbidden',
      message: 'This change needs an administrator on your account.',
    });
  }

  const parsed = op.params.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_input',
      message: 'Some values were not accepted.',
      details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), problem: i.message })),
    });
  }

  // THE authorization step: the NetSapiens domain comes from the session's
  // tenant, never from the request. A client-supplied `domain` was already
  // rejected by the .strict() schema above.
  const params = { ...parsed.data, domain: s.ns_domain };
  const target = op.describe ? op.describe(parsed.data) : (parsed.data.extension ?? null);

  // Stable key over (tenant, operation, payload) so a double-submit within the
  // window is recognised rather than re-applied.
  const dedupeKey = op.write
    ? crypto.createHash('sha256')
        .update(JSON.stringify([s.tenant_id, name, parsed.data]))
        .digest('hex')
    : null;

  try {
    if (op.write && await audit.alreadyApplied(dedupeKey)) {
      return res.status(200).json({ ok: true, deduplicated: true, message: 'That change was already applied.' });
    }

    // Capture prior state so the audit row can show before/after.
    let before = null;
    if (op.write && op.readBack) {
      before = await safeReadBack(op, params);
    }

    const { data, durationMs } = await nsRequest(op.object, op.action, params);

    let after = null;
    let verified = null;
    if (op.write && op.readBack) {
      after = await safeReadBack(op, params);
      // A 200 from NetSapiens does not reliably mean the change landed.
      verified = after !== null && JSON.stringify(after) !== JSON.stringify(before);
    }

    await audit.record({
      tenantId: s.tenant_id, userId: s.user_id, actorEmail: s.email, nsDomain: s.ns_domain,
      op: name, target, params: parsed.data, before, after,
      result: 'ok', durationMs, dedupeKey, ip: req.ip,
    });

    res.json({ ok: true, data, ...(verified === null ? {} : { verified }) });
  } catch (err) {
    if (err instanceof NsError) {
      await audit.record({
        tenantId: s.tenant_id, userId: s.user_id, actorEmail: s.email, nsDomain: s.ns_domain,
        op: name, target, params: parsed.data,
        result: 'error', error: err.message, durationMs: err.durationMs ?? null, ip: req.ip,
      });
      logger.warn({ op: name, status: err.status, detail: err.detail }, 'SkySwitch call failed');
      return res.status(err.retryable ? 503 : 502).json({
        error: 'upstream_failed',
        message: err.retryable
          ? 'SkySwitch did not respond. Your change was not saved — try again in a moment.'
          : 'SkySwitch rejected the change. Nothing was saved.',
        retryable: Boolean(err.retryable),
      });
    }
    next(err);
  }
});

// A read-back must never turn a successful write into a 500.
async function safeReadBack(op, params) {
  const readOp = getOperation(op.readBack.op);
  if (!readOp) return null;
  const key = op.readBack.key;
  try {
    const { data } = await nsRequest(readOp.object, readOp.action, {
      [key]: params[key],
      domain: params.domain,
    });
    return data;
  } catch (err) {
    logger.warn({ err: err.message, op: op.readBack.op }, 'read-back failed');
    return null;
  }
}
