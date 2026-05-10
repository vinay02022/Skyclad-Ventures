import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

// Single shared pool per process. Created lazily so test runs that don't touch
// the DB don't pay the connection cost or fail when Postgres isn't running.
let pool: Pool | undefined;
let db: Database | undefined;

export function getPool(connectionString: string, overrides: PoolConfig = {}): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      ...overrides,
    });
  }
  return pool;
}

export function getDb(connectionString: string): Database {
  if (!db) {
    db = drizzle(getPool(connectionString), { schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    db = undefined;
  }
}
