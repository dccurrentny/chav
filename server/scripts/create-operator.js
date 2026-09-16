#!/usr/bin/env node
// Creates a staff operator for the admin console.
//
//   node scripts/create-operator.js --email you@dccurrentny.com --name "Aron" --owner
//
// Run once at setup to create the first owner. After that, operators are
// added through the console itself.
import crypto from 'node:crypto';
import pg from 'pg';
import { hash, Algorithm } from '@node-rs/argon2';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const email = arg('--email');
const name  = arg('--name');
const role  = process.argv.includes('--owner') ? 'owner' : 'operator';

if (!email || !name) {
  console.error('usage: create-operator.js --email <email> --name "<name>" [--owner]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const password = crypto.randomBytes(18).toString('base64url');
const passwordHash = await hash(password, {
  algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1,
});

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const { rowCount } = await client.query(
    `INSERT INTO staff (email, name, password_hash, role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO NOTHING`,
    [email, name, passwordHash, role],
  );
  if (rowCount === 0) {
    console.log(`\n${email} is already an operator; nothing changed.\n`);
  } else {
    console.log(`\nOperator: ${name} <${email}>`);
    console.log(`Role:     ${role}`);
    console.log(`Password: ${password}`);
    console.log('\nSign in at https://<ADMIN_HOSTNAME>. Capture this password now —');
    console.log('it is not stored in the clear and cannot be shown again.\n');
  }
} catch (err) {
  console.error('failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
