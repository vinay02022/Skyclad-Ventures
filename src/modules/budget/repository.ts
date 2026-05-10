import { and, eq, gte, lt, sql } from "drizzle-orm";

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

/** A single (provider, model) aggregate row for the admin usage endpoint. */
export interface UsageBreakdownRow {
  provider: string;
  model: string;
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
   * Per-(provider, model) aggregate over a half-open date range
   * [from, to). Used by GET /admin/tenants/:id/usage. The (tenant_id,
   * created_at) index makes this an indexed range scan + a HashAggregate
   * on at most a handful of (provider, model) groups.
   *
   * Half-open range chosen so callers can pass to=tomorrow without
   * worrying about whether they get today's last second. Same convention
   * the standard library uses for date ranges.
   */
  async getUsageBreakdown(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<UsageBreakdownRow[]> {
    const rows = await this.db
      .select({
        provider: usageLedger.provider,
        model: usageLedger.model,
        inputTokens: sql<string>`COALESCE(SUM(${usageLedger.inputTokens}), 0)`,
        outputTokens: sql<string>`COALESCE(SUM(${usageLedger.outputTokens}), 0)`,
        costUsd: sql<string>`COALESCE(SUM(${usageLedger.costUsd}), 0)`,
      })
      .from(usageLedger)
      .where(
        and(
          eq(usageLedger.tenantId, tenantId),
          gte(usageLedger.createdAt, from),
          lt(usageLedger.createdAt, to),
        ),
      )
      .groupBy(usageLedger.provider, usageLedger.model);

    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      costUsd: Number(r.costUsd),
    }));
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
