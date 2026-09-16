// Resolves which customer a request belongs to from the hostname it arrived on.
//
// This runs before authentication. Every customer gets their own hostname, so
// the hostname is the first thing that scopes a request — an unknown host is
// not a portal at all.
import { query } from './db.js';

// Hostnames change rarely and are read on every request, so cache briefly.
// A short TTL means a newly added customer works within a minute without a
// restart, and a removed one stops working just as fast.
const CACHE_TTL_MS = 30_000;
const cache = new Map();   // lowercased hostname -> { tenant, at }

export function _clearTenantCache() {
  cache.clear();
}

export async function lookupByHostname(hostname) {
  if (!hostname) return null;
  const key = String(hostname).toLowerCase();

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tenant;

  const { rows } = await query(
    `SELECT id, name, ns_domain, status,
            hostname, brand_name, brand_color, logo_url, support_email, support_phone
       FROM tenants
      WHERE lower(hostname) = $1`,
    [key],
  );
  const tenant = rows[0] ?? null;
  cache.set(key, { tenant, at: Date.now() });
  return tenant;
}

// Attaches req.tenant. Express's req.hostname strips the port and, with
// `trust proxy` set to 1, reads the X-Forwarded-Host that Caddy sets. The app
// listens on loopback only, so that header cannot be forged from outside.
export async function resolveTenant(req, _res, next) {
  try {
    req.tenant = await lookupByHostname(req.hostname);
    next();
  } catch (err) {
    next(err);
  }
}

// Guards the customer-facing API. An unknown or suspended hostname gets the
// same answer, so probing cannot enumerate which customers exist.
export function requireTenant(req, res, next) {
  if (!req.tenant || req.tenant.status !== 'active') {
    return res.status(404).json({
      error: 'unknown_portal',
      message: 'This address is not an active portal.',
    });
  }
  next();
}
