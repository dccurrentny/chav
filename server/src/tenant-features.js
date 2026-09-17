// Reading and writing which features a customer has.
import { query } from './db.js';
import { logger } from './logger.js';
import { isFeature, withDependencies, operationsFor, DEFAULT_FEATURES } from './features.js';

// Checked on every customer API call, so cached briefly — long enough to
// matter, short enough that a change in the console takes effect at once.
const CACHE_TTL_MS = 15_000;
const cache = new Map();   // tenantId -> { at, features }

export function invalidateFeatures(tenantId) {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

export async function featuresFor(tenantId) {
  if (!tenantId) return [];
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.features;

  let features = [];
  try {
    const { rows } = await query(
      'SELECT feature FROM tenant_features WHERE tenant_id = $1', [tenantId]);
    features = rows.map((r) => r.feature).filter(isFeature);
  } catch (err) {
    // Failing closed is right here: a customer briefly seeing less is a far
    // better outcome than one briefly seeing more.
    logger.error({ err: err.message, tenantId }, 'could not read tenant features');
    features = [];
  }
  cache.set(tenantId, { at: Date.now(), features });
  return features;
}

export async function setFeatures(tenantId, names, staffId) {
  const wanted = withDependencies(names.filter(isFeature));

  await query('DELETE FROM tenant_features WHERE tenant_id = $1', [tenantId]);
  for (const feature of wanted) {
    await query(
      `INSERT INTO tenant_features (tenant_id, feature, enabled_by)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [tenantId, feature, staffId ?? null],
    );
  }
  invalidateFeatures(tenantId);
  return wanted;
}

export async function enableDefaults(tenantId, staffId) {
  return setFeatures(tenantId, [...DEFAULT_FEATURES], staffId);
}

/** Is this operation covered by something the customer actually has? */
export async function operationAllowed(tenantId, operation) {
  const features = await featuresFor(tenantId);
  return operationsFor(features).has(operation);
}
