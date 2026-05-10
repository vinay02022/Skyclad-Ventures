import { setTimeout as sleep } from "node:timers/promises";

import { ProviderError } from "../providers/errors.js";
import type {
  ModelClass,
  ProviderAdapter,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderHealth,
  ProviderStreamChunk,
} from "../providers/types.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import type { ResilienceConfig, ResilienceLogger } from "./types.js";

/**
 * Wraps a ProviderAdapter with three resilience controls:
 *
 *   1. Per-call timeout (Promise.race against setTimeout). On expiry:
 *      throw ProviderError(504, retryable=true).
 *   2. Bounded retries on retryable errors only, with backoff + jitter.
 *      The retry loop runs *inside* one external complete() call —
 *      the chat handler still sees a single attempt that either
 *      succeeds or throws. The handler's failover loop then either
 *      moves to the next candidate or returns all_providers_failed.
 *   3. Circuit breaker check before the first attempt: if the breaker
 *      is OPEN, throw circuit_open(503, retryable=true) instantly so
 *      the failover loop rolls over without burning time on a sick
 *      upstream.
 *
 * Implements the same ProviderAdapter interface as the wrapped adapter,
 * so the registry, the router, and the chat handler all stay unchanged.
 */
export class ResilientAdapter implements ProviderAdapter {
  readonly name: string;

  constructor(
    private readonly inner: ProviderAdapter,
    private readonly breaker: CircuitBreaker,
    private readonly config: ResilienceConfig,
    private readonly logger?: ResilienceLogger,
  ) {
    this.name = inner.name;
  }

  resolveDefaultModel(modelClass: ModelClass): string | null {
    return this.inner.resolveDefaultModel(modelClass);
  }

  estimateTokens(req: ProviderChatRequest): { input_tokens: number } {
    return this.inner.estimateTokens(req);
  }

  async health(): Promise<ProviderHealth> {
    if (this.inner.health) return this.inner.health();
    return { healthy: true };
  }

  async complete(req: ProviderChatRequest): Promise<ProviderChatResponse> {
    const acquire = this.breaker.tryAcquire();
    if (!acquire.allowed) {
      // The router already filters OPEN providers via the oracle, but a
      // breaker can flip OPEN between the routing decision and the call.
      // The chat handler treats this as a normal failover trigger.
      throw new ProviderError(`circuit_open for ${this.inner.name}`, {
        statusCode: 503,
        retryable: true,
        providerName: this.inner.name,
      });
    }

    const { maxAttempts } = this.config.retry;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const start = Date.now();
      try {
        const result = await withTimeout(
          () => this.inner.complete(req),
          this.config.timeoutMs,
          this.inner.name,
        );
        this.breaker.recordSuccess();
        if (attempt > 1) {
          this.logger?.info(
            {
              provider: this.inner.name,
              model: req.model,
              attempts: attempt,
              latency_ms: Date.now() - start,
            },
            "provider call succeeded after retry",
          );
        }
        return result;
      } catch (err) {
        lastErr = err;
        const retryable = this.config.retry.isRetryable(err);
        const isLastAttempt = attempt === maxAttempts;

        if (!retryable) {
          // Definite no from upstream (e.g. a 4xx). Don't retry, do count
          // as a failure for the breaker so a flood of 4xx-throwing
          // requests still trips it (a misconfigured tenant beats up an
          // upstream just as much as a sick upstream does).
          this.breaker.recordFailure();
          throw err;
        }

        if (isLastAttempt) {
          this.breaker.recordFailure();
          this.logger?.warn(
            {
              provider: this.inner.name,
              model: req.model,
              attempts: attempt,
              error: errMessage(err),
            },
            "provider call exhausted retries",
          );
          throw err;
        }

        // Mid-loop retry. Each in-loop failure feeds the breaker; a single
        // bad request that retries 3 times against a hot upstream should
        // count as the 3 failures it caused.
        this.breaker.recordFailure();
        const delay = this.computeBackoff(attempt - 1);
        this.logger?.warn(
          {
            provider: this.inner.name,
            model: req.model,
            attempt,
            next_attempt_in_ms: delay,
            error: errMessage(err),
            status_code: err instanceof ProviderError ? err.statusCode : undefined,
          },
          "transient provider error, retrying",
        );
        await sleep(delay);
      }
    }
    // Unreachable; the loop either returns or throws.
    throw lastErr;
  }

  async *stream(req: ProviderChatRequest): AsyncIterable<ProviderStreamChunk> {
    // Streaming has no retries by design (the assignment is explicit:
    // "do not retry after streaming tokens have already been sent").
    // The breaker still applies; a sick upstream shouldn't get to drop
    // every stream attempt before failover kicks in.
    const acquire = this.breaker.tryAcquire();
    if (!acquire.allowed) {
      throw new ProviderError(`circuit_open for ${this.inner.name}`, {
        statusCode: 503,
        retryable: true,
        providerName: this.inner.name,
      });
    }
    let succeeded = false;
    try {
      for await (const chunk of this.inner.stream(req)) {
        if (chunk.type === "done") succeeded = true;
        yield chunk;
      }
    } catch (err) {
      this.breaker.recordFailure();
      throw err;
    }
    if (succeeded) this.breaker.recordSuccess();
  }

  private computeBackoff(retryIndex: number): number {
    const delays = this.config.retry.delaysMs;
    const base = delays[retryIndex] ?? delays.at(-1) ?? 200;
    const jitter = base * this.config.retry.jitterFactor * Math.random();
    return Math.floor(base + jitter);
  }
}

/**
 * Race a promise against a timeout. On expiry: throw a synthesized
 * ProviderError(504, retryable=true) so the rest of the resilience stack
 * can treat the timeout exactly like an upstream 5xx.
 *
 * Note: the underlying adapter is NOT cancelled here. Real adapters that
 * make HTTP calls should accept an AbortSignal and forward it to fetch().
 * For the mock adapter (which just sleeps) the orphan promise is harmless
 * — it resolves eventually and is dropped on the floor. Phase 7 / live
 * adapters can plumb AbortSignal through ProviderChatRequest.
 */
export async function withTimeout<T>(
  factory: () => Promise<T>,
  timeoutMs: number,
  providerName: string,
): Promise<T> {
  if (timeoutMs <= 0) return factory();

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      factory(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ProviderError(`provider call timed out after ${timeoutMs}ms`, {
              statusCode: 504,
              retryable: true,
              providerName,
            }),
          );
        }, timeoutMs);
        // Don't keep the event loop alive just for a timeout we may never need.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
