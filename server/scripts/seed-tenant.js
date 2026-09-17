#!/usr/bin/env node
// Creates or updates a customer and their first admin user.
//
//   node scripts/seed-tenant.js \
//     --name "Acme Electric" \
//     --ns-domain acme.example.com \
//     --hostname acme.portal.dccurrentny.com \
//     --admin owner@acme.com \
//     [--color '#2F6FED'] [--logo https://…] [--support-email help@acme.com]
//
// The hostname is what the customer types. Point its DNS A record at this
// droplet; Caddy obtains the certificate on first request, because this
// record is what the on-demand TLS gate checks against.
//
// The password is generated and printed once. It is never stored in plaintext
// and never logged, so capture it from this output.
import crypto from 'node:crypto';
import pg from 'pg';
import { hash, Algorithm } from '@node-rs/argon2';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const name         = arg('--name');
const nsDomain     = arg('--ns-domain');
const hostname     = arg('--hostname');
const admin        = arg('--admin');
const color        = arg('--color');
const logo         = arg('--logo');
const supportEmail = arg('--support-email');
const supportPhone = arg('--support-phone');

if (!name || !nsDomain || !hostname || !admin) {
  console.error(`usage: seed-tenant.js --name "<Name>" --ns-domain <d> --hostname <h> --admin <email>
                     [--color '#RRGGBB'] [--logo <url>] [--support-email <e>] [--support-phone <p>]`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
  console.error('--color must be a hex value like #2F6FED');
  process.exit(1);
}

// 18 random bytes -> 24 base64url chars. Long enough that no policy is needed.
const password = crypto.randomBytes(18).toString('base64url');
const passwordHash = await hash(password, {
  algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1,
});

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query('BEGIN');

  const { rows: [tenant] } = await client.query(
    `INSERT INTO tenants (name, ns_domain, hostname, brand_name, brand_color,
                          logo_url, support_email, support_phone)
     VALUES ($1,$2,$3,$1,$4,$5,$6,$7)
       ON CONFLICT (ns_domain) DO UPDATE SET
         name = EXCLUDED.name, hostname = EXCLUDED.hostname,
         brand_name = EXCLUDED.brand_name, brand_color = EXCLUDED.brand_color,
         logo_url = EXCLUDED.logo_url, support_email = EXCLUDED.support_email,
         support_phone = EXCLUDED.support_phone
     RETURNING id`,
    [name, nsDomain, hostname, color ?? null, logo ?? null, supportEmail ?? null, supportPhone ?? null],
  );

  const { rowCount } = await client.query(
    `INSERT INTO users (tenant_id, email, password_hash, role)
     VALUES ($1,$2,$3,'admin')
       ON CONFLICT (email) DO NOTHING`,
    [tenant.id, admin, passwordHash],
  );

  await client.query('COMMIT');

  console.log(`\nCustomer:  ${name}`);
  console.log(`Portal:    https://${hostname}`);
  console.log(`SkySwitch: ${nsDomain}`);
  console.log(`Admin:     ${admin}`);

  if (rowCount === 1) {
    console.log(`Password:  ${password}`);
    console.log('\nGive this password to the customer over a channel you trust, then delete it.');
    console.log('It is not recoverable — re-run with a different --admin to issue another.');
  } else {
    console.log('\nThat admin already existed; their password was left unchanged.');
  }
  console.log(`\nNext: point an A record for ${hostname} at this droplet.`);
  console.log('Caddy obtains the certificate on the first request.\n');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('seed failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
