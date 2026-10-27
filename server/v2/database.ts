import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';

export interface Database {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(operation: (db: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function connectDatabase(options: { url?: string; localPath?: string; memory?: boolean } = {}): Promise<Database> {
  if (options.url) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: options.url, max: 5 });
    const wrap = (client?: PoolClient): Database => ({
      async query<T>(sql: string, params: unknown[] = []) { return { rows: (await (client ?? pool).query(sql, params)).rows as T[] }; },
      async exec(sql) { return (client ?? pool).query(sql); },
      async transaction(operation) {
        if (client) throw new Error('Nested transaction is not supported');
        const connection = await pool.connect();
        try { await connection.query('BEGIN'); const result = await operation(wrap(connection)); await connection.query('COMMIT'); return result; }
        catch (error) { await connection.query('ROLLBACK'); throw error; }
        finally { connection.release(); }
      },
      async close() { if (!client) await pool.end(); },
    });
    return wrap();
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Production requires DATABASE_URL');
  const { PGlite } = await import('@electric-sql/pglite');
  const directory = options.memory ? undefined : resolve(options.localPath ?? '.local/v2/postgres');
  if (directory) await mkdir(directory, { recursive: true });
  const pg = new PGlite(directory);
  await pg.waitReady;
  const wrap = (connection: Pick<typeof pg, 'query' | 'exec'>, root = false): Database => ({
    async query<T>(sql: string, params: unknown[] = []) { return connection.query<T>(sql, params); },
    async exec(sql) { return connection.exec(sql); },
    async transaction(operation) { if (!root) throw new Error('Nested transaction is not supported'); return pg.transaction(tx => operation(wrap(tx))); },
    async close() { if (root) await pg.close(); },
  });
  return wrap(pg, true);
}

export async function migrate(db: Database) {
  await db.exec('CREATE SCHEMA IF NOT EXISTS quotation_v2; CREATE TABLE IF NOT EXISTS quotation_v2.schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());');
  const names = (await readdir(new URL('./migrations/', import.meta.url))).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const sql = await readFile(new URL(`./migrations/${name}`, import.meta.url), 'utf8');
    const hash = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
    await db.transaction(async tx => {
    await tx.exec('LOCK TABLE quotation_v2.schema_migrations IN EXCLUSIVE MODE');
    const existing = await tx.query<{ sha256: string }>('SELECT sha256 FROM quotation_v2.schema_migrations WHERE name=$1', [name]);
    if (existing.rows.length) {
      if (existing.rows[0].sha256 !== hash) throw new Error(`Migration has changed: ${name}`);
      return;
    }
    await tx.exec(sql);
    await tx.query('INSERT INTO quotation_v2.schema_migrations(name,sha256) VALUES($1,$2)', [name, hash]);
    });
  }
}
