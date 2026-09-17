// Applies each customer's schedule to SkySwitch as the hours turn.
//
// The schedule is the desired state; this is what makes the phone system
// match it. It rewrites one answer rule per customer rather than creating a
// time frame per hour, which is the approach the Scheduler Suite already took
// and the one NetSapiens is comfortable with.
import { query } from '../db.js';
import { logger } from '../logger.js';
import { nsRequest, NsError } from '../netsapiens/client.js';
import * as audit from '../audit.js';
import { featuresFor } from '../tenant-features.js';
import { effectiveAt, recordApplied, DAYS } from './store.js';

// The time frame the engine owns. Everything outside it is the customer's own
// business and is never touched.
export const ENGINE_TIME_FRAME = '*';

async function tenantsToApply() {
  const { rows } = await query(
    `SELECT t.id, t.name, t.ns_domain, t.main_extension, t.timezone,
            s.applied_target
       FROM tenants t
       LEFT JOIN tenant_schedule_state s ON s.tenant_id = t.id
      WHERE t.status = 'active' AND t.main_extension IS NOT NULL`);
  return rows;
}

// What the schedule says should be live right now. An override covering this
// instant wins over the weekly grid; store.effectiveAt is the single place that
// decides, so the engine and the countdown the customer is reading cannot
// disagree about who is on.
async function desiredTarget(tenantId, timezone) {
  const eff = await effectiveAt(tenantId, timezone);
  return eff?.target ? eff : null;
}

// How the change is described in the audit trail: an override says so, because
// "why did calls move at 2pm on a Tuesday" is the question the trail answers.
function describeChange(desired) {
  if (desired.source === 'override') {
    return `override until ${new Date(desired.endsAt).toISOString()} -> ${desired.name}`;
  }
  return `${DAYS[desired.day]} ${String(desired.hour).padStart(2, '0')}:00 -> ${desired.name}`;
}

/**
 * Bring one customer's phone system in line with their schedule.
 *
 * Returns what it did, so a run can be reported rather than guessed at.
 */
export async function applyForTenant(tenant) {
  const features = await featuresFor(tenant.id);
  if (!features.includes('schedule')) return { tenant: tenant.name, skipped: 'not enabled' };

  const desired = await desiredTarget(tenant.id, tenant.timezone);

  // No destination for this hour — either the grid leaves it unassigned or an
  // override deliberately points at nobody. Leaving the phone system alone is
  // the whole point of both.
  if (!desired) return { tenant: tenant.name, skipped: 'hour unassigned' };

  // Already there. Rewriting an unchanged rule every hour would be noise in
  // their audit trail and needless load on SkySwitch.
  if (tenant.applied_target === desired.target) {
    return { tenant: tenant.name, unchanged: desired.target };
  }

  try {
    await nsRequest('answerrule', 'update', {
      domain: tenant.ns_domain,
      user: tenant.main_extension,
      time_frame: ENGINE_TIME_FRAME,
      order: 0,
      enable: 'yes',
      for_parameters: desired.target,
      for_control: 'e',
    }, { tenantId: tenant.id });

    await recordApplied(tenant.id, { target: desired.target });
    await audit.record({
      tenantId: tenant.id,
      actorKind: 'system',
      actorEmail: null,
      nsDomain: tenant.ns_domain,
      op: 'schedule.apply',
      target: describeChange(desired),
      before: { target: tenant.applied_target ?? null },
      after: { target: desired.target },
      result: 'ok',
    });

    logger.info({ tenant: tenant.name, target: desired.target }, 'schedule applied');
    return { tenant: tenant.name, applied: desired.target, via: desired.name };
  } catch (err) {
    const message = err instanceof NsError ? err.message : String(err.message ?? err);
    await recordApplied(tenant.id, { error: message });
    await audit.record({
      tenantId: tenant.id,
      actorKind: 'system',
      nsDomain: tenant.ns_domain,
      op: 'schedule.apply',
      target: desired.name,
      result: 'error',
      error: message,
    });
    // Logged, recorded, and not rethrown: one customer's SkySwitch being
    // unreachable must not stop every other customer's schedule running.
    logger.warn({ tenant: tenant.name, err: message }, 'schedule could not be applied');
    return { tenant: tenant.name, error: message };
  }
}

export async function runOnce() {
  const tenants = await tenantsToApply();
  const results = [];
  for (const tenant of tenants) {
    results.push(await applyForTenant(tenant));
  }
  return results;
}

let timer = null;

/**
 * Check every minute rather than hourly.
 *
 * An hourly timer drifts, and misses an hour entirely if the process restarts
 * across the boundary. A minute tick costs one query when nothing has changed,
 * because applyForTenant does nothing when the target already matches.
 */
export function startEngine() {
  if (timer) return;
  timer = setInterval(() => {
    runOnce().catch((err) => logger.error({ err }, 'schedule engine run failed'));
  }, 60_000);
  timer.unref();

  // And once at startup, so a restart lands on the right hour immediately
  // rather than up to a minute late.
  runOnce().catch((err) => logger.error({ err }, 'initial schedule run failed'));
  logger.info('schedule engine started');
}

export function stopEngine() {
  if (timer) clearInterval(timer);
  timer = null;
}
