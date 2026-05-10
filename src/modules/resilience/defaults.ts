import { ProviderError } from "../providers/errors.js";
import type { BreakerConfig, ResilienceConfig, RetryPolicy } from "./types.js";

/**
 * Default classifier: retry only what the assignment calls "transient".
 *
 * - 5xx provider responses -> retryable (mock encodes as ProviderError(500, retryable=true))
 * - 429 rate-limit         -> retryable (mock encodes as ProviderError(429, retryable=true))
 * - 504 timeout            -> retryable (the timeout wrapper synthesizes this)
 * - circuit_open (503)     -> retryable from the chat handler's perspective
 *                             (failover candidate); the resilient adapter
 *                             does NOT retry inside itself when its own
 *                             circuit is open — that would be silly.
 *
 * Never retried:
 * - 4xx validation/auth errors (a real adapter would mark them retryable=false)
 * - non-ProviderError exceptions (programmer errors; let them surface)
 */
export function defaultIsRetryable(err: unknown): boolean {
  return err instanceof ProviderError && err.retryable;
}

/** Per the assignment: 200ms then 500ms. Exponential-ish, jittered at the call site. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  delaysMs: [200, 500],
  jitterFactor: 0.3,
  isRetryable: defaultIsRetryable,
};

/** Per the assignment: 5 failures in 60s -> open; stay open 30s; one probe in HALF_OPEN. */
export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  failureWindowMs: 60_000,
  openCooldownMs: 30_000,
};

export const DEFAULT_RESILIENCE_CONFIG: ResilienceConfig = {
  timeoutMs: 20_000,
  retry: DEFAULT_RETRY_POLICY,
  breaker: DEFAULT_BREAKER_CONFIG,
};
