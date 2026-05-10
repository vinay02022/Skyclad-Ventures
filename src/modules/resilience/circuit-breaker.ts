import type { ProviderHealthOracle } from "../routing/types.js";
import type {
  BreakerConfig,
  BreakerSnapshot,
  BreakerState,
  ResilienceLogger,
} from "./types.js";

/**
 * One circuit breaker per upstream provider. Sliding-window failure count
 * with a single-probe HALF_OPEN. Time is injectable so tests can drive
 * the state machine without wall-clock sleeps.
 *
 * State machine:
 *
 *     CLOSED --(N failures within window)-->  OPEN
 *      ^                                       |
 *      |                                  cooldown elapsed
 *      |                                       v
 *   HALF_OPEN <--(probe success closes)-- HALF_OPEN
 *      |
 *      +--(probe failure reopens)--> OPEN
 *
 * Why per-provider (not per-tenant, not per-model):
 *   The thing that goes down is the upstream provider. Tenants and models
 *   share that fate; tracking failures per (tenant,model) would dilute the
 *   signal and make recovery slower. One breaker per provider is the
 *   smallest unit that maps cleanly to "upstream is sick".
 */
export class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  /** Timestamps (ms) of recent failures inside the current window. */
  private failureTimes: number[] = [];
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    private readonly providerName: string,
    private readonly config: BreakerConfig,
    private readonly clock: () => number = Date.now,
    private readonly logger?: ResilienceLogger,
  ) {}

  /**
   * Decide whether a caller may proceed. Drives time-based transitions
   * (OPEN -> HALF_OPEN when the cool-down elapses). For HALF_OPEN it
   * reserves the single probe slot; subsequent callers see allowed:false
   * until the probe resolves and recordSuccess/recordFailure runs.
   */
  tryAcquire(): { allowed: boolean; state: BreakerState; reason: string } {
    const now = this.clock();
    this.maybeTransition(now);

    if (this.state === "OPEN") {
      return { allowed: false, state: "OPEN", reason: "circuit_open" };
    }
    if (this.state === "HALF_OPEN") {
      if (this.probeInFlight) {
        return { allowed: false, state: "HALF_OPEN", reason: "half_open_probe_in_flight" };
      }
      this.probeInFlight = true;
      return { allowed: true, state: "HALF_OPEN", reason: "half_open_probe" };
    }
    // CLOSED
    return { allowed: true, state: "CLOSED", reason: "closed" };
  }

  recordSuccess(): void {
    const now = this.clock();
    this.probeInFlight = false;
    if (this.state === "HALF_OPEN") {
      // The probe came back clean -> close.
      this.transitionTo("CLOSED", now);
    }
    // Any success while CLOSED clears the window. Avoids "5 failures spread
    // over 59 seconds with 50 successes between" tripping the breaker.
    this.failureTimes = [];
  }

  recordFailure(): void {
    const now = this.clock();
    this.probeInFlight = false;

    if (this.state === "HALF_OPEN") {
      // The probe failed -> straight back to OPEN. We do NOT add this to
      // the failure window count; the OPEN was earned the first time.
      this.transitionTo("OPEN", now);
      return;
    }

    // Slide the window forward and append.
    const cutoff = now - this.config.failureWindowMs;
    this.failureTimes = this.failureTimes.filter((t) => t > cutoff);
    this.failureTimes.push(now);

    if (this.state === "CLOSED" && this.failureTimes.length >= this.config.failureThreshold) {
      this.transitionTo("OPEN", now);
    }
  }

  /**
   * Read-only check used by ProviderHealthOracle. Drives time-based
   * transitions but does NOT reserve the probe slot — that happens only
   * on tryAcquire(), at the point of an actual call.
   */
  isHealthy(): boolean {
    this.maybeTransition(this.clock());
    return this.state !== "OPEN";
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.state,
      failureCount: this.failureTimes.length,
      openedAt: this.state === "OPEN" || this.state === "HALF_OPEN" ? this.openedAt : null,
      probeInFlight: this.probeInFlight,
    };
  }

  /** Test helper: return to a clean CLOSED breaker. */
  reset(): void {
    this.state = "CLOSED";
    this.failureTimes = [];
    this.openedAt = 0;
    this.probeInFlight = false;
  }

  private maybeTransition(now: number): void {
    if (this.state === "OPEN" && now - this.openedAt >= this.config.openCooldownMs) {
      this.transitionTo("HALF_OPEN", now);
    }
  }

  private transitionTo(next: BreakerState, now: number): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    if (next === "OPEN") this.openedAt = now;
    if (next === "CLOSED") {
      this.failureTimes = [];
      this.openedAt = 0;
    }
    this.logger?.warn(
      {
        provider: this.providerName,
        from_state: previous,
        to_state: next,
        failure_count: this.failureTimes.length,
        opened_at: this.openedAt || null,
      },
      "circuit breaker state change",
    );
  }
}

/**
 * Lazy per-provider breaker registry. Doubles as the ProviderHealthOracle
 * the routing module already consumes, so the router skips OPEN providers
 * with zero changes from Phase 4.
 */
export class CircuitBreakerRegistry implements ProviderHealthOracle {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly config: BreakerConfig,
    private readonly clock: () => number = Date.now,
    private readonly logger?: ResilienceLogger,
  ) {}

  for(providerName: string): CircuitBreaker {
    let b = this.breakers.get(providerName);
    if (!b) {
      b = new CircuitBreaker(providerName, this.config, this.clock, this.logger);
      this.breakers.set(providerName, b);
    }
    return b;
  }

  isHealthy(providerName: string): boolean {
    const b = this.breakers.get(providerName);
    // Unknown provider names are healthy until proven otherwise. The
    // routing module will already have filtered out provider rows whose
    // adapter isn't registered; this is just defensive.
    if (!b) return true;
    return b.isHealthy();
  }

  /** Test helper. Resets every breaker; leaves the registry shape intact. */
  reset(): void {
    for (const b of this.breakers.values()) b.reset();
  }

  snapshot(): Record<string, BreakerSnapshot> {
    const out: Record<string, BreakerSnapshot> = {};
    for (const [name, b] of this.breakers) out[name] = b.snapshot();
    return out;
  }
}
