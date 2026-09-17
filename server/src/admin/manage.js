import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query } from '../db.js';
import { hashPassword } from '../auth/password.js';
import { requireStaff, requireOwner, requireStaffCsrf } from './middleware.js';
import { destroyAllStaffSessions } from './session.js';
import { _clearTenantCache, isReservedHostname } from '../tenant.js';
import { createGrant, impersonationUrl, IMPERSONATION_TTL_MINUTES } from './impersonate.js';
import {
  describeNsSettings, describeTelcoSettings, setSettings,
  getNsSettings, getTelcoSettings, PBX_KEYS, TELCO_KEYS,
  describeTenantNsSettings, setTenantSettings,
} from '../settings.js';
import { testConnection, _resetTokenCache } from '../netsapiens/client.js';
import { testTelcoConnection, _resetTelcoToken, AUTH_STYLES, TELCO_SCOPES } from '../telco/client.js';
import * as audit from '../audit.js';

export const adminRouter = express.Router();
adminRouter.use(requireStaff, requireStaffCsrf);

// Postgres raises on a malformed uuid, which surfaced as a 500 and an error
// log line for what is really just a bad URL. Reject the shape up front: a
// nonexistent id and an unparseable one should both read as "no such thing".
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
adminRouter.param('id', (req, res, next, value) => {
  if (!UUID_RE.test(value)) {
    return res.status(404).json({ error: 'not_found', message: 'No such record.' });
  }
  next();
});

/* ---------------------------------------------------------------- helpers */

// Every operator action is recorded. The console can change a customer's
// phone routing, so "who did this" must never be a guess.
function log(req, entry) {
  return audit.record({
    actorKind: 'staff',
    staffId: req.staff.staff_id,
    actorEmail: req.staff.email,
    ip: req.ip,
    ...entry,
  });
}

function bad(res, details) {
  return res.status(400).json({
    error: 'invalid_input',
    message: 'Some values were not accepted.',
    details: details.map((i) => ({ field: i.path.join('.'), problem: i.message })),
  });
}

// 18 random bytes -> 24 base64url chars. Shown once, never stored in the clear.
function generatePassword() {
  return crypto.randomBytes(18).toString('base64url');
}

const hostname = z.string()
  .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/,
         'must look like acme.portal.example.com');
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'must be a hex value like #2F6FED');

/* -------------------------------------------------------------- overview */

adminRouter.get('/overview', async (_req, res, next) => {
  try {
    const [{ rows: counts }, { rows: recent }] = await Promise.all([
      query(`SELECT
               (SELECT count(*) FROM tenants WHERE status = 'active')   AS active_tenants,
               (SELECT count(*) FROM tenants WHERE status = 'suspended')AS suspended_tenants,
               (SELECT count(*) FROM users   WHERE status = 'active')   AS active_users,
               (SELECT count(*) FROM audit_log WHERE at > now() - interval '24 hours') AS events_24h,
               (SELECT count(*) FROM audit_log
                 WHERE at > now() - interval '24 hours' AND result = 'error') AS errors_24h`),
      query(`SELECT a.at, a.actor_email, a.actor_kind, a.op, a.target, a.result, t.name AS tenant_name
               FROM audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id
              ORDER BY a.at DESC LIMIT 12`),
    ]);
    res.json({ counts: counts[0], recent });
  } catch (err) { next(err); }
});

/* --------------------------------------------------------------- tenants */

adminRouter.get('/tenants', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT t.id, t.name, t.ns_domain, t.hostname, t.status, t.main_extension,
              t.brand_name, t.brand_color, t.logo_url, t.support_email, t.support_phone,
              t.created_at,
              (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.status='active') AS user_count,
              (SELECT max(at) FROM audit_log a WHERE a.tenant_id = t.id) AS last_activity
         FROM tenants t
        ORDER BY t.name`);
    res.json({ tenants: rows });
  } catch (err) { next(err); }
});

const tenantInput = z.object({
  name:           z.string().min(1).max(120),
  ns_domain:      z.string().min(1).max(253),
  // Optional. A customer without their own address signs in at the shared
  // portal instead; the bare portal domain is not claimed by whoever is first.
  hostname:       hostname.nullish(),
  main_extension: z.string().regex(/^\d{3,6}$/, 'must be 3-6 digits').nullish(),
  brand_color:   hexColor.nullish(),
  logo_url:      z.string().url().max(500).nullish(),
  support_email: z.string().email().max(254).nullish(),
  support_phone: z.string().max(40).nullish(),
}).strict();

adminRouter.post('/tenants', async (req, res, next) => {
  try {
    const parsed = tenantInput.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error.issues);
    const t = parsed.data;

    if (t.hostname && isReservedHostname(t.hostname)) {
      return res.status(409).json({
        error: 'conflict',
        message: 'That address is the shared portal or the staff console. ' +
                 'Leave the address blank to put this customer on the shared portal.',
      });
    }

    const { rows } = await query(
      `INSERT INTO tenants (name, ns_domain, hostname, brand_name, brand_color,
                            logo_url, support_email, support_phone, main_extension)
       VALUES ($1,$2,$3,$1,$4,$5,$6,$7,$8) RETURNING id`,
      [t.name, t.ns_domain, t.hostname, t.brand_color ?? null, t.logo_url ?? null,
       t.support_email ?? null, t.support_phone ?? null, t.main_extension ?? null],
    );
    _clearTenantCache();
    await log(req, { tenantId: rows[0].id, op: 'staff.tenant.create', target: t.hostname,
                     params: t, after: t, result: 'ok' });
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'conflict',
        message: 'A customer already uses that web address or SkySwitch domain.',
      });
    }
    next(err);
  }
});

adminRouter.patch('/tenants/:id', async (req, res, next) => {
  try {
    const parsed = tenantInput.partial().safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error.issues);
    const patch = parsed.data;
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'invalid_input', message: 'Nothing to change.' });
    }

    if (patch.hostname && isReservedHostname(patch.hostname)) {
      return res.status(409).json({
        error: 'conflict',
        message: 'That address is the shared portal or the staff console. ' +
                 'Leave the address blank to put this customer on the shared portal.',
      });
    }

    const { rows: [before] } = await query('SELECT * FROM tenants WHERE id = $1', [req.params.id]);
    if (!before) return res.status(404).json({ error: 'not_found', message: 'No such customer.' });

    // brand_name tracks name unless it was set apart deliberately.
    const next_ = { ...before, ...patch };
    const { rows } = await query(
      `UPDATE tenants SET name=$2, ns_domain=$3, hostname=$4,
              brand_name=$5, brand_color=$6, logo_url=$7, support_email=$8,
              support_phone=$9, main_extension=$10
        WHERE id=$1 RETURNING id`,
      [req.params.id, next_.name, next_.ns_domain, next_.hostname,
       patch.name ?? next_.brand_name, next_.brand_color, next_.logo_url,
       next_.support_email, next_.support_phone, next_.main_extension],
    );
    _clearTenantCache();
    await log(req, { tenantId: rows[0].id, op: 'staff.tenant.update', target: next_.hostname,
                     params: patch, before, after: next_, result: 'ok' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'conflict', message: 'That web address is already in use.' });
    }
    next(err);
  }
});

// Suspending is reversible and immediate: it kills live sessions on the next
// request and makes the hostname stop resolving as a portal. There is
// deliberately no delete — an audit trail with a dangling tenant is worse
// than a row marked suspended.
adminRouter.post('/tenants/:id/status', async (req, res, next) => {
  try {
    const parsed = z.object({ status: z.enum(['active', 'suspended']) }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error.issues);

    const { rows } = await query(
      'UPDATE tenants SET status = $2 WHERE id = $1 RETURNING hostname, status',
      [req.params.id, parsed.data.status],
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found', message: 'No such customer.' });

    _clearTenantCache();
    await log(req, { tenantId: req.params.id, op: 'staff.tenant.status',
                     target: rows[0].hostname, after: { status: rows[0].status }, result: 'ok' });
    res.json({ ok: true, status: rows[0].status });
  } catch (err) { next(err); }
});

/* ------------------------------------------- per-customer PBX credentials */

// A customer can have its own SkySwitch subscriber. Where it does, SkySwitch
// enforces the tenant boundary itself rather than trusting our domain scoping.
adminRouter.get('/tenants/:id/credentials', requireOwner, async (req, res, next) => {
  try {
    res.json(await describeTenantNsSettings(req.params.id));
  } catch (err) { next(err); }
});

adminRouter.put('/tenants/:id/credentials', requireOwner, async (req, res, next) => {
  try {
    const shape = {};
    for (const key of PBX_KEYS) shape[key] = z.string().max(500).nullish();
    const parsed = z.object(shape).strict().safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error.issues);

    const entries = {};
    for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) entries[k] = v;
    if (!Object.keys(entries).length) {
      return res.status(400).json({ error: 'invalid_input', message: 'Nothing to change.' });
    }

    await setTenantSettings(req.params.id, entries, req.staff.staff_id);
    _resetTokenCache();
    await log(req, {
      tenantId: req.params.id, op: 'staff.tenant.credentials',
      params: { changed: Object.keys(entries) }, result: 'ok',
    });
    res.json({ ok: true, ...(await describeTenantNsSettings(req.params.id)) });
  } catch (err) { next(err); }
});

adminRouter.post('/tenants/:id/credentials/test', requireOwner, async (req, res, next) => {
  try {
    const result = await testConnection(req.params.id);
    await log(req, {
      tenantId: req.params.id, op: 'staff.tenant.credentials.test',
      result: result.ok ? 'ok' : 'error', error: result.ok ? null : result.reason,
    });
    res.json(result);
  } catch (err) { next(err); }
});

/* ----------------------------------------------------------------- users */

adminRouter.get('/tenants/:id/users', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, email, role, status, last_login_at, created_at
         FROM users WHERE tenant_id = $1 ORDER BY created_at`,
      [req.params.id]);
    res.json({ users: rows });
  } catch (err) { next(err); }
});

adminRouter.post('/tenants/:id/users', async (req, res, next) => {
  try {
    const parsed = z.object({
      email: z.string().email().max(254),
      role:  z.enum(['member', 'admin']).default('member'),
    }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error.issues);

    const password = generatePassword();
    const { rows } = await query(
      `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1,$2,$3,$4)
       RETURNING id`,
      [req.params.id, parsed.data.email, await hashPassword(password), parsed.data.role],
    );
    await log(req, { tenantId: req.params.id, op: 'staff.user.create',
                     target: parsed.data.email, params: { role: parsed.data.role }, result: 'ok' });
    // Returned once and never recoverable.
    res.status(201).json({ ok: true, id: rows[0].id, password });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'conflict', message: 'That email already has an account.' });
    }
    next(err);
  }
});

adminRouter.post('/users/:id/password', async (req, res, next) => {
  try {
    const password = generatePassword();
    const { rows } = await query(
      'UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING email, tenant_id',
      [req.params.id, await hashPassword(password)],
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found', message: 'No such user.' });

    // A password reset must not leave the old sessions alive.
    await query('DELETE FROM sessions WHERE user_id = $1', [req.params.id]);
    await log(req, { tenantId: rows[0].tenant_id, op: 'staff.user.reset_password',
                     target: rows[0].email, result: 'ok' });
    res.json({ ok: true, password });
  } catch (err) { next(err); }
});

adminRouter.patch('/users/:id', async (req, res, next) => {
  try {
    const parsed = z.object({
      role:   z.enum(['member', 'admin']).optional(),
      status: z.enum(['active', 'disabled']).optional(),
    }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error.issues);
    const { role, status } = parsed.data;
    if (!role && !status) {
      return res.status(400).json({ error: 'invalid_input', message: 'Nothing to change.' });
    }

    const { rows } = await query(
      `UPDATE users SET role = COALESCE($2, role), status = COALESCE($3, status)
        WHERE id = $1 RETURNING email, tenant_id, role, status`,
      [req.params.id, role ?? null, status ?? null],
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found', message: 'No such user.' });

    // Disabling takes effect now, not when their session happens to expire.
    if (status === 'disabled') {
      await query('DELETE FROM sessions WHERE user_id = $1', [req.params.id]);
    }
    await log(req, { tenantId: rows[0].tenant_id, op: 'staff.user.update',
                     target: rows[0].email, after: parsed.data, result: 'ok' });
    res.json({ ok: true, user: rows[0] });
  } catch (err) { next(err); }
});

/* --------------------------------------------------- view as a customer */

// Mints a single-use, 60-second grant. The console opens the returned URL on
// the CUSTOMER's hostname, which is the only place their session cookie can be
// set. The resulting session is read-only and clearly marked.
adminRouter.post('/users/:id/impersonate', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.email, u.status, t.id AS tenant_id, t.name AS tenant_name,
              t.hostname, t.status AS tenant_status
         FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE u.id = $1`,
      [req.params.id],
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'not_found', message: 'No such user.' });

    if (user.status !== 'active' || user.tenant_status !== 'active') {
      return res.status(409).json({
        error: 'conflict',
        message: 'That account is disabled or its customer is suspended.',
      });
    }
    if (!user.hostname) {
      return res.status(409).json({
        error: 'conflict',
        message: 'That customer has no portal address yet, so there is nothing to view.',
      });
    }

    const token = await createGrant({ userId: user.id, staffId: req.staff.staff_id, ip: req.ip });

    await log(req, {
      tenantId: user.tenant_id, userId: user.id, op: 'staff.impersonate.start',
      target: user.email, result: 'ok',
    });

    res.json({
      url: impersonationUrl(user.hostname, token),
      email: user.email,
      tenant: user.tenant_name,
      minutes: IMPERSONATION_TTL_MINUTES,
    });
  } catch (err) { next(err); }
});

/* ----------------------------------------------------------------- audit */

adminRouter.get('/audit', async (req, res, next) => {
  try {
    const q = z.object({
      tenantId:  z.string().uuid().optional(),
      actorKind: z.enum(['customer', 'staff', 'system']).optional(),
      result:    z.enum(['ok', 'error', 'denied']).optional(),
      limit:     z.coerce.number().int().min(1).max(500).default(100),
    }).safeParse(req.query);
    if (!q.success) return bad(res, q.error.issues);

    res.json({ entries: await audit.search({
      tenantId:  q.data.tenantId  ?? null,
      actorKind: q.data.actorKind ?? null,
      result:    q.data.result    ?? null,
      limit:     q.data.limit,
    }) });
  } catch (err) { next(err); }
});

/* ---------------------------------------------------------------- health */

// The console's own health view. Deliberately NOT /readyz: that path is not
// proxied on the admin hostname, and routing infrastructure checks through an
// authenticated endpoint keeps the admin host's public surface to the console
// and nothing else.
adminRouter.get('/health', async (_req, res, next) => {
  try {
    let db = 'up';
    try { await query('SELECT 1'); } catch { db = 'down'; }

    const [ns, telco] = await Promise.all([getNsSettings(), getTelcoSettings()]);
    const nsMissing = Object.entries(ns).filter(([, v]) => !v.set).map(([k]) => k);
    // Telco requirements depend on the auth style, so "configured" here means
    // a base URL plus at least one credential — the Test button is the real check.
    const telcoSet = Object.entries(telco).filter(([, v]) => v.set).map(([k]) => k);
    const telcoReady = telcoSet.includes('TELCO_BASE_URL') && telcoSet.length > 1;

    res.json({
      db,
      pbx:   nsMissing.length ? 'not_configured' : 'configured',
      telco: telcoReady ? 'configured' : 'not_configured',
      missing: nsMissing,
      uptimeSeconds: Math.round(process.uptime()),
    });
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- settings */

// Presence and origin only. A stored secret is never sent back to a browser,
// not even to the operator who set it — there is no reason to read one back,
// and every reason not to put it on the wire again.
const SERVERS = {
  pbx:   { keys: PBX_KEYS,   describe: describeNsSettings,    test: testConnection,      reset: _resetTokenCache },
  telco: { keys: TELCO_KEYS, describe: describeTelcoSettings, test: testTelcoConnection, reset: _resetTelcoToken },
};

function serverOr404(req, res) {
  const s = SERVERS[req.params.server];
  if (!s) {
    res.status(404).json({ error: 'not_found', message: 'No such connection.' });
    return null;
  }
  return s;
}

adminRouter.get('/settings/:server', requireOwner, async (req, res, next) => {
  try {
    const srv = serverOr404(req, res);
    if (!srv) return;
    res.json({
      settings: await srv.describe(),
      authStyles: AUTH_STYLES,
      telcoScopes: TELCO_SCOPES,
    });
  } catch (err) { next(err); }
});

adminRouter.put('/settings/:server', requireOwner, async (req, res, next) => {
  try {
    const srv = serverOr404(req, res);
    if (!srv) return;

    const shape = {};
    for (const key of srv.keys) {
      // null or "" clears the stored value and falls back to portal.env.
      shape[key] = z.string().max(500).nullish();
    }
    const parsed = z.object(shape).strict().safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error.issues);

    // Only apply keys actually present, so saving one field does not wipe the rest.
    const entries = {};
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) entries[key] = value;
    }
    if (!Object.keys(entries).length) {
      return res.status(400).json({ error: 'invalid_input', message: 'Nothing to change.' });
    }

    await setSettings(entries, req.staff.staff_id);
    // Credentials changed: any cached token belongs to the old ones.
    srv.reset();

    await log(req, {
      op: `staff.settings.${req.params.server}`,
      // Names only. The values are secrets and do not belong in an audit row.
      params: { changed: Object.keys(entries) },
      result: 'ok',
    });
    res.json({ ok: true, settings: await srv.describe() });
  } catch (err) { next(err); }
});

// Actually calls SkySwitch, so an operator finds out here rather than from a
// customer that the credentials are wrong.
adminRouter.post('/settings/:server/test', requireOwner, async (req, res, next) => {
  try {
    const srv = serverOr404(req, res);
    if (!srv) return;
    const result = await srv.test();
    await log(req, {
      op: `staff.settings.${req.params.server}.test`,
      result: result.ok ? 'ok' : 'error',
      error: result.ok ? null : result.reason,
    });
    res.json(result);
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- operators */

adminRouter.get('/staff', requireOwner, async (_req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, email, name, role, status, last_login_at, created_at FROM staff ORDER BY created_at');
    res.json({ staff: rows });
  } catch (err) { next(err); }
});

adminRouter.post('/staff', requireOwner, async (req, res, next) => {
  try {
    const parsed = z.object({
      email: z.string().email().max(254),
      name:  z.string().min(1).max(120),
      role:  z.enum(['owner', 'operator']).default('operator'),
    }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error.issues);

    const password = generatePassword();
    const { rows } = await query(
      'INSERT INTO staff (email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id',
      [parsed.data.email, parsed.data.name, await hashPassword(password), parsed.data.role],
    );
    await log(req, { op: 'staff.operator.create', target: parsed.data.email,
                     params: { role: parsed.data.role }, result: 'ok' });
    res.status(201).json({ ok: true, id: rows[0].id, password });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'conflict', message: 'That email is already an operator.' });
    }
    next(err);
  }
});

adminRouter.patch('/staff/:id', requireOwner, async (req, res, next) => {
  try {
    const parsed = z.object({ status: z.enum(['active', 'disabled']) }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error.issues);

    // Locking yourself out of the console is never what you meant.
    if (req.params.id === req.staff.staff_id) {
      return res.status(400).json({
        error: 'invalid_input',
        message: 'You cannot disable your own account. Ask another owner.',
      });
    }

    const { rows } = await query(
      'UPDATE staff SET status = $2 WHERE id = $1 RETURNING email, status',
      [req.params.id, parsed.data.status],
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found', message: 'No such operator.' });

    if (parsed.data.status === 'disabled') await destroyAllStaffSessions(req.params.id);
    await log(req, { op: 'staff.operator.update', target: rows[0].email,
                     after: { status: rows[0].status }, result: 'ok' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
