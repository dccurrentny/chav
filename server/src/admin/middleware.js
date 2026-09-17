import { loadStaffSession, checkStaffCsrf, ADMIN_COOKIE } from './session.js';
import { statusFor } from './mfa.js';
import { config } from '../config.js';

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

// The console answers on exactly one hostname and nowhere else. A customer's
// portal must never be able to reach an admin endpoint, even with a stolen
// operator cookie — and cookies are host-only, so this holds twice over.
export function requireAdminHost(req, res, next) {
  if (!config.ADMIN_HOSTNAME || req.hostname.toLowerCase() !== config.ADMIN_HOSTNAME.toLowerCase()) {
    return res.status(404).json({ error: 'not_found', message: 'No such endpoint.' });
  }
  next();
}

export async function attachStaffSession(req, _res, next) {
  try {
    req.staffToken = readCookie(req, ADMIN_COOKIE);
    req.staff = await loadStaffSession(req.staffToken);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireStaff(req, res, next) {
  if (!req.staff) {
    return res.status(401).json({ error: 'not_authenticated', message: 'Sign in to continue.' });
  }
  next();
}

// Only an owner may create or disable other operators. Stops a compromised
// operator account from minting itself persistence.
export function requireOwner(req, res, next) {
  if (!req.staff) {
    return res.status(401).json({ error: 'not_authenticated', message: 'Sign in to continue.' });
  }
  if (req.staff.role !== 'owner') {
    return res.status(403).json({ error: 'forbidden', message: 'Only an owner can manage operators.' });
  }
  next();
}

export function requireStaffCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!checkStaffCsrf(req, req.staff)) {
    return res.status(403).json({ error: 'bad_csrf', message: 'Your session expired. Reload and try again.' });
  }
  next();
}

/**
 * An operator with no second factor can enrol, and do nothing else.
 *
 * Applied to the management routes rather than to sign-in, so the endpoints
 * needed to GET here and to set an authenticator up stay reachable. Mounted
 * after requireStaff, so req.staff exists.
 *
 * Fails CLOSED. If the check itself errors, the answer is no — an operator
 * locked out by a database blip is recoverable, a console open to a password
 * alone because a query failed is not.
 */
export async function requireSecondFactor(req, res, next) {
  if (!config.ADMIN_REQUIRE_2FA) return next();
  try {
    const { enabled } = await statusFor(req.staff.staff_id);
    if (enabled) return next();
    res.status(403).json({
      error: 'mfa_required',
      message: 'Set up an authenticator app before using the console. '
             + 'It reaches every customer, so a password on its own is not enough.',
    });
  } catch (err) {
    next(err);
  }
}
