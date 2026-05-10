import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type { Database } from "../db/client.js";
import type { AppConfig } from "./config.js";
import { registerAdminRoutes } from "./modules/admin/routes.js";
import { registerAuthHook } from "./modules/auth/hook.js";
import { UsageLedgerRepository } from "./modules/budget/repository.js";
import { DEFAULT_CACHE_CONFIG } from "./modules/cache/defaults.js";
import { CacheRepository } from "./modules/cache/repository.js";
import type { CacheConfig } from "./modules/cache/types.js";
import { registerChatRoutes } from "./modules/chat/routes.js";
import {
  buildGatewayMetrics,
  registerBreakerGauge,
  type GatewayMetrics,
} from "./modules/observability/gateway-metrics.js";
import { registry as defaultMetricsRegistry } from "./modules/observability/metrics.js";
import { registerObservabilityRoutes } from "./modules/observability/routes.js";
import { RequestLogRepository } from "./modules/persistence/request-logs-repo.js";
import { buildProviderRegistry } from "./modules/providers/factory.js";
import { PricingRepository } from "./modules/providers/pricing.js";
import type { ProviderRegistry } from "./modules/providers/registry.js";
import { InMemoryRateLimiter, type RateLimiter } from "./modules/ratelimit/rate-limiter.js";
import { CircuitBreakerRegistry } from "./modules/resilience/circuit-breaker.js";
import { DEFAULT_RESILIENCE_CONFIG } from "./modules/resilience/defaults.js";
import { buildResilientRegistry } from "./modules/resilience/factory.js";
import type { ResilienceConfig, ResilienceLogger } from "./modules/resilience/types.js";
import { CostOptimizedRoutingPolicy } from "./modules/routing/cost-optimized.js";
import type { ProviderHealthOracle, RoutingPolicy } from "./modules/routing/types.js";
import { TenantRepository } from "./modules/tenants/repository.js";
import { registerTenantRoutes } from "./modules/tenants/routes.js";

export interface BuildAppOptions {
  config: AppConfig;
  logger: Logger;
  // Optional so the lightweight Phase 1 health/metrics test can still build
  // an app without spinning up a Postgres connection. Any /v1 functionality
  // requires a db.
  db?: Database;
  // Tests can pass in their own registry (e.g. with always-failing adapters).
  // Production code lets buildApp construct a default mock registry below.
  providers?: ProviderRegistry;
  // Tests / future callers can swap in a different routing policy or health
  // oracle. Defaults below are good for local + assignment scope.
  policy?: RoutingPolicy;
  health?: ProviderHealthOracle;
  // Tests inject their own to call .reset() between cases. Production lets
  // buildApp construct a fresh single-node InMemoryRateLimiter.
  rateLimiter?: RateLimiter;
  // Tests inject to read ledger writes back. Production constructs from db.
  usageLedger?: UsageLedgerRepository;
  // Phase 6 resilience controls. Test-only escape hatches:
  //   - resilience: shorten retries / disable timeout / loosen breaker for
  //     suites whose subject isn't resilience itself.
  //   - breakers:   inject a fresh registry tests can .reset() between cases.
  // Production uses the defaults below (20s timeout, 3 attempts with
  // 200/500ms backoff + jitter, breaker opens after 5 failures in 60s).
  resilience?: ResilienceConfig;
  breakers?: CircuitBreakerRegistry;
  // Phase 7: deterministic-response cache. Tests inject their own repo
  // (with a fake clock) to test TTL expiry without sleeping, and override
  // ttlMs/enabled to bypass the cache when the test is about something
  // else. Production uses the default 5-minute TTL.
  cache?: CacheRepository;
  cacheConfig?: CacheConfig;
  // Phase 8: request_logs writer. Tests inject the same repo they read
  // back to assert request_logs rows materialized for every terminal.
  requestLogs?: RequestLogRepository;
  // Phase 9: Prometheus counters/histograms. Tests inject a fresh
  // registry+metrics so /metrics assertions don't see process-global
  // pollution from sibling tests. Production lets buildApp build them
  // against the shared default registry.
  metrics?: GatewayMetrics;
}

// App builder is separated from the listener so tests can use `app.inject(...)`
// without binding a real port.
export async function buildApp({
  config,
  logger,
  db,
  providers,
  policy,
  health,
  rateLimiter,
  usageLedger,
  resilience,
  breakers,
  cache,
  cacheConfig,
  requestLogs,
  metrics,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // Pino's Logger is structurally compatible with FastifyBaseLogger at runtime;
    // the cast bridges a small declared-type gap (msgPrefix) without dragging
    // Fastify types into the rest of the app.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    disableRequestLogging: false,
    // Trust an inbound x-request-id if present, otherwise mint one. This is the
    // correlation ID surfaced in logs, metrics labels, and (later) request_logs rows.
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128) {
        return incoming;
      }
      return randomUUID();
    },
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "request_id",
    bodyLimit: 1024 * 1024, // 1 MB; LLM prompts can be large but a hard cap prevents abuse.
  });

  // Echo the request id back so clients can correlate.
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "skyclad-gateway",
    env: config.NODE_ENV,
    uptime_s: Math.round(process.uptime()),
  }));

  await registerObservabilityRoutes(app);

  // /v1 surface is only mounted when a database is supplied. Without it, auth
  // can't run and there's no honest way to serve a tenant request.
  if (db) {
    const tenantRepo = new TenantRepository(db);
    registerAuthHook(app, tenantRepo);
    await registerTenantRoutes(app, tenantRepo);

    // Phase 3: chat completions. Default to the mock-mode registry so a
    // fresh clone runs end-to-end without OpenAI/Anthropic API keys.
    const baseRegistry = providers ?? buildProviderRegistry({ mode: "mock" });
    const pricingRepo = new PricingRepository(db);
    // Phase 6: every adapter in the registry is wrapped with a
    // ResilientAdapter (timeout + retry + circuit breaker). Wrapping
    // happens at the registry level so the chat handler / routing module
    // stay unchanged. The CircuitBreakerRegistry doubles as the
    // ProviderHealthOracle the router consumes — when a breaker is OPEN,
    // the router skips the provider entirely.
    const resilienceConfig = resilience ?? DEFAULT_RESILIENCE_CONFIG;
    const resilienceLogger: ResilienceLogger = {
      info: (obj, msg) => logger.info(obj, msg),
      warn: (obj, msg) => logger.warn(obj, msg),
    };
    const breakerReg =
      breakers ?? new CircuitBreakerRegistry(resilienceConfig.breaker, Date.now, resilienceLogger);
    const providerRegistry = buildResilientRegistry({
      inner: baseRegistry,
      breakers: breakerReg,
      config: resilienceConfig,
      logger: resilienceLogger,
    });
    // Phase 4: route by cost across the tenant allowlist + provider health.
    // The breaker registry IS the health oracle; OPEN providers get filtered
    // out by the router with no further wiring.
    const routingPolicy = policy ?? new CostOptimizedRoutingPolicy();
    const healthOracle = health ?? breakerReg;
    // Phase 5: per-tenant rate limit (in-memory) + budget ledger (Postgres).
    // Both are isolated per tenant_id; a tenant exhausting either rejects
    // only that tenant.
    const limiter = rateLimiter ?? new InMemoryRateLimiter();
    const ledgerRepo = usageLedger ?? new UsageLedgerRepository(db);
    // Phase 7: deterministic-response cache, Postgres-backed. The handler
    // checks it AFTER the routing decision so the cache key reflects the
    // provider/model the router would have called, and skips both lookup
    // and write for streaming or temperature > 0.
    const cacheRepo = cache ?? new CacheRepository(db);
    const cacheCfg = cacheConfig ?? DEFAULT_CACHE_CONFIG;
    // Phase 8/9: request_logs writes for every terminal (streaming and
    // non-streaming alike). The recordRequestOutcome helper in
    // observability/outcome.ts is the single call site that writes a
    // row + updates Prometheus counters + emits the structured log line.
    const requestLogsRepo = requestLogs ?? new RequestLogRepository(db);
    // Phase 9: gateway-level Prometheus metrics. We register the seven
    // static series against the shared default registry and additionally
    // register the per-provider breaker-state gauge whose collect()
    // callback snapshots breakerReg at scrape time.
    const gatewayMetrics = metrics ?? buildGatewayMetrics(defaultMetricsRegistry);
    if (!metrics) {
      // Only register the breaker gauge against the default registry when
      // we own it; tests pass their own metrics+registry and wire the
      // gauge themselves if they care.
      registerBreakerGauge(defaultMetricsRegistry, breakerReg);
    }
    await registerChatRoutes(app, {
      providers: providerRegistry,
      pricing: pricingRepo,
      tenants: tenantRepo,
      policy: routingPolicy,
      health: healthOracle,
      rateLimiter: limiter,
      usageLedger: ledgerRepo,
      cache: cacheRepo,
      cacheConfig: cacheCfg,
      requestLogs: requestLogsRepo,
      metrics: gatewayMetrics,
    });

    // Phase 9: admin surface, mounted only when ADMIN_TOKEN is non-empty.
    // Empty/unset = endpoint not registered, so a misconfigured deploy
    // returns 404 to anyone who probes /admin/* — fail closed.
    if (config.ADMIN_TOKEN) {
      await registerAdminRoutes(app, {
        usageLedger: ledgerRepo,
        adminToken: config.ADMIN_TOKEN,
      });
    }
  }

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: "not_found", path: req.url });
  });

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    req.log.error({ err }, "unhandled error");
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({
      error: status === 500 ? "internal_error" : err.name,
      message: status === 500 ? "Internal server error" : err.message,
      request_id: req.id,
    });
  });

  return app;
}
