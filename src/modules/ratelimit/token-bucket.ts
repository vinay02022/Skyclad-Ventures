/**
 * Classic token bucket. One bucket per tenant.
 *
 * Capacity = burst size (how many requests the tenant can make in a single
 * instant). Refill rate = tokens added per millisecond. For a "60 requests
 * per minute" config: capacity = 60, refillPerMs = 60 / 60000 = 0.001,
 * which is the steady-state throughput.
 *
 * Time is injectable so tests can advance the clock without sleeping.
 */
export interface TokenBucketOptions {
  capacity: number;
  refillPerMs: number;
  /** Defaults to Date.now. Tests pass a fake. */
  now?: () => number;
}

export interface TokenBucketSnapshot {
  tokens: number;
  capacity: number;
  refillPerMs: number;
}

export interface ConsumeResult {
  allowed: boolean;
  /** Tokens left after this call (0 when rejected). */
  remaining: number;
  /** Milliseconds until enough tokens accumulate to satisfy this request. 0 when allowed. */
  retryAfterMs: number;
}

export class TokenBucket {
  private tokens: number;
  private capacity: number;
  private refillPerMs: number;
  private lastRefillAt: number;
  private readonly now: () => number;

  constructor(opts: TokenBucketOptions) {
    if (opts.capacity <= 0) throw new Error("TokenBucket capacity must be positive");
    if (opts.refillPerMs < 0) throw new Error("TokenBucket refillPerMs must be non-negative");
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerMs;
    // Start full: a tenant should be able to burst up to its limit on the
    // very first request after the process boots.
    this.tokens = opts.capacity;
    this.now = opts.now ?? Date.now;
    this.lastRefillAt = this.now();
  }

  /**
   * Updates capacity / refill rate when the tenant's config changes.
   * Refills first so we don't lose accumulated tokens, then clamps.
   */
  reconfigure(capacity: number, refillPerMs: number): void {
    if (capacity <= 0) throw new Error("TokenBucket capacity must be positive");
    if (refillPerMs < 0) throw new Error("TokenBucket refillPerMs must be non-negative");
    this.refill();
    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
    if (this.tokens > capacity) this.tokens = capacity;
  }

  tryConsume(n = 1): ConsumeResult {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return { allowed: true, remaining: this.tokens, retryAfterMs: 0 };
    }
    const deficit = n - this.tokens;
    const retryAfterMs =
      this.refillPerMs > 0
        ? Math.ceil(deficit / this.refillPerMs)
        : Number.POSITIVE_INFINITY;
    return { allowed: false, remaining: this.tokens, retryAfterMs };
  }

  snapshot(): TokenBucketSnapshot {
    return { tokens: this.tokens, capacity: this.capacity, refillPerMs: this.refillPerMs };
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastRefillAt = now;
    }
  }
}
