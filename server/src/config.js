// Environment loading with fail-fast validation.
// The process refuses to boot on a missing or malformed secret rather than
// starting up and failing later on a live customer request.
import { z } from 'zod';

const blankAsUnset = (v) => (v === '' ? undefined : v);
const optionalText = () => z.preprocess(blankAsUnset, z.string().min(1).optional());
const optionalUrl  = () => z.preprocess(blankAsUnset, z.string().url().optional());

const schema = z.object({
  NODE_ENV:    z.enum(['development', 'production', 'test']).default('production'),
  PORT:        z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Public origin, used for cookie scoping and CORS.
  PORTAL_ORIGIN: z.string().url().default('https://portal.dccurrentny.com'),

  // 32+ random bytes, hex or base64. Rotating this invalidates all sessions.
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

  // --- SkySwitch / NetSapiens ---
  //
  // Optional. The staff console, customer sign-in and branding do not touch
  // SkySwitch at all, so an installation without these credentials still comes
  // up and is usable — only the routing screens report that SkySwitch is not
  // configured yet. Requiring them to boot meant a box could not be stood up
  // until the SkySwitch account existed, which is the wrong order to work in.
  //
  // An unset variable in an EnvironmentFile arrives as an empty string rather
  // than absent, so treat "" as not set.
  NS_BASE_URL:      optionalUrl(),
  NS_CLIENT_ID:     optionalText(),
  NS_CLIENT_SECRET: optionalText(),
  NS_USERNAME:      optionalText(),
  NS_PASSWORD:      optionalText(),
  NS_TIMEOUT_MS:    z.coerce.number().int().positive().default(15000),

  // --- SkySwitch Telco API ---
  //
  // The second SkySwitch server: numbers, routing, e911, porting, billing.
  // Optional for the same reason the PBX settings are, and settable from the
  // console; these let an installation seed them from portal.env instead.
  TELCO_BASE_URL:      optionalUrl(),
  TELCO_AUTH_STYLE:    optionalText(),
  TELCO_TOKEN_PATH:    optionalText(),
  TELCO_SCOPES:        optionalText(),
  TELCO_API_KEY:       optionalText(),
  TELCO_USERNAME:      optionalText(),
  TELCO_PASSWORD:      optionalText(),
  TELCO_CLIENT_ID:     optionalText(),
  TELCO_CLIENT_SECRET: optionalText(),

  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),

  // The staff console answers on exactly this hostname and nowhere else.
  // Leave it unset and the console is simply not served — a safe default for
  // an installation that does not want one exposed.
  ADMIN_HOSTNAME: z.string().min(1).optional(),

  // On by default. The console reaches every customer behind one password, so
  // an operator without a second factor can see the enrolment screen and
  // nothing else. Settable only so a recovery situation is not a redeploy —
  // turning it off is a decision to be made deliberately and put back.
  ADMIN_REQUIRE_2FA: z.enum(['true', 'false']).default('true')
    .transform((v) => v === 'true'),

  // The shared customer portal: one address any customer can sign in to, where
  // the tenant comes from the account rather than the hostname. Customers who
  // want their own address still get one; this is the default door for the
  // rest, so the bare portal domain is not claimed by whoever signs up first.
  SHARED_PORTAL_HOSTNAME: z.string().min(1).optional(),
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

const NS_KEYS = ['NS_BASE_URL', 'NS_CLIENT_ID', 'NS_CLIENT_SECRET', 'NS_USERNAME', 'NS_PASSWORD'];

// Which SkySwitch settings are still missing. Empty means fully configured.
export const missingNsSettings = NS_KEYS.filter((k) => !config[k]);
export const NS_CONFIGURED = missingNsSettings.length === 0;

if (!NS_CONFIGURED) {
  // Not fatal, but it should be impossible to miss in the journal.
  console.warn(
    `SkySwitch is not configured (${missingNsSettings.join(', ')} not set). ` +
    'Sign-in, branding and the staff console work; call-routing screens will ' +
    'report that SkySwitch is not connected. Set these in /etc/portal/portal.env ' +
    'and restart to enable them.',
  );
}
