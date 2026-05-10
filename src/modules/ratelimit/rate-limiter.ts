import { TokenBucket } from "./token-bucket.js";

export interface RateLimitResult {
  allowed: boolean;
  /** Tokens left in this tenant's bucket after the call. */
  remaining: number;
  /** Configured per-minute capacity (= burst size). */
  capacity: number;
  /** ms to wait before the request would be allowed; 0 when allowed. */
  retryAfterMs: number;
}

/**
 * Pluggable interface so a future RedisRateLimiter (or a fake in tests) can
 * swap in without touching the chat handler.
 */
export interface RateLimiter {
  /**
   * Charge one token against the tenant's bucket, sized by their per-minute
   * limit. The limit is passed in (not stored) because the source of truth
   * for tenant config is Postgres, not this in-memory map.
   */
  checkPerMinute(tenantId: string, requestsPerMinute: number): RateLimitResult;
  /** Test helper: drop every bucket. */
  reset(): void;
}

/**
 * Single-node, in-memory token-bucket limiter. One bucket per tenant_id.
 *
 * Design choices, all deliberate for assignment scope:
 *
 * - **In-memory.** Rate-limit counters are short-lived runtime state;
 *   losing them on a restart costs at most one minute of looser limits.
 *   Postgres-as-counter is the wrong tool — it would put a write in the
 *   hot path of *every* request just to read it back microseconds later.
 *   Redis is the right tool at >1 node, but the assignment is explicit:
 *   no Redis, no distributed limiting. See DESIGN.md for the production
 *   evolution path.
 *
 * - **Capacity comes from Postgres.** Every call passes in
 *   `requestsPerMinute` from `tenants.rate_limit_per_minute`, surfaced
 *   on `req.tenant` by the auth hook. The limiter does not hold tenant
 *   config; it just sizes (or resizes) the bucket on demand.
 *
 * - **Buckets are lazy.** Created on first request, never garbage-collected.
 *   Acceptable for a finite tenant set. A real impl would expire idle
 *   buckets on a timer.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  checkPerMinute(tenantId: string, requestsPerMinute: number): RateLimitResult {
    const capacity = Math.max(1, Math.floor(requestsPerMinute));
    const refillPerMs = capacity / 60_000;

    let bucket = this.buckets.get(tenantId);
    if (!bucket) {
      bucket = new TokenBucket({ capacity, refillPerMs, now: this.now });
      this.buckets.set(tenantId, bucket);
    } else {
      // Tenant config can change at any time; resize the bucket instead of
      // tearing it down (preserves whatever fairness was in flight).
      const snap = bucket.snapshot();
      const refillDrift = Math.abs(snap.refillPerMs - refillPerMs);
      if (snap.capacity !== capacity || refillDrift > 1e-9) {
        bucket.reconfigure(capacity, refillPerMs);
      }
    }

    const consumed = bucket.tryConsume(1);
    return {
      allowed: consumed.allowed,
      remaining: consumed.remaining,
      capacity,
      retryAfterMs: consumed.retryAfterMs,
    };
  }

  reset(): void {
    this.buckets.clear();
  }
}
