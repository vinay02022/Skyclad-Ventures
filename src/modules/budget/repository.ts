import { and, eq, gte, sql } from "drizzle-orm";

import type { Database } from "../../../db/client.js";
import { usageLedger } from "../../../db/schema.js";

/** One row about to be written to usage_ledger. */
export interface UsageEntry {
  tenantId: string;
  provider: string;
  model: string;
  requestId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Owns every read and write on `usage_ledger`.
 *
 * The ledger is the *source of truth* for what a tenant has spent. The
 * budget gate sums it; nothing else maintains a parallel "spent so far"
 * counter. That keeps the durable accounting honest even after a process
 * restart or a redeploy mid-month.
 */
export class UsageLedgerRepository {
  constructor(private readonly db: Database) {}

  /**
   * Returns total dollars spent by this tenant in the current calendar
   * month (UTC). Empty ledger -> 0.
   *
   * The (tenant_id, created_at) index in the schema makes this a single
   * indexed range scan; per-request cost is well within budget for the
   * assignment scope (see Phase 5 docs for the production-scale fix).
   */
  async getCurrentMonthSpend(tenantId: string): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(${usageLedger.costUsd}), 0)`,
      })
      .from(usageLedger)
      .where(
        and(
          eq(usageLedger.tenantId, tenantId),
          gte(usageLedger.createdAt, sql`date_trunc('month', now() AT TIME ZONE 'UTC')`),
        ),
      );

    // numeric() comes back as a string from node-postgres to preserve precision.
    // Convert at the boundary; downstream arithmetic uses regular numbers.
    return rows[0] ? Number(rows[0].total) : 0;
  }

  /**
   * Append-only insert of a usage row. Called after a successful provider
   * response. We never UPDATE a ledger row — corrections go through a new
   * compensating row, which preserves auditability.
   */
  async recordUsage(entry: UsageEntry): Promise<void> {
    await this.db.insert(usageLedger).values({
      tenantId: entry.tenantId,
      provider: entry.provider,
      model: entry.model,
      requestId: entry.requestId,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      // numeric column accepts a string; this avoids float -> string drift.
      costUsd: entry.costUsd.toFixed(6),
    });
  }
}
