import { and, eq, gt } from "drizzle-orm";

import type { Database } from "../../../db/client.js";
import { cacheEntries } from "../../../db/schema.js";
import type { CachedResponsePayload } from "./types.js";

export interface CacheSetInput {
  tenantId: string;
  cacheKey: string;
  payload: CachedResponsePayload;
  ttlMs: number;
}

/**
 * Postgres-backed deterministic-response cache.
 *
 * Reads filter by (tenant_id, cache_key) AND expires_at > now() so a stale
 * row never serves a hit. The expires_at comparison is computed in JS from
 * the injected clock (or Date.now by default) so tests can fast-forward
 * "time" without sleeping.
 *
 * Writes are upserts on (tenant_id, cache_key). The composite UNIQUE
 * index in the schema is what makes this safe — without it, repeated
 * writes for the same key would accumulate rows and the get() would
 * become non-deterministic.
 *
 * No background sweeper. Stale rows just sit there. Production would add
 * a periodic DELETE (or a Postgres TTL extension); for assignment scope
 * the read-side filter is sufficient and the storage cost is bounded by
 * the working set.
 */
export class CacheRepository {
  private readonly clock: () => number;

  constructor(private readonly db: Database, clock: () => number = Date.now) {
    this.clock = clock;
  }

  async get(tenantId: string, cacheKey: string): Promise<CachedResponsePayload | null> {
    const now = new Date(this.clock());
    const rows = await this.db
      .select({ responseJson: cacheEntries.responseJson })
      .from(cacheEntries)
      .where(
        and(
          eq(cacheEntries.tenantId, tenantId),
          eq(cacheEntries.cacheKey, cacheKey),
          gt(cacheEntries.expiresAt, now),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // jsonb is returned as a parsed object by node-postgres; the cast
    // narrows from Drizzle's `unknown`.
    return row.responseJson as CachedResponsePayload;
  }

  async set(input: CacheSetInput): Promise<void> {
    const expiresAt = new Date(this.clock() + input.ttlMs);
    await this.db
      .insert(cacheEntries)
      .values({
        tenantId: input.tenantId,
        cacheKey: input.cacheKey,
        responseJson: input.payload,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [cacheEntries.tenantId, cacheEntries.cacheKey],
        set: {
          responseJson: input.payload,
          expiresAt,
        },
      });
  }
}
