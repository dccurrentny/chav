#!/usr/bin/env node
// Applies every migrations/*.sql in filename order, inside one transaction.
// Migrations are written idempotently, so re-running is safe.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const url = process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.log('no migrations found');
  }
  await client.query('BEGIN');
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    process.stdout.write(`applying ${file} ... `);
    await client.query(sql);
    console.log('ok');
  }
  await client.query('COMMIT');
  console.log(`\n${files.length} migration(s) applied.`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('\nmigration failed, rolled back:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
