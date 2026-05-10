import { defineConfig } from "drizzle-kit";

// Schema and migrations are intentionally minimal in Phase 1.
// Real tables (tenants, api_keys, usage_ledger, request_logs, etc.) land in a later phase.
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://gateway:gateway@localhost:5432/gateway",
  },
  strict: true,
  verbose: true,
});
