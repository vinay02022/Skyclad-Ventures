import { Counter, Gauge, Histogram, type Registry } from "prom-client";

import type { CircuitBreakerRegistry } from "../resilience/circuit-breaker.js";

/**
 * The seven gateway-level metrics the assignment asks for, all registered
 * against the shared registry from metrics.ts.
 *
 * Cardinality note: tenant_id is a label on several metrics. With two seeded
 * tenants this is harmless; in production this would explode at hundreds-
 * to-thousands of tenants and would need to be dropped from the labels (use
 * logs + an OLAP store for per-tenant breakdowns) or aggressively bucketed.
 * Documented in DESIGN.md.
 *
 * The static counters/histograms are defined once at module load and live
 * for the process lifetime. The breaker-state gauge is a different shape:
 * it derives from the live CircuitBreakerRegistry and is registered via
 * `registerBreakerGauge(registry, breakerRegistry)` from app.ts after the
 * registry exists. The gauge uses prom-client's `collect()` callback so it
 * snapshots the registry on every /metrics scrape — no background job, no
 * out-of-band updater.
 */

export interface GatewayMetrics {
  requests: Counter<"tenant_id" | "provider" | "model" | "status">;
  errors: Counter<"tenant_id" | "provider" | "error_type">;
  latency: Histogram<"provider" | "model">;
  tokens: Counter<"tenant_id" | "provider" | "model" | "token_type">;
  cost: Counter<"tenant_id" | "provider" | "model">;
  cacheHits: Counter<"tenant_id">;
}

/**
 * Build (and register) the static metric series. Returns a typed handle
 * for callers to `.inc(...)` / `.observe(...)`.
 *
 * Memoized per Registry: prom-client throws on duplicate names within the
 * same registry, so the second buildApp() call against the same registry
 * (a thing that happens in test runs) reuses the existing handle. Tests
 * that want a clean slate pass their own Registry instance.
 */
const metricsByRegistry = new WeakMap<Registry, GatewayMetrics>();

export function buildGatewayMetrics(registry: Registry): GatewayMetrics {
  const cached = metricsByRegistry.get(registry);
  if (cached) return cached;
  const built: GatewayMetrics = {
    requests: new Counter({
      name: "gateway_requests_total",
      help: "Total chat completion requests, partitioned by outcome status.",
      labelNames: ["tenant_id", "provider", "model", "status"],
      registers: [registry],
    }),
    errors: new Counter({
      name: "gateway_errors_total",
      help: "Errors surfaced to the caller, partitioned by error_type.",
      labelNames: ["tenant_id", "provider", "error_type"],
      registers: [registry],
    }),
    latency: new Histogram({
      name: "gateway_latency_ms",
      help: "End-to-end provider call latency in milliseconds.",
      labelNames: ["provider", "model"],
      // Bucket boundaries chosen to give actionable resolution at every
      // human-perceptible band: tens-of-ms (warm cache hits if we ever
      // observed those), 100s-of-ms (typical), seconds (slow upstream),
      // 10+ seconds (timeout territory).
      buckets: [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000],
      registers: [registry],
    }),
    tokens: new Counter({
      name: "gateway_tokens_total",
      help: "Tokens consumed, partitioned by token_type (input|output).",
      labelNames: ["tenant_id", "provider", "model", "token_type"],
      registers: [registry],
    }),
    cost: new Counter({
      name: "gateway_cost_usd_total",
      help: "Dollar-cost charged to tenants, partitioned by provider/model.",
      labelNames: ["tenant_id", "provider", "model"],
      registers: [registry],
    }),
    cacheHits: new Counter({
      name: "gateway_cache_hits_total",
      help: "Number of requests served from the deterministic cache.",
      labelNames: ["tenant_id"],
      registers: [registry],
    }),
  };
  metricsByRegistry.set(registry, built);
  return built;
}

/**
 * Register the per-provider circuit breaker state gauge.
 *
 * One time series per (provider, state). At any moment exactly one
 * (provider, state) pair has value 1; the other two for that provider
 * have value 0. This is the prom-client idiom for "what state is X in?"
 * and lets dashboards do `max by (provider) (gateway_provider_circuit_state == 1)`
 * to read the current state.
 *
 * Implemented via prom-client's `collect()` callback so the gauge is
 * snapshot at scrape time. No background polling, no race between writes
 * and reads.
 */
const breakerGaugeByRegistry = new WeakMap<Registry, Gauge<"provider" | "state">>();

export function registerBreakerGauge(
  registry: Registry,
  breakers: CircuitBreakerRegistry,
): Gauge<"provider" | "state"> {
  const cached = breakerGaugeByRegistry.get(registry);
  if (cached) return cached;
  const gauge = new Gauge({
    name: "gateway_provider_circuit_state",
    help: "Per-provider circuit breaker state (1 = current, 0 = other).",
    labelNames: ["provider", "state"],
    registers: [registry],
    collect() {
      // We emit three samples per provider so the dashboard can query
      // for any state directly. Lowercase label values (closed/open/
      // half_open) are the user-facing convention.
      const snap = breakers.snapshot();
      for (const [provider, info] of Object.entries(snap)) {
        const current = info.state.toLowerCase();
        for (const state of ["closed", "open", "half_open"] as const) {
          this.set({ provider, state }, current === state ? 1 : 0);
        }
      }
    },
  });
  breakerGaugeByRegistry.set(registry, gauge);
  return gauge;
}
