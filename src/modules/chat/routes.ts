import type { FastifyInstance, FastifyRequest } from "fastify";

import type { UsageLedgerRepository } from "../budget/repository.js";
import { buildCacheKey } from "../cache/key.js";
import { isCacheable } from "../cache/policy.js";
import type { CacheRepository } from "../cache/repository.js";
import type { CacheConfig, CachedResponsePayload } from "../cache/types.js";
import type { GatewayMetrics } from "../observability/gateway-metrics.js";
import { recordRequestOutcome } from "../observability/outcome.js";
import type { RequestLogRepository } from "../persistence/request-logs-repo.js";
import { ProviderError } from "../providers/errors.js";
import { parseFailureInjection } from "../providers/failure-injection.js";
import { calculateCost, PricingRepository } from "../providers/pricing.js";
import { estimateMessagesTokens } from "../providers/tokens.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type {
  ProviderChatRequest,
  UnifiedChatResponse,
} from "../providers/types.js";
import type { RateLimiter } from "../ratelimit/rate-limiter.js";
import type {
  ProviderHealthOracle,
  RouteCandidate,
  RoutingDecision,
  RoutingPolicy,
} from "../routing/types.js";
import { streamChatCompletion } from "../streaming/handler.js";
import type { TenantRepository } from "../tenants/repository.js";
import { ChatRequestSchema, type ParsedChatRequest } from "./validation.js";

export interface RegisterChatRoutesDeps {
  providers: ProviderRegistry;
  pricing: PricingRepository;
  tenants: TenantRepository;
  policy: RoutingPolicy;
  health: ProviderHealthOracle;
  rateLimiter: RateLimiter;
  usageLedger: UsageLedgerRepository;
  cache: CacheRepository;
  cacheConfig: CacheConfig;
  requestLogs: RequestLogRepository;
  metrics: GatewayMetrics;
}

/**
 * The single chat endpoint. Flow:
 *
 *   1. Auth (already done by the auth hook; we re-check defensively).
 *   2. Validate the body via Zod.
 *   3. Rate-limit gate (Phase 5): in-memory token bucket per tenant. Sized
 *      from `tenants.rate_limit_per_minute`. 429 if exhausted.
 *   4. Budget gate (Phase 5): SUM(cost_usd) over current month from
 *      usage_ledger (the source of truth). 402 if at or above
 *      `tenants.monthly_budget_usd`.
 *   5. Resolve a routing decision:
 *        - body.provider set       -> debug override path: caller pins one
 *                                     provider, no failover.
 *        - body.provider not set   -> ask the routing policy. Policy returns
 *                                     a primary candidate plus an ordered
 *                                     fallback list (cheap -> expensive).
 *   6. Cache lookup (Phase 7): if the request is deterministic and not
 *      streaming, build a tenant-scoped SHA-256 key over the SELECTED
 *      provider/model and the normalized request. On hit, return the
 *      cached response with cached:true, cost_usd:0, no provider call,
 *      no usage_ledger write. On miss, fall through to the failover loop.
 *   7. Walk candidates in order. On a retryable ProviderError, try the next
 *      one. On a non-retryable error, bail with 502. Stop on first success.
 *   8. Append a usage_ledger row reflecting the actual cost charged
 *      (post-success accounting; see DESIGN.md for the documented race
 *      under high concurrency).
 *   9. Cache write: if the request was cacheable, store the successful
 *      response keyed by the provider that ACTUALLY answered (which may
 *      not be the originally selected one if a fallback ran).
 *  10. Normalize and respond.
 *
 * Streaming still returns 501 — SSE lands in a later phase.
 */
export async function registerChatRoutes(
  app: FastifyInstance,
  deps: RegisterChatRoutesDeps,
): Promise<void> {
  app.post("/v1/chat/completions", async (req, reply) => {
    const requestStart = Date.now();
    const tenant = req.tenant;
    if (!tenant) {
      // Auth-failed requests are logged by the auth hook itself; we do
      // NOT write a request_logs row here because we have no validated
      // tenant_id (which we need for ledger correlation). Rate-limited
      // and budget-exceeded requests, by contrast, do have a tenant.
      return reply.code(401).send({ error: "unauthorized", request_id: req.id });
    }

    // ---- 1. Validate ---------------------------------------------------
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      await recordRequestOutcome(
        { requestLogs: deps.requestLogs, metrics: deps.metrics, log: req.log },
        {
          requestId: req.id,
          tenantId: tenant.id,
          provider: null,
          model: null,
          modelClass: null,
          routePolicy: null,
          routingReason: null,
          cacheHit: false,
          streaming: false,
          latencyMs: Date.now() - requestStart,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          status: "invalid_request",
          errorType: "schema_validation_failed",
        },
      );
      return reply.code(400).send({
        error: "invalid_request",
        message: "Request body failed validation.",
        details: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
        request_id: req.id,
      });
    }
    const body = parsed.data;

    // Streaming requests follow the same gates and routing as non-streaming
    // ones; the SSE wire format and partial-failure handling live in the
    // dedicated streaming handler. We don't branch here — we branch after
    // the routing decision, so the streaming path inherits failover.

    // ---- 2. Rate-limit gate ------------------------------------------
    // Cheapest reject path: a single in-memory map lookup + arithmetic. No
    // I/O. Sized from tenants.rate_limit_per_minute, which the auth hook
    // already loaded onto req.tenant from Postgres. Per-tenant bucket; one
    // tenant's burst cannot drain another's.
    const rate = deps.rateLimiter.checkPerMinute(tenant.id, tenant.rateLimitPerMinute);
    if (!rate.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(rate.retryAfterMs / 1000));
      reply.header("Retry-After", retryAfterSec.toString());
      reply.header("X-RateLimit-Limit", rate.capacity.toString());
      reply.header("X-RateLimit-Remaining", "0");
      req.log.warn(
        {
          tenant_id: tenant.id,
          rate_limit_per_minute: rate.capacity,
          retry_after_ms: rate.retryAfterMs,
        },
        "tenant rate limited",
      );
      await recordRequestOutcome(
        { requestLogs: deps.requestLogs, metrics: deps.metrics, log: req.log },
        {
          requestId: req.id,
          tenantId: tenant.id,
          provider: null,
          model: null,
          modelClass: body.model_class,
          routePolicy: null,
          routingReason: null,
          cacheHit: false,
          streaming: body.stream,
          latencyMs: Date.now() - requestStart,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          status: "rate_limited",
          errorType: "TENANT_RATE_LIMITED",
        },
      );
      return reply.code(429).send({
        error: "TENANT_RATE_LIMITED",
        message: `Rate limit of ${rate.capacity} req/min exceeded for this tenant.`,
        retry_after_ms: rate.retryAfterMs,
        request_id: req.id,
      });
    }
    reply.header("X-RateLimit-Limit", rate.capacity.toString());
    reply.header("X-RateLimit-Remaining", Math.floor(rate.remaining).toString());

    // ---- 3. Budget gate ----------------------------------------------
    // SUM over usage_ledger (the source of truth) for the current calendar
    // month. Documented race: between this read and the post-call ledger
    // write, concurrent requests for the same tenant can each see "spend <
    // budget" and slightly overspend. Acceptable for the assignment scope;
    // production would reserve estimated cost atomically before the call.
    const monthSpend = await deps.usageLedger.getCurrentMonthSpend(tenant.id);
    if (monthSpend >= tenant.monthlyBudgetUsd) {
      req.log.warn(
        {
          tenant_id: tenant.id,
          spent_usd: monthSpend,
          budget_usd: tenant.monthlyBudgetUsd,
        },
        "tenant budget exceeded",
      );
      await recordRequestOutcome(
        { requestLogs: deps.requestLogs, metrics: deps.metrics, log: req.log },
        {
          requestId: req.id,
          tenantId: tenant.id,
          provider: null,
          model: null,
          modelClass: body.model_class,
          routePolicy: null,
          routingReason: null,
          cacheHit: false,
          streaming: body.stream,
          latencyMs: Date.now() - requestStart,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          status: "budget_exceeded",
          errorType: "TENANT_BUDGET_EXCEEDED",
        },
      );
      return reply.code(402).send({
        error: "TENANT_BUDGET_EXCEEDED",
        message: `Tenant has spent $${monthSpend.toFixed(4)} of $${tenant.monthlyBudgetUsd.toFixed(2)} monthly budget.`,
        spent_usd: Number(monthSpend.toFixed(6)),
        budget_usd: tenant.monthlyBudgetUsd,
        request_id: req.id,
      });
    }

    // ---- 4. Resolve the route ----------------------------------------
    const allowlist = await deps.tenants.getAllowlist(tenant.id);

    let order: RouteCandidate[];
    let routePolicyName: string;
    let candidatesConsidered: number;

    if (body.provider) {
      // Override path: caller pins a provider (and optionally a model).
      // We still enforce the tenant allowlist and that an adapter exists,
      // but we do NOT consult the cost policy and we do NOT fall over.
      const overrideOrError = resolveOverride(body, allowlist, deps);
      if ("error" in overrideOrError) {
        await recordRequestOutcome(
          { requestLogs: deps.requestLogs, metrics: deps.metrics, log: req.log },
          {
            requestId: req.id,
            tenantId: tenant.id,
            provider: typeof body.provider === "string" ? body.provider : null,
            model: typeof body.model === "string" ? body.model : null,
            modelClass: body.model_class,
            routePolicy: "override",
            routingReason: null,
            cacheHit: false,
            streaming: body.stream,
            latencyMs: Date.now() - requestStart,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            status: "no_provider_available",
            errorType: String(overrideOrError.body.error ?? "override_invalid"),
          },
        );
        return reply.code(overrideOrError.statusCode).send({
          ...overrideOrError.body,
          request_id: req.id,
        });
      }
      order = [overrideOrError.candidate];
      routePolicyName = "override";
      candidatesConsidered = 1;
    } else {
      // Router-driven path. Policy decides.
      const decision = await deps.policy.pick({
        modelClass: body.model_class,
        estimatedInputTokens: estimateMessagesTokens(body.messages),
        maxOutputTokens: body.max_tokens,
        allowlist,
        health: deps.health,
        registry: deps.providers,
        pricing: deps.pricing,
      });

      if (!decision) {
        // No provider survives the filters. 503 because this is a config /
        // capacity problem, not a malformed request.
        req.log.warn(
          {
            tenant_id: tenant.id,
            model_class: body.model_class,
            allowlist,
          },
          "no eligible provider for this tenant + model_class",
        );
        await recordRequestOutcome(
          { requestLogs: deps.requestLogs, metrics: deps.metrics, log: req.log },
          {
            requestId: req.id,
            tenantId: tenant.id,
            provider: null,
            model: null,
            modelClass: body.model_class,
            routePolicy: "cost",
            routingReason: "no_eligible_candidate",
            cacheHit: false,
            streaming: body.stream,
            latencyMs: Date.now() - requestStart,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            status: "no_provider_available",
            errorType: "no_eligible_candidate",
          },
        );
        return reply.code(503).send({
          error: "no_provider_available",
          message:
            `No provider in this tenant's allowlist serves model_class '${body.model_class}'. ` +
            `Allowlist: [${allowlist.join(", ")}].`,
          request_id: req.id,
        });
      }

      logRoutingDecision(req, tenant.id, decision);
      order = [decision.selected, ...decision.fallback_candidates];
      routePolicyName = decision.policy;
      candidatesConsidered = decision.candidates_considered;
    }

    // ---- 5a. Streaming branch ---------------------------------------
    // Streaming hands off to the SSE handler now (after gates + routing,
    // before cache + failover loop). The handler owns SSE framing,
    // first-byte commitment, partial-error events, and the
    // ledger/request_logs writes for streaming outcomes. Cache is
    // bypassed because isCacheable(body) returns false for stream:true.
    if (body.stream) {
      await streamChatCompletion(req, reply, deps, {
        tenantId: tenant.id,
        modelClass: body.model_class,
        messages: body.messages,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        routePolicyName,
        candidatesConsidered,
        order,
      });
      return;
    }

    // ---- 5. Cache lookup --------------------------------------------
    // Cache is consulted AFTER routing so the key reflects the provider
    // the router would call right now. If the router picked anthropic
    // because openai's breaker is OPEN, we won't accidentally serve
    // openai's old answer.
    //
    // Eligibility: non-streaming AND temperature == 0 (the default).
    // Anything else bypasses the cache entirely — neither read nor write.
    const cacheable = deps.cacheConfig.enabled && isCacheable(body);
    const selected = order[0]!;
    const cacheKey = cacheable
      ? buildCacheKey({
          tenantId: tenant.id,
          modelClass: body.model_class,
          provider: selected.provider,
          model: selected.model,
          messages: body.messages,
          temperature: body.temperature,
          maxTokens: body.max_tokens,
        })
      : null;

    if (cacheable && cacheKey) {
      const hit = await deps.cache.get(tenant.id, cacheKey);
      if (hit) {
        const cachedResponse: UnifiedChatResponse = {
          id: req.id,
          model_class: hit.model_class,
          provider: hit.provider,
          model: hit.model,
          message: hit.message,
          usage: hit.usage,
          // Assignment rule: cache hits do not bill the tenant.
          cost_usd: 0,
          cached: true,
          created_at: new Date().toISOString(),
          routing: {
            policy: "cache",
            candidate_count: 0,
            fallback_used: false,
            reason: "cache_hit",
          },
        };
        await recordRequestOutcome(
          { requestLogs: deps.requestLogs, metrics: deps.metrics, log: req.log },
          {
            requestId: req.id,
            tenantId: tenant.id,
            provider: hit.provider,
            model: hit.model,
            modelClass: body.model_class,
            routePolicy: "cache",
            routingReason: "cache_hit",
            cacheHit: true,
            streaming: false,
            latencyMs: Date.now() - requestStart,
            inputTokens: hit.usage.input_tokens,
            outputTokens: hit.usage.output_tokens,
            // Cache hits do not bill the tenant — see Phase 7 docs.
            costUsd: 0,
            status: "success",
            errorType: null,
          },
        );
        return cachedResponse;
      }
    }

    // ---- 6. Failover loop --------------------------------------------
    const failure = parseFailureInjection(req.headers);
    const errors: { provider: string; status: number; message: string }[] = [];

    for (let attempt = 0; attempt < order.length; attempt++) {
      const candidate = order[attempt]!;
      const adapter = deps.providers.get(candidate.provider);
      if (!adapter) {
        // Defensive — the policy already filters this, but the override
        // path can still get here on a misconfig.
        errors.push({
          provider: candidate.provider,
          status: 500,
          message: "no_adapter_registered",
        });
        continue;
      }

      const providerReq: ProviderChatRequest = {
        model: candidate.model,
        messages: body.messages,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        ...(failure ? { failure } : {}),
      };

      const start = Date.now();
      try {
        const result = await adapter.complete(providerReq);
        const latencyMs = Date.now() - start;
        const fallbackUsed = attempt > 0;

        let costUsd = 0;
        const price = await deps.pricing.getPrice(adapter.name, result.model);
        if (price) {
          costUsd = calculateCost(price, result.usage);
        } else {
          req.log.warn(
            { provider: adapter.name, model: result.model },
            "no price row for provider/model; cost reported as 0",
          );
        }

        const response: UnifiedChatResponse = {
          id: req.id,
          model_class: body.model_class,
          provider: adapter.name,
          model: result.model,
          message: result.message,
          usage: {
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            total_tokens: result.usage.input_tokens + result.usage.output_tokens,
          },
          cost_usd: costUsd,
          cached: false,
          created_at: new Date().toISOString(),
          routing: {
            policy: routePolicyName,
            candidate_count: candidatesConsidered,
            fallback_used: fallbackUsed,
            reason: candidate.reason,
          },
        };

        // Append to usage_ledger BEFORE responding so the next request from
        // this tenant sees the updated spend. We treat a ledger write
        // failure as non-fatal for the caller (they got their answer); it
        // is logged loudly so accounting drift is visible. See DESIGN.md
        // for why this is a deliberate trade for assignment scope.
        try {
          await deps.usageLedger.recordUsage({
            tenantId: tenant.id,
            provider: adapter.name,
            model: result.model,
            requestId: req.id,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            costUsd: costUsd,
          });
        } catch (ledgerErr) {
          req.log.error(
            {
              err: ledgerErr,
              tenant_id: tenant.id,
              provider: adapter.name,
              model: result.model,
              cost_usd: costUsd,
            },
            "usage_ledger write failed; tenant spend not recorded for this request",
          );
        }

        // Cache write. Key by the provider that ACTUALLY answered, not
        // the one the router originally picked, so a future identical
        // request that the router routes the same way hits the cache.
        // We deliberately do NOT block the response on cache write
        // failure — caching is an optimization, not part of the
        // request's correctness contract.
        if (cacheable) {
          const writeKey =
            adapter.name === selected.provider && result.model === selected.model
              ? cacheKey!
              : buildCacheKey({
                  tenantId: tenant.id,
                  modelClass: body.model_class,
                  provider: adapter.name,
                  model: result.model,
                  messages: body.messages,
                  temperature: body.temperature,
                  maxTokens: body.max_tokens,
                });
          const payload: CachedResponsePayload = {
            model_class: body.model_class,
            provider: adapter.name,
            model: result.model,
            message: result.message,
            usage: response.usage,
          };
          try {
            await deps.cache.set({
              tenantId: tenant.id,
              cacheKey: writeKey,
              payload,
              ttlMs: deps.cacheConfig.ttlMs,
            });
          } catch (cacheErr) {
            req.log.warn(
              {
                err: cacheErr,
                tenant_id: tenant.id,
                provider: adapter.name,
                model: result.model,
              },
              "cache write failed; response served, future identical requests will miss",
            );
          }
        }

        await recordRequestOutcome(
          { requestLogs: deps.requestLogs, metrics: deps.metrics, log: req.log },
          {
            requestId: req.id,
            tenantId: tenant.id,
            provider: adapter.name,
            model: result.model,
            modelClass: body.model_class,
            routePolicy: routePolicyName,
            routingReason: candidate.reason,
            cacheHit: false,
            streaming: false,
            latencyMs: Date.now() - requestStart,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            costUsd: costUsd,
            status: "success",
            errorType: null,
          },
        );

        return response;
      } catch (err) {
        if (err instanceof ProviderError) {
          errors.push({
            provider: adapter.name,
            status: err.statusCode,
            message: err.message,
          });

          // Non-retryable upstream error -> short-circuit. The upstream gave
          // a definite no; rolling over to another provider would be wrong.
          if (!err.retryable) {
            req.log.warn(
              {
                tenant_id: tenant.id,
                provider: adapter.name,
                model: candidate.model,
                status_code: err.statusCode,
                attempts: attempt + 1,
              },
              "provider non-retryable error, no failover",
            );
            await recordRequestOutcome(
              { requestLogs: deps.requestLogs, metrics: deps.metrics, log: req.log },
              {
                requestId: req.id,
                tenantId: tenant.id,
                provider: adapter.name,
                model: candidate.model,
                modelClass: body.model_class,
                routePolicy: routePolicyName,
                routingReason: candidate.reason,
                cacheHit: false,
                streaming: false,
                latencyMs: Date.now() - requestStart,
                inputTokens: null,
                outputTokens: null,
                costUsd: null,
                status: "upstream_failed",
                errorType: `provider_${err.statusCode}`,
              },
            );
            return reply.code(502).send({
              error: "provider_error",
              provider: adapter.name,
              message: err.message,
              retryable: false,
              request_id: req.id,
            });
          }

          // Override path = caller pinned this provider, never roll over.
          if (routePolicyName === "override") {
            req.log.warn(
              {
                tenant_id: tenant.id,
                provider: adapter.name,
                model: candidate.model,
                status_code: err.statusCode,
              },
              "override path provider error, no failover",
            );
            await recordRequestOutcome(
              { requestLogs: deps.requestLogs, metrics: deps.metrics, log: req.log },
              {
                requestId: req.id,
                tenantId: tenant.id,
                provider: adapter.name,
                model: candidate.model,
                modelClass: body.model_class,
                routePolicy: "override",
                routingReason: candidate.reason,
                cacheHit: false,
                streaming: false,
                latencyMs: Date.now() - requestStart,
                inputTokens: null,
                outputTokens: null,
                costUsd: null,
                status: "upstream_failed",
                errorType: `provider_${err.statusCode}`,
              },
            );
            return reply.code(502).send({
              error: "provider_error",
              provider: adapter.name,
              message: err.message,
              retryable: true,
              request_id: req.id,
            });
          }

          // Retryable + router path: try the next candidate if any remain.
          // If this was the last candidate, fall through to the
          // all_providers_failed response below the loop.
          if (attempt < order.length - 1) {
            req.log.warn(
              {
                tenant_id: tenant.id,
                provider: adapter.name,
                model: candidate.model,
                attempt: attempt + 1,
                next_provider: order[attempt + 1]?.provider,
                status_code: err.statusCode,
                error: err.message,
              },
              "provider failed, attempting failover",
            );
            continue;
          }
          // Last candidate failed -> drop out of the loop and emit
          // all_providers_failed below.
          continue;
        }
        throw err;
      }
    }

    // Walked the whole list, every candidate failed retryably.
    req.log.error(
      {
        tenant_id: tenant.id,
        attempts: order.length,
        errors,
      },
      "all providers failed",
    );
    const lastCandidate = order[order.length - 1];
    await recordRequestOutcome(
      { requestLogs: deps.requestLogs, metrics: deps.metrics, log: req.log },
      {
        requestId: req.id,
        tenantId: tenant.id,
        provider: lastCandidate?.provider ?? null,
        model: lastCandidate?.model ?? null,
        modelClass: body.model_class,
        routePolicy: routePolicyName,
        routingReason: lastCandidate?.reason ?? null,
        cacheHit: false,
        streaming: false,
        latencyMs: Date.now() - requestStart,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        status: "all_providers_failed",
        errorType: "all_providers_failed",
      },
    );
    return reply.code(502).send({
      error: "all_providers_failed",
      message: `All ${order.length} eligible provider(s) failed.`,
      attempts: order.length,
      errors,
      request_id: req.id,
    });
  });
}

// --- helpers -----------------------------------------------------------

interface OverrideOk {
  candidate: RouteCandidate;
}
interface OverrideErr {
  error: true;
  statusCode: number;
  body: Record<string, unknown>;
}

function resolveOverride(
  body: ParsedChatRequest,
  allowlist: string[],
  deps: RegisterChatRoutesDeps,
): OverrideOk | OverrideErr {
  const providerName = body.provider!;
  if (!deps.providers.has(providerName)) {
    return {
      error: true,
      statusCode: 400,
      body: {
        error: "unknown_provider",
        message: `Provider '${providerName}' is not registered. Known: ${deps.providers
          .names()
          .join(", ")}.`,
      },
    };
  }
  if (!allowlist.includes(providerName)) {
    return {
      error: true,
      statusCode: 403,
      body: {
        error: "provider_not_in_allowlist",
        message: `Provider '${providerName}' is not allowed for this tenant.`,
      },
    };
  }
  const adapter = deps.providers.get(providerName)!;
  const model = body.model ?? adapter.resolveDefaultModel(body.model_class);
  if (!model) {
    return {
      error: true,
      statusCode: 400,
      body: {
        error: "no_model_for_class",
        message: `Provider '${adapter.name}' has no default model for class '${body.model_class}'.`,
      },
    };
  }
  return {
    candidate: {
      provider: providerName,
      model,
      model_class: body.model_class,
      estimated_cost_usd: 0, // not computed in override path
      reason: "caller_pinned",
    },
  };
}

function logRoutingDecision(
  req: FastifyRequest,
  tenantId: string,
  decision: RoutingDecision,
): void {
  req.log.info(
    {
      tenant_id: tenantId,
      route_policy: decision.policy,
      selected_provider: decision.selected.provider,
      selected_model: decision.selected.model,
      reason: decision.selected.reason,
      candidate_count: decision.candidates_considered,
      fallback_count: decision.fallback_candidates.length,
      filtered_out: decision.filtered_out,
      estimated_cost_usd: decision.selected.estimated_cost_usd,
    },
    "routing decision",
  );
}
