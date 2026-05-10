import { describe, expect, it } from "vitest";

import { ProviderError } from "../src/modules/providers/errors.js";
import type {
  ProviderAdapter,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderHealth,
  ProviderStreamChunk,
} from "../src/modules/providers/types.js";
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
} from "../src/modules/resilience/circuit-breaker.js";
import { defaultIsRetryable } from "../src/modules/resilience/defaults.js";
import {
  ResilientAdapter,
  withTimeout,
} from "../src/modules/resilience/resilient-adapter.js";
import type { ResilienceConfig } from "../src/modules/resilience/types.js";

// --- A minimal scriptable adapter we control per test -----------------

interface ScriptStep {
  /** undefined = success, otherwise throw this error. */
  err?: ProviderError | Error;
  /** ms to "block" inside complete() before resolving/rejecting. */
  delayMs?: number;
}

class ScriptedAdapter implements ProviderAdapter {
  readonly name: string;
  callCount = 0;
  private readonly script: ScriptStep[];

  constructor(name: string, script: ScriptStep[]) {
    this.name = name;
    this.script = script;
  }

  resolveDefaultModel(): string | null {
    return "scripted-model";
  }

  estimateTokens(): { input_tokens: number } {
    return { input_tokens: 0 };
  }

  async health(): Promise<ProviderHealth> {
    return { healthy: true };
  }

  async complete(req: ProviderChatRequest): Promise<ProviderChatResponse> {
    const idx = this.callCount++;
    const step = this.script[idx] ?? this.script.at(-1);
    if (!step) throw new Error("ScriptedAdapter: empty script");
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    if (step.err) throw step.err;
    return {
      model: req.model,
      message: { role: "assistant", content: "ok" },
      usage: { input_tokens: 0, output_tokens: 1 },
    };
  }

  async *stream(): AsyncIterable<ProviderStreamChunk> {
    throw new Error("not used in resilience tests");
  }
}

const fastConfig = (overrides: Partial<ResilienceConfig> = {}): ResilienceConfig => ({
  timeoutMs: 50,
  retry: {
    maxAttempts: 3,
    delaysMs: [1, 1], // keep tests fast; jitter contributes 0-30% on top
    jitterFactor: 0,
    isRetryable: defaultIsRetryable,
  },
  breaker: { failureThreshold: 5, failureWindowMs: 60_000, openCooldownMs: 30_000 },
  ...overrides,
});

const transient5xx = (provider: string) =>
  new ProviderError("upstream 5xx", { statusCode: 500, retryable: true, providerName: provider });

const clientError = (provider: string) =>
  new ProviderError("bad request", { statusCode: 400, retryable: false, providerName: provider });

// --- ResilientAdapter retry behaviour ---------------------------------

describe("ResilientAdapter retry behaviour", () => {
  it("retries a transient ProviderError and succeeds on a later attempt", async () => {
    const inner = new ScriptedAdapter("openai", [
      { err: transient5xx("openai") },
      { err: transient5xx("openai") },
      {}, // success
    ]);
    const config = fastConfig();
    const breaker = new CircuitBreaker("openai", config.breaker);
    const adapter = new ResilientAdapter(inner, breaker, config);

    const result = await adapter.complete({
      model: "scripted-model",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.message.content).toBe("ok");
    expect(inner.callCount).toBe(3);
    // Two failures recorded, then a success that clears the window.
    expect(breaker.snapshot().failureCount).toBe(0);
    expect(breaker.snapshot().state).toBe("CLOSED");
  });

  it("does NOT retry a non-retryable ProviderError (e.g. 4xx) and surfaces it once", async () => {
    const inner = new ScriptedAdapter("openai", [{ err: clientError("openai") }]);
    const config = fastConfig();
    const breaker = new CircuitBreaker("openai", config.breaker);
    const adapter = new ResilientAdapter(inner, breaker, config);

    await expect(
      adapter.complete({ model: "scripted-model", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ statusCode: 400, retryable: false });

    expect(inner.callCount).toBe(1);
    // Even a 4xx still feeds the breaker — a flood of bad requests against
    // the same upstream still indicates "this provider isn't healthy for us".
    expect(breaker.snapshot().failureCount).toBe(1);
  });

  it("retries up to maxAttempts then throws the last transient error", async () => {
    const inner = new ScriptedAdapter("openai", [
      { err: transient5xx("openai") },
      { err: transient5xx("openai") },
      { err: transient5xx("openai") },
    ]);
    const config = fastConfig();
    const breaker = new CircuitBreaker("openai", config.breaker);
    const adapter = new ResilientAdapter(inner, breaker, config);

    await expect(
      adapter.complete({ model: "scripted-model", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ statusCode: 500, retryable: true });

    // maxAttempts=3 -> exactly three calls, three breaker failures recorded.
    expect(inner.callCount).toBe(3);
    expect(breaker.snapshot().failureCount).toBe(3);
  });
});

// --- Timeout wrapper --------------------------------------------------

describe("withTimeout helper", () => {
  it("resolves when the inner promise finishes before the timeout", async () => {
    const result = await withTimeout(async () => 42, 50, "openai");
    expect(result).toBe(42);
  });

  it("throws ProviderError(504, retryable=true) when the inner promise overshoots", async () => {
    await expect(
      withTimeout(() => new Promise((r) => setTimeout(() => r("late"), 100)), 20, "openai"),
    ).rejects.toMatchObject({
      statusCode: 504,
      retryable: true,
      providerName: "openai",
    });
  });
});

describe("ResilientAdapter timeout integration", () => {
  it("a slow inner.complete() times out, gets classified retryable, and gets retried", async () => {
    // Adapter that always sleeps longer than the timeout. Every attempt
    // hits the timeout wrapper -> 504 retryable. After maxAttempts we
    // bubble the last 504. Proves: timeout -> retry -> exhausted -> throw.
    const inner = new ScriptedAdapter("openai", [
      { delayMs: 100 },
      { delayMs: 100 },
      { delayMs: 100 },
    ]);
    const config = fastConfig({ timeoutMs: 20 });
    const breaker = new CircuitBreaker("openai", config.breaker);
    const adapter = new ResilientAdapter(inner, breaker, config);

    await expect(
      adapter.complete({ model: "scripted-model", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ statusCode: 504, retryable: true });
    expect(inner.callCount).toBe(3);
  });
});

// --- CircuitBreaker state machine --------------------------------------

describe("CircuitBreaker state machine", () => {
  const config = { failureThreshold: 5, failureWindowMs: 60_000, openCooldownMs: 30_000 };

  it("opens after failureThreshold consecutive failures within the window", () => {
    let now = 1_000_000;
    const breaker = new CircuitBreaker("openai", config, () => now);

    for (let i = 0; i < 4; i++) {
      breaker.recordFailure();
      expect(breaker.snapshot().state).toBe("CLOSED");
    }
    breaker.recordFailure(); // 5th -> opens
    expect(breaker.snapshot().state).toBe("OPEN");
    expect(breaker.tryAcquire().allowed).toBe(false);

    void now;
  });

  it("transitions OPEN -> HALF_OPEN after openCooldownMs and lets exactly one probe through", () => {
    let now = 1_000_000;
    const breaker = new CircuitBreaker("openai", config, () => now);

    for (let i = 0; i < 5; i++) breaker.recordFailure();
    expect(breaker.snapshot().state).toBe("OPEN");

    // Mid-cooldown: still OPEN, no probe.
    now += 10_000;
    expect(breaker.tryAcquire().allowed).toBe(false);
    expect(breaker.snapshot().state).toBe("OPEN");

    // Cooldown elapsed: first tryAcquire flips to HALF_OPEN and reserves
    // the probe. A second concurrent caller is rejected.
    now += 25_000;
    const probe = breaker.tryAcquire();
    expect(probe.allowed).toBe(true);
    expect(probe.state).toBe("HALF_OPEN");
    expect(breaker.snapshot().probeInFlight).toBe(true);
    expect(breaker.tryAcquire().allowed).toBe(false);
  });

  it("HALF_OPEN probe success returns the breaker to CLOSED and clears failures", () => {
    let now = 1_000_000;
    const breaker = new CircuitBreaker("openai", config, () => now);
    for (let i = 0; i < 5; i++) breaker.recordFailure();
    now += 31_000;
    breaker.tryAcquire(); // claim the probe
    breaker.recordSuccess();
    expect(breaker.snapshot().state).toBe("CLOSED");
    expect(breaker.snapshot().failureCount).toBe(0);
    expect(breaker.snapshot().probeInFlight).toBe(false);
  });

  it("HALF_OPEN probe failure reopens the breaker and resets the cooldown clock", () => {
    let now = 1_000_000;
    const breaker = new CircuitBreaker("openai", config, () => now);
    for (let i = 0; i < 5; i++) breaker.recordFailure();
    const firstOpenedAt = breaker.snapshot().openedAt;
    expect(firstOpenedAt).not.toBeNull();

    now += 31_000;
    breaker.tryAcquire(); // probe
    breaker.recordFailure();

    expect(breaker.snapshot().state).toBe("OPEN");
    // openedAt should have advanced to the moment the probe failed.
    expect(breaker.snapshot().openedAt).toBeGreaterThan(firstOpenedAt!);
    // Caller is rejected again until the next cooldown elapses.
    expect(breaker.tryAcquire().allowed).toBe(false);
  });
});

// --- Routing integration via the oracle --------------------------------

describe("CircuitBreakerRegistry as ProviderHealthOracle", () => {
  const config = { failureThreshold: 3, failureWindowMs: 60_000, openCooldownMs: 30_000 };

  it("reports a provider unhealthy once its breaker is OPEN, so the router skips it", () => {
    let now = 1_000_000;
    const registry = new CircuitBreakerRegistry(config, () => now);

    // Trip openai's breaker.
    const breaker = registry.for("openai");
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(registry.isHealthy("openai")).toBe(false);

    // anthropic is untouched.
    expect(registry.isHealthy("anthropic")).toBe(true);

    // Unknown providers are healthy until proven otherwise (the routing
    // module already filters by registered-adapter, this is just defensive).
    expect(registry.isHealthy("google")).toBe(true);
  });

  it("recovers to healthy after the cooldown elapses (oracle returns true again)", () => {
    let now = 1_000_000;
    const registry = new CircuitBreakerRegistry(config, () => now);
    const breaker = registry.for("openai");
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(registry.isHealthy("openai")).toBe(false);

    now += 31_000;
    // The oracle's read drives the OPEN -> HALF_OPEN transition; "healthy"
    // is the right answer because the router *should* be allowed to send
    // a probe through.
    expect(registry.isHealthy("openai")).toBe(true);
  });
});

// --- Failover integration through ResilientAdapter --------------------

describe("Failover with ResilientAdapter (chat-handler-shaped scenario)", () => {
  it("first provider exhausts retries and the caller can fall over to a healthy second", async () => {
    // This mirrors what the chat handler does: walk providers in order,
    // each ResilientAdapter retries internally, and on exhaustion the
    // outer loop tries the next candidate.
    const config = fastConfig();
    const breakerOpen = new CircuitBreaker("openai", config.breaker);
    const breakerAnt = new CircuitBreaker("anthropic", config.breaker);
    const openai = new ResilientAdapter(
      new ScriptedAdapter("openai", [
        { err: transient5xx("openai") },
        { err: transient5xx("openai") },
        { err: transient5xx("openai") },
      ]),
      breakerOpen,
      config,
    );
    const anthropic = new ResilientAdapter(
      new ScriptedAdapter("anthropic", [{}]),
      breakerAnt,
      config,
    );

    let response: { provider: string } | undefined;
    for (const adapter of [openai, anthropic]) {
      try {
        const r = await adapter.complete({
          model: "scripted-model",
          messages: [{ role: "user", content: "hi" }],
        });
        response = { provider: adapter.name };
        void r;
        break;
      } catch {
        // continue to next candidate
      }
    }

    expect(response?.provider).toBe("anthropic");
    expect(breakerOpen.snapshot().failureCount).toBe(3);
    expect(breakerAnt.snapshot().state).toBe("CLOSED");
  });

  it("when the first provider's circuit is OPEN, the resilient adapter rejects instantly without calling the inner adapter", async () => {
    const config = fastConfig();
    const breakerOpen = new CircuitBreaker("openai", config.breaker);
    // Force OPEN.
    for (let i = 0; i < config.breaker.failureThreshold; i++) breakerOpen.recordFailure();
    expect(breakerOpen.snapshot().state).toBe("OPEN");

    const inner = new ScriptedAdapter("openai", [{}]);
    const adapter = new ResilientAdapter(inner, breakerOpen, config);

    await expect(
      adapter.complete({ model: "scripted-model", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ statusCode: 503, retryable: true });

    // Circuit short-circuited the call; the inner adapter was never invoked.
    expect(inner.callCount).toBe(0);
  });
});
