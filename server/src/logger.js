import pino from 'pino';
import { config } from './config.js';

// Values that must never reach a log line, at any nesting depth.
const REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'password',
  '*.password',
  'password_hash',
  '*.password_hash',
  'access_token',
  '*.access_token',
  'refresh_token',
  '*.refresh_token',
  'client_secret',
  '*.client_secret',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: REDACT, censor: '[redacted]' },
});
