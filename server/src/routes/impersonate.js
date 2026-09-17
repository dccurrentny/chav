import express from 'express';
import { redeemGrant, createImpersonatedSession } from '../admin/impersonate.js';
import { cookieOptions, COOKIE_NAME } from '../auth/session.js';
import { requireTenant } from '../tenant.js';
import * as audit from '../audit.js';
import { logger } from '../logger.js';

export const impersonateRouter = express.Router();

// Redeemed on the CUSTOMER's hostname — the only place their cookie can be
// set. The grant is single-use, expires in 60 seconds, and is bound to the
// tenant that owns this hostname, so a link for one customer cannot be
// redeemed on another's address.
impersonateRouter.get('/__impersonate', requireTenant, async (req, res, next) => {
  try {
    // On the shared portal there is no hostname tenant to pin the grant to;
    // the grant's own user supplies it.
    const grant = await redeemGrant(req.query.t, req.sharedPortal ? null : req.tenant.id);
    if (!grant) {
      // One message for expired, already-used, wrong-tenant and forged alike.
      return res.status(400).type('html').send(
        '<!doctype html><meta charset="utf-8">' +
        '<title>Link expired</title>' +
        '<body style="font:16px system-ui;max-width:32em;margin:18vh auto;padding:0 1em">' +
        '<h1 style="font-size:1.3em">This support link is no longer valid</h1>' +
        '<p>Support links can be used once and expire after a minute. ' +
        'Start a new one from the admin console.</p></body>');
    }

    const { token, expiresAt } = await createImpersonatedSession({
      userId: grant.user_id,
      previewTenantId: grant.preview_tenant_id,
      staffId: grant.staff_id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    await audit.record({
      tenantId: grant.tenant_id, userId: grant.user_id,
      actorKind: 'staff', staffId: grant.staff_id,
      // Name the operator, so the customer's own history says who looked.
      actorEmail: grant.staff_email,
      op: grant.preview_tenant_id ? 'impersonation.preview' : 'impersonation.begin',
      result: 'ok', ip: req.ip,
      after: { expiresAt },
    });

    res.cookie(COOKIE_NAME, token, { ...cookieOptions(), maxAge: expiresAt - Date.now() });

    // Fixed destination. Never a redirect target taken from the request —
    // that is how a support link becomes an open redirect.
    res.redirect(303, '/');
  } catch (err) {
    logger.error({ err }, 'impersonation redemption failed');
    next(err);
  }
});
