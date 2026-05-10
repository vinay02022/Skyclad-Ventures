import { eq } from "drizzle-orm";

import type { Database } from "../../../db/client.js";
import { apiKeys, tenantProviderAllowlists, tenants } from "../../../db/schema.js";
import { hashApiKey } from "../auth/hash.js";
import type { AuthenticatedTenant } from "./types.js";

// All tenant reads go through here. Two reasons:
//   1. The auth hot path is one query, indexed on api_keys.key_hash.
//   2. Tests can swap a fake repository in if they want to skip the DB,
//      without monkey-patching modules.
export class TenantRepository {
  constructor(private readonly db: Database) {}

  async findByApiKey(rawKey: string): Promise<AuthenticatedTenant | null> {
    const keyHash = hashApiKey(rawKey);

    const rows = await this.db
      .select({
        id: tenants.id,
        name: tenants.name,
        status: tenants.status,
        monthlyBudgetUsd: tenants.monthlyBudgetUsd,
        rateLimitPerMinute: tenants.rateLimitPerMinute,
        keyStatus: apiKeys.status,
      })
      .from(apiKeys)
      .innerJoin(tenants, eq(apiKeys.tenantId, tenants.id))
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    // A revoked key still exists in the table; it just doesn't authenticate.
    if (row.keyStatus !== "active") return null;

    return {
      id: row.id,
      name: row.name,
      status: row.status as AuthenticatedTenant["status"],
      monthlyBudgetUsd: Number(row.monthlyBudgetUsd),
      rateLimitPerMinute: row.rateLimitPerMinute,
    };
  }

  async getAllowlist(tenantId: string): Promise<string[]> {
    const rows = await this.db
      .select({ provider: tenantProviderAllowlists.provider })
      .from(tenantProviderAllowlists)
      .where(eq(tenantProviderAllowlists.tenantId, tenantId));
    return rows.map((r) => r.provider);
  }

  async getBudgetConfig(
    tenantId: string,
  ): Promise<{ monthlyBudgetUsd: number; rateLimitPerMinute: number } | null> {
    const rows = await this.db
      .select({
        monthlyBudgetUsd: tenants.monthlyBudgetUsd,
        rateLimitPerMinute: tenants.rateLimitPerMinute,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      monthlyBudgetUsd: Number(row.monthlyBudgetUsd),
      rateLimitPerMinute: row.rateLimitPerMinute,
    };
  }
}
