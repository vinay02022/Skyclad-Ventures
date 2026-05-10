import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDbHandle } from "./client.js";

// Programmatic migration runner. Both `npm run db:migrate` and the test
// setup call this so there's only one migration code path to reason about.
export async function runMigrations(databaseUrl: string): Promise<void> {
  const handle = createDbHandle(databaseUrl, 2);
  try {
    await migrate(handle.db, { migrationsFolder: "db/migrations" });
  } finally {
    await handle.close();
  }
}

async function runAsScript(): Promise<void> {
  const url =
    process.env.DATABASE_URL ?? "postgres://gateway:gateway@localhost:5432/gateway";
  await runMigrations(url);
  console.log("[migrate] OK");
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("migrate.ts") === true;

if (invokedDirectly) {
  runAsScript().catch((err) => {
    console.error("[migrate] FAILED:", err);
    process.exit(1);
  });
}
