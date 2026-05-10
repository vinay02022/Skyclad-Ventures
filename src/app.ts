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
import { registerAuthHook } from "./modules/auth/hook.js";
import { registerChatRoutes } from "./modules/chat/routes.js";
import { registerObservabilityRoutes } from "./modules/observability/routes.js";
import { buildProviderRegistry } from "./modules/providers/factory.js";
import { PricingRepository } from "./modules/providers/pricing.js";
import type { ProviderRegistry } from "./modules/providers/registry.js";
import { CostOptimizedRoutingPolicy } from "./modules/routing/cost-optimized.js";
import { AlwaysHealthyOracle } from "./modules/routing/health.js";
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
    const providerRegistry = providers ?? buildProviderRegistry({ mode: "mock" });
    const pricingRepo = new PricingRepository(db);
    // Phase 4: route by cost across the tenant allowlist + provider health.
    // AlwaysHealthyOracle is a placeholder until Phase 5's circuit breaker
    // lands; the routing seam stays the same.
    const routingPolicy = policy ?? new CostOptimizedRoutingPolicy();
    const healthOracle = health ?? new AlwaysHealthyOracle();
    await registerChatRoutes(app, {
      providers: providerRegistry,
      pricing: pricingRepo,
      tenants: tenantRepo,
      policy: routingPolicy,
      health: healthOracle,
    });
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
