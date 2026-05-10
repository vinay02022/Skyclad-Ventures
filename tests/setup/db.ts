import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { createDbHandle, type DbHandle } from "../../db/client.js";
import { seedDatabase } from "../../db/seed.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://gateway:gateway@localhost:5432/gateway_test";

let cached: DbHandle | undefined;
let unavailableReason: string | undefined;

// Boots a clean test database: ensures it exists, migrates it, truncates
// every table, then re-seeds. Idempotent, callable from any test file's
// beforeAll. Returns the same handle on subsequent calls so tests in the
// same process share a connection pool.
export async function getTestDb(): Promise<DbHandle> {
  if (cached) return cached;

  await ensureTestDatabaseExists(TEST_DATABASE_URL);

  const handle = createDbHandle(TEST_DATABASE_URL, 4);
  await migrate(handle.db, { migrationsFolder: "db/migrations" });
  await truncateAll(handle);
  await seedDatabase(handle.db);

  cached = handle;
  return handle;
}

export async function closeTestDb(): Promise<void> {
  if (cached) {
    await cached.close();
    cached = undefined;
  }
}

// Probe used by test files to skip the suite (with a clear message) when
// Postgres isn't reachable, instead of producing a wall of confusing
// connection-refused stacks.
export async function isTestDbAvailable(): Promise<boolean> {
  if (unavailableReason) return false;
  try {
    await getTestDb();
    return true;
  } catch (err) {
    unavailableReason = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `[tests] DB-dependent suites skipped: cannot reach ${TEST_DATABASE_URL} (${unavailableReason}).`,
    );
    return false;
  }
}

// Connect to the admin 'postgres' database to create the test DB on first
// use. Avoids requiring the developer to remember an extra setup step.
async function ensureTestDatabaseExists(connectionString: string): Promise<void> {
  const target = new URL(connectionString);
  const dbName = target.pathname.slice(1);
  if (!dbName) throw new Error("TEST_DATABASE_URL must include a database name");

  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";

  const adminPool = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    const exists = await adminPool.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      dbName,
    ]);
    if (exists.rowCount === 0) {
      // pg doesn't allow CREATE DATABASE in a parameterized query; the name
      // is taken from a URL we control, so direct interpolation is safe.
      await adminPool.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await adminPool.end();
  }
}

async function truncateAll(handle: DbHandle): Promise<void> {
  await handle.pool.query(`
    TRUNCATE TABLE
      usage_ledger,
      request_logs,
      tenant_provider_allowlists,
      api_keys,
      provider_configs,
      tenants
    RESTART IDENTITY CASCADE
  `);
}
