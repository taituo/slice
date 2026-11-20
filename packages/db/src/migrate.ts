import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { DATABASE_URL } from './pool';

/** Minimal forward-only migrator: creates the database if missing, applies migrations/*.sql in order. */
export async function migrate(url = DATABASE_URL): Promise<string[]> {
  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const adminClient = new Client({ connectionString: admin.toString() });
  await adminClient.connect();
  const exists = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) await adminClient.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
  await adminClient.end();

  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const dir = join(__dirname, '..', 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (done.rowCount) continue;
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
  await client.end();
  return applied;
}

if (require.main === module) {
  migrate()
    .then((applied) => console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Up to date'))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
