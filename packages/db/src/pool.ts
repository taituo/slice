import { Pool, type PoolClient } from 'pg';

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/slice';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL, max: Number(process.env.PG_POOL_MAX ?? 20) });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Symmetric key for pgcrypto PII columns. In production this comes from a KMS, per data-residency region. */
export function piiKey(): string {
  const key = process.env.PII_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') throw new Error('PII_KEY must be set in production');
    return 'dev-only-pii-key-change-me';
  }
  return key;
}

export function phonePepper(): string {
  return process.env.PHONE_PEPPER ?? 'dev-only-pepper';
}
