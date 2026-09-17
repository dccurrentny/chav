import express from 'express';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '../auth/middleware.js';
import { featuresFor } from '../tenant-features.js';
import { actorFor } from '../admin/impersonate.js';
import * as audit from '../audit.js';
import * as store from '../schedule/store.js';
import { applyForTenant } from '../schedule/engine.js';
import { query } from '../db.js';

export const scheduleRouter = express.Router();
scheduleRouter.use(requireAuth, requireCsrf);

// The schedule is one of the parts a customer may or may not have been given.
scheduleRouter.use(async (req, res, next) => {
  try {
    const features = await featuresFor(req.session.tenant_id);
    if (!features.includes('schedule')) {
      return res.status(403).json({
        error: 'not_enabled',
        message: 'The dispatch schedule is not part of this portal. ' +
                 'Ask your provider to turn it on.',
        feature: 'schedule',
      });
    }
    next();
  } catch (err) { next(err); }
});

// Extensions, or an outside number. Same shapes the SkySwitch allowlist takes.
const target = z.string()
  .regex(/^(\d{3,6}|\+?\d{7,15})$/, 'must be an extension or a phone number');
const colour = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'must be a colour like #2F6FED');

scheduleRouter.get('/', async (req, res, next) => {
  try {
    const tenantId = req.session.tenant_id;
    const [destinations, grid, state, tz] = await Promise.all([
      store.destinationsFor(tenantId),
      store.scheduleFor(tenantId),
      store.stateFor(tenantId),
      query('SELECT timezone FROM tenants WHERE id = $1', [tenantId]),
    ]);
    const timezone = tz.rows[0]?.timezone ?? 'America/New_York';

    res.json({
      destinations,
      grid,
      timezone,
      days: store.DAYS,
      now: store.currentCell(timezone),
      // What the phone system is actually set to, which is not always what the
      // grid says — the engine may not have caught up, or may have failed.
      applied: state ? {
        target: state.applied_target,
        at: state.applied_at,
        lastError: state.last_error,
        lastAttempt: state.last_attempt,
      } : null,
    });
  } catch (err) { next(err); }
});

scheduleRouter.post('/destinations', async (req, res, next) => {
  try {
    const parsed = z.object({
      name: z.string().min(1).max(60),
      target,
      colour: colour.optional(),
    }).strict().safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_input',
        message: 'Some values were not accepted.',
        details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), problem: i.message })),
      });
    }

    const dest = await store.addDestination(req.session.tenant_id, parsed.data);
    await audit.record({
      ...actorFor(req.session),
      tenantId: req.session.tenant_id,
      op: 'schedule.destination.create',
      target: `${dest.name} (${dest.target})`,
      result: 'ok', ip: req.ip,
    });
    res.status(201).json({ ok: true, destination: dest });
  } catch (err) { next(err); }
});

scheduleRouter.patch('/destinations/:id', async (req, res, next) => {
  try {
    const parsed = z.object({
      name: z.string().min(1).max(60).optional(),
      target: target.optional(),
      colour: colour.optional(),
    }).strict().safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', message: 'Some values were not accepted.' });
    }

    const dest = await store.updateDestination(req.session.tenant_id, req.params.id, parsed.data);
    if (!dest) return res.status(404).json({ error: 'not_found', message: 'No such destination.' });

    await audit.record({
      ...actorFor(req.session),
      tenantId: req.session.tenant_id,
      op: 'schedule.destination.update',
      target: `${dest.name} (${dest.target})`,
      result: 'ok', ip: req.ip,
    });
    res.json({ ok: true, destination: dest });
  } catch (err) { next(err); }
});

scheduleRouter.delete('/destinations/:id', async (req, res, next) => {
  try {
    const removed = await store.removeDestination(req.session.tenant_id, req.params.id);
    if (!removed) return res.status(404).json({ error: 'not_found', message: 'No such destination.' });

    await audit.record({
      ...actorFor(req.session),
      tenantId: req.session.tenant_id,
      op: 'schedule.destination.delete',
      result: 'ok', ip: req.ip,
    });
    // Hours that pointed here are now unassigned, so say what the week is now.
    res.json({ ok: true, grid: await store.scheduleFor(req.session.tenant_id) });
  } catch (err) { next(err); }
});

scheduleRouter.put('/grid', async (req, res, next) => {
  try {
    const parsed = z.object({
      grid: z.array(z.array(z.string().uuid().nullable()).length(24)).length(7),
    }).strict().safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_input',
        message: 'That schedule was not a full week of 24 hours.',
      });
    }

    // Every referenced destination must be this customer's own. Without this
    // a crafted request could point an hour at another customer's row.
    const own = new Set((await store.destinationsFor(req.session.tenant_id)).map((d) => d.id));
    for (const day of parsed.data.grid) {
      for (const cell of day) {
        if (cell && !own.has(cell)) {
          return res.status(400).json({
            error: 'invalid_input',
            message: 'That schedule refers to a destination that is not yours.',
          });
        }
      }
    }

    await store.setSchedule(req.session.tenant_id, parsed.data.grid);
    await audit.record({
      ...actorFor(req.session),
      tenantId: req.session.tenant_id,
      op: 'schedule.grid.update',
      result: 'ok', ip: req.ip,
    });

    // Apply straight away rather than leaving the phone system up to a minute
    // behind what the customer just saved and is looking at.
    const { rows } = await query(
      `SELECT t.id, t.name, t.ns_domain, t.main_extension, t.timezone, s.applied_target
         FROM tenants t LEFT JOIN tenant_schedule_state s ON s.tenant_id = t.id
        WHERE t.id = $1`, [req.session.tenant_id]);
    const result = rows[0] ? await applyForTenant(rows[0]) : null;

    res.json({ ok: true, applied: result });
  } catch (err) { next(err); }
});
