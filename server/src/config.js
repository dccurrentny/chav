// Environment loading with fail-fast validation.
// The process refuses to boot on a missing or malformed secret rather than
// starting up and failing later on a live customer request.
import { z } from 'zod';

const schema = z.object({
  NODE_ENV:    z.enum(['development', 'production', 'test']).default('production'),
  PORT:        z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Public origin, used for cookie scoping and CORS.
  PORTAL_ORIGIN: z.string().url().default('https://portal.dccurrentny.com'),

  // 32+ random bytes, hex or base64. Rotating this invalidates all sessions.
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

  // --- SkySwitch / NetSapiens ---
  NS_BASE_URL:      z.string().url(),
  NS_CLIENT_ID:     z.string().min(1),
  NS_CLIENT_SECRET: z.string().min(1),
  NS_USERNAME:      z.string().min(1),
  NS_PASSWORD:      z.string().min(1),
  NS_TIMEOUT_MS:    z.coerce.number().int().positive().default(15000),

  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  LOG_LEVEL:         z.enum(['fatal','error','warn','info','debug','trace']).default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
export const isProd = config.NODE_ENV === 'production';
