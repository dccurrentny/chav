import express from 'express';
import { requireAuth } from '../auth/middleware.js';
import * as audit from '../audit.js';

export const auditRouter = express.Router();

// A customer sees their own tenant's history and nobody else's. The tenant id
// comes from the session, so there is no id to tamper with in the request.
auditRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit  = Math.min(Number(req.query.limit) || 100, 500);
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    if (before && Number.isNaN(before.getTime())) {
      return res.status(400).json({ error: 'invalid_input', message: 'Bad "before" timestamp.' });
    }
    const entries = await audit.listForTenant(req.session.tenant_id, { limit, before });
    res.json({ entries });
  } catch (err) {
    next(err);
  }
});
