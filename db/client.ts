import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: Pool;
  close(): Promise<void>;
}

// Factory, not a singleton. Tests need their own pool against a separate test
// DB; the production server creates exactly one and reuses it for the process
// lifetime. Either way, ownership of pool teardown is explicit.
export function createDbHandle(connectionString: string, max = 10): DbHandle {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
