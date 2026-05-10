import { sql } from "drizzle-orm";

import { hashApiKey } from "../src/modules/auth/hash.js";
import { createDbHandle, type Database } from "./client.js";
import {
  apiKeys,
  providerConfigs,
  tenantProviderAllowlists,
  tenants,
} from "./schema.js";
import { SEED_PROVIDERS, SEED_TENANTS } from "./seed-fixtures.js";

// Idempotent. Safe to run repeatedly. Uses ON CONFLICT so re-seeding doesn't
// blow up after the schema has been seeded once. Tests rely on this.
export async function seedDatabase(db: Database): Promise<void> {
  for (const t of SEED_TENANTS) {
    await db
      .insert(tenants)
      .values({
        id: t.id,
        name: t.name,
        status: "active",
        monthlyBudgetUsd: t.monthlyBudgetUsd,
        rateLimitPerMinute: t.rateLimitPerMinute,
      })
      .onConflictDoUpdate({
        target: tenants.id,
        set: {
          name: t.name,
          status: "active",
          monthlyBudgetUsd: t.monthlyBudgetUsd,
          rateLimitPerMinute: t.rateLimitPerMinute,
          updatedAt: sql`now()`,
        },
      });

    await db
      .insert(apiKeys)
      .values({
        tenantId: t.id,
        keyHash: hashApiKey(t.apiKey),
        name: t.apiKeyName,
        status: "active",
      })
      .onConflictDoNothing({ target: apiKeys.keyHash });

    for (const provider of t.allowlist) {
      await db
        .insert(tenantProviderAllowlists)
        .values({ tenantId: t.id, provider })
        .onConflictDoNothing({
          target: [tenantProviderAllowlists.tenantId, tenantProviderAllowlists.provider],
        });
    }
  }

  for (const p of SEED_PROVIDERS) {
    await db
      .insert(providerConfigs)
      .values({
        provider: p.provider,
        model: p.model,
        modelClass: p.modelClass,
        inputCostPer1kTokens: p.inputCostPer1kTokens,
        outputCostPer1kTokens: p.outputCostPer1kTokens,
        enabled: true,
      })
      .onConflictDoUpdate({
        target: [providerConfigs.provider, providerConfigs.model],
        set: {
          modelClass: p.modelClass,
          inputCostPer1kTokens: p.inputCostPer1kTokens,
          outputCostPer1kTokens: p.outputCostPer1kTokens,
          enabled: true,
        },
      });
  }
}

async function runAsScript(): Promise<void> {
  const url =
    process.env.DATABASE_URL ?? "postgres://gateway:gateway@localhost:5432/gateway";
  const handle = createDbHandle(url, 2);
  try {
    await seedDatabase(handle.db);
    console.log("[seed] OK");
    console.log("[seed] tenant_a key:", SEED_TENANTS[0]!.apiKey);
    console.log("[seed] tenant_b key:", SEED_TENANTS[1]!.apiKey);
  } finally {
    await handle.close();
  }
}

// Only execute when invoked directly (`tsx db/seed.ts`).
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("seed.ts") === true;

if (invokedDirectly) {
  runAsScript().catch((err) => {
    console.error("[seed] FAILED:", err);
    process.exit(1);
  });
}
