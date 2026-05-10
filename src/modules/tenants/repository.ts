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

  /**
   * Phase 11: eval-only helper. Updates `monthly_budget_usd` for one
   * tenant and bumps `updated_at`. Returns the new value, or null if
   * the tenant_id wasn't found.
   *
   * Why this exists: an evaluator wants to demo "tenant_b's $2.00
   * budget gets exhausted, the gateway responds with 402, the
   * operator raises the cap and the next request succeeds" without
   * dropping into psql or waiting for a billing cycle. The auth hook
   * re-reads the tenant on every request, so a budget change takes
   * effect on the very next call.
   *
   * Why this is NOT a production endpoint: budget changes are a
   * billing-affecting operation and need a per-operator audit trail,
   * a justification, an approval workflow, and almost always a
   * limit (max increase per change, max changes per day) — none of
   * which are in scope here. The single shared ADMIN_TOKEN gate is
   * exactly the wrong control surface for that.
   */
  async setBudget(
    tenantId: string,
    monthlyBudgetUsd: number,
  ): Promise<{ monthlyBudgetUsd: number } | null> {
    const updated = await this.db
      .update(tenants)
      .set({
        // numeric column accepts a string; use the same toFixed precision
        // as the seed script to avoid float drift in stored values.
        monthlyBudgetUsd: monthlyBudgetUsd.toFixed(4),
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId))
      .returning({ monthlyBudgetUsd: tenants.monthlyBudgetUsd });
    const row = updated[0];
    if (!row) return null;
    return { monthlyBudgetUsd: Number(row.monthlyBudgetUsd) };
  }
}
