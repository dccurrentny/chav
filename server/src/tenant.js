// Resolves which customer a request belongs to from the hostname it arrived on.
//
// This runs before authentication. Every customer gets their own hostname, so
// the hostname is the first thing that scopes a request — an unknown host is
// not a portal at all.
import { query } from './db.js';
import { config } from './config.js';

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
    `SELECT id, name, ns_domain, status, main_extension,
            hostname, brand_name, brand_color, logo_url, support_email, support_phone
       FROM tenants
      WHERE lower(hostname) = $1`,
    [key],
  );
  const tenant = rows[0] ?? null;
  cache.set(key, { tenant, at: Date.now() });
  return tenant;
}

function sameHost(a, b) {
  return Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();
}

/** Is this the shared portal, where the tenant comes from the account? */
export function isSharedPortal(hostname) {
  return sameHost(hostname, config.SHARED_PORTAL_HOSTNAME);
}

/** Hostnames the server owns, which no customer may claim. */
export function isReservedHostname(hostname) {
  return sameHost(hostname, config.SHARED_PORTAL_HOSTNAME) ||
         sameHost(hostname, config.ADMIN_HOSTNAME);
}

// Attaches req.tenant. Express's req.hostname strips the port and, with
// `trust proxy` set to 1, reads the X-Forwarded-Host that Caddy sets. The app
// listens on loopback only, so that header cannot be forged from outside.
//
// On the shared portal there is no tenant yet: it is decided by whoever signs
// in, and from then on it comes from the session.
export async function resolveTenant(req, _res, next) {
  try {
    if (isSharedPortal(req.hostname)) {
      req.sharedPortal = true;
      req.tenant = null;
    } else {
      req.sharedPortal = false;
      req.tenant = await lookupByHostname(req.hostname);
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Guards the customer-facing API. An unknown or suspended hostname gets the
// same answer, so probing cannot enumerate which customers exist.
export function requireTenant(req, res, next) {
  // The shared portal is a valid place to be; which customer it is comes from
  // the session once someone has signed in.
  if (req.sharedPortal) return next();

  if (!req.tenant || req.tenant.status !== 'active') {
    return res.status(404).json({
      error: 'unknown_portal',
      message: 'This address is not an active portal.',
    });
  }
  next();
}
