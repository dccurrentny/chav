import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { config, isProd } from './config.js';
import { logger } from './logger.js';
import { pool } from './db.js';
import { attachSession } from './auth/middleware.js';
import { authRouter } from './auth/routes.js';
import { nsRouter } from './netsapiens/routes.js';
import { auditRouter } from './routes/audit.js';
import { healthRouter } from './routes/health.js';
import { brandingRouter, internalRouter } from './routes/branding.js';
import { impersonateRouter } from './routes/impersonate.js';
import { resolveTenant, requireTenant } from './tenant.js';
import { adminAuthRouter } from './admin/auth.js';
import { adminRouter } from './admin/manage.js';
import { attachStaffSession, requireAdminHost } from './admin/middleware.js';
import { purgeExpiredStaffSessions } from './admin/session.js';
import { purgeExpired } from './auth/session.js';

const app = express();

// Caddy terminates TLS and sets X-Forwarded-*. Trusting exactly one hop keeps
// req.ip honest for rate limiting; trusting all hops would let a client spoof it.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' } }));
app.use(express.json({ limit: '64kb' }));

// Health and the TLS gate are host-agnostic and must answer before any tenant
// is resolved — Caddy asks about hostnames that do not exist yet.
app.use(healthRouter);
app.use(internalRouter);

// The staff console answers on its own hostname only, and is mounted before
// tenant resolution so an operator request is never treated as a customer one.
app.use('/api/admin', requireAdminHost, attachStaffSession, adminAuthRouter);
app.use('/api/admin', requireAdminHost, attachStaffSession, adminRouter);

// Everything below is scoped to the customer whose hostname was used.
app.use(resolveTenant);
app.use(attachSession);

// Redeemed on a customer hostname, so it sits after resolveTenant.
app.use(impersonateRouter);

app.use('/api', brandingRouter);
app.use('/api/auth', authRouter);
app.use('/api/ns', requireTenant, nsRouter);
app.use('/api/audit', requireTenant, auditRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'No such endpoint.' });
});

// Terminal error handler. Never leaks a stack trace or an upstream detail to
// the browser — the log has it, the customer gets a reference to quote.
app.use((err, req, res, _next) => {
  const ref = Math.random().toString(36).slice(2, 10);
  req.log?.error({ err, ref }, 'unhandled error');
  res.status(500).json({
    error: 'server_error',
    message: 'Something went wrong on our side. Nothing was changed.',
    reference: ref,
  });
});

const server = app.listen(config.PORT, '127.0.0.1', () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'portal api listening');
});

// Expired sessions accumulate forever otherwise.
const purgeTimer = setInterval(() => {
  Promise.all([purgeExpired(), purgeExpiredStaffSessions()])
    .then(([a, b]) => (a + b) > 0 && logger.info({ purged: a + b }, 'purged expired sessions'))
    .catch((err) => logger.error({ err }, 'session purge failed'));
}, 60 * 60 * 1000);
purgeTimer.unref();

// Graceful shutdown so a deploy does not cut a customer off mid-write.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    // Don't hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
