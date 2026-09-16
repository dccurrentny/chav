import express from 'express';
import { query } from '../db.js';

export const healthRouter = express.Router();

// Liveness: is the process up? Deliberately does not touch Postgres, so a
// database blip does not make the deploy health-gate kill a good release.
healthRouter.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

// Readiness: can we actually serve traffic? This is what the deploy gate and
// your uptime monitor should watch.
healthRouter.get('/readyz', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch {
    res.status(503).json({ ok: false, db: 'down' });
  }
});
