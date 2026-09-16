import { loadSession, checkCsrf, COOKIE_NAME } from './session.js';

// Parses the session cookie without pulling in cookie-parser: we need exactly
// one cookie and the hand-rolled version has no dependency surface.
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

// Attaches req.session when a valid one exists. Never rejects on its own —
// requireAuth does that, so public routes can share this middleware.
export async function attachSession(req, _res, next) {
  try {
    req.sessionToken = readCookie(req, COOKIE_NAME);
    req.session = await loadSession(req.sessionToken);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req, res, next) {
  if (!req.session) {
    return res.status(401).json({ error: 'not_authenticated', message: 'Sign in to continue.' });
  }
  next();
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.session) {
      return res.status(401).json({ error: 'not_authenticated', message: 'Sign in to continue.' });
    }
    if (role === 'admin' && req.session.role !== 'admin') {
      return res.status(403).json({
        error: 'forbidden',
        message: 'This change needs an administrator on your account.',
      });
    }
    next();
  };
}

// Applied to every state-changing request. GET/HEAD/OPTIONS are exempt because
// they must not change state in the first place.
export function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!checkCsrf(req, req.session)) {
    return res.status(403).json({
      error: 'bad_csrf',
      message: 'Your session expired. Reload the page and try again.',
    });
  }
  next();
}
