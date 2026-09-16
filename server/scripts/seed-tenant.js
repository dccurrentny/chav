#!/usr/bin/env node
// Creates a tenant and its first admin user.
//
//   node scripts/seed-tenant.js "Acme Electric" acme.dccurrentny.com owner@acme.com
//
// The password is generated and printed once. It is never stored in plaintext
// and never logged, so capture it from this output.
import crypto from 'node:crypto';
import pg from 'pg';
import { hash, Algorithm } from '@node-rs/argon2';

const [name, nsDomain, email] = process.argv.slice(2);

if (!name || !nsDomain || !email) {
  console.error('usage: seed-tenant.js "<Tenant Name>" <ns-domain> <admin-email>');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
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
    `INSERT INTO tenants (name, ns_domain) VALUES ($1,$2)
       ON CONFLICT (ns_domain) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name, nsDomain],
  );
  await client.query(
    `INSERT INTO users (tenant_id, email, password_hash, role)
     VALUES ($1,$2,$3,'admin')
       ON CONFLICT (email) DO NOTHING`,
    [tenant.id, email, passwordHash],
  );
  await client.query('COMMIT');

  console.log(`\nTenant:   ${name}  (${nsDomain})`);
  console.log(`Admin:    ${email}`);
  console.log(`Password: ${password}`);
  console.log('\nGive this password to the customer over a channel you trust, then delete it.');
  console.log('It is not recoverable — re-run with a fresh email to issue another.\n');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('seed failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
