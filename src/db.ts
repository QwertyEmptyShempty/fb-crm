import pg from 'pg';
import { cfg } from './config.js';
import { SCHEMA } from './schema.js';

// bigint (chat_id, tg_user_id) приходит из pg строкой — так и оставляем, чтобы не терять точность.
export const pool = new pg.Pool({
  connectionString: cfg.DATABASE_URL,
  ssl: cfg.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, params as any[]);
  return r.rows as T[];
}

export async function q1<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA);
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
