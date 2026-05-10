/** Three-state circuit breaker. */
export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

/** Tunables for one CircuitBreaker. */
export interface BreakerConfig {
  /** Failures within failureWindowMs that flip CLOSED -> OPEN. */
  failureThreshold: number;
  /** Sliding window for counting failures, in milliseconds. */
  failureWindowMs: number;
  /** Time to stay OPEN before allowing one HALF_OPEN probe. */
  openCooldownMs: number;
}

/**
 * Retry policy for ResilientAdapter. Kept narrow on purpose: max attempts +
 * an explicit per-attempt delay table + a jitter factor + a predicate that
 * decides whether a thrown error should trigger a retry.
 */
export interface RetryPolicy {
  /** Total attempts including the first. 1 = no retries. */
  maxAttempts: number;
  /**
   * Base delay (ms) before each retry. Index 0 = before retry #1, index 1 =
   * before retry #2, etc. If the array is shorter than maxAttempts-1, the
   * last value is reused for subsequent retries.
   */
  delaysMs: number[];
  /** 0..1. Each delay is jittered by + (delay * jitterFactor * Math.random()). */
  jitterFactor: number;
  /** Returns true iff this error is worth retrying. */
  isRetryable: (err: unknown) => boolean;
}

export interface ResilienceConfig {
  /** Per-call timeout for ProviderAdapter.complete(). 0 disables. */
  timeoutMs: number;
  retry: RetryPolicy;
  breaker: BreakerConfig;
}

/** Minimal pino-shaped logger interface so resilience code stays testable. */
export interface ResilienceLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Snapshot of a single CircuitBreaker; useful for /metrics + tests. */
export interface BreakerSnapshot {
  state: BreakerState;
  failureCount: number;
  openedAt: number | null;
  /** True iff a HALF_OPEN probe is currently in flight. */
  probeInFlight: boolean;
}
