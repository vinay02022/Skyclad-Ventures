import type { FastifyInstance, FastifyRequest } from "fastify";

import { ProviderError } from "../providers/errors.js";
import { parseFailureInjection } from "../providers/failure-injection.js";
import { calculateCost, PricingRepository } from "../providers/pricing.js";
import { estimateMessagesTokens } from "../providers/tokens.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type {
  ProviderChatRequest,
  UnifiedChatResponse,
} from "../providers/types.js";
import type {
  ProviderHealthOracle,
  RouteCandidate,
  RoutingDecision,
  RoutingPolicy,
} from "../routing/types.js";
import type { TenantRepository } from "../tenants/repository.js";
import { ChatRequestSchema, type ParsedChatRequest } from "./validation.js";

export interface RegisterChatRoutesDeps {
  providers: ProviderRegistry;
  pricing: PricingRepository;
  tenants: TenantRepository;
  policy: RoutingPolicy;
  health: ProviderHealthOracle;
}

/**
 * The single chat endpoint. Phase 4 reshapes the body of this handler:
 *
 *   1. Auth (already done by the auth hook; we re-check defensively).
 *   2. Validate the body via Zod.
 *   3. Resolve a routing decision:
 *        - body.provider set       -> debug override path: caller pins one
 *                                     provider, no failover.
 *        - body.provider not set   -> ask the routing policy. Policy returns
 *                                     a primary candidate plus an ordered
 *                                     fallback list (cheap -> expensive).
 *   4. Walk candidates in order. On a retryable ProviderError, try the next
 *      one. On a non-retryable error, bail with 502. Stop on first success.
 *   5. Normalize and respond.
 *
 * Streaming still returns 501 — SSE lands in a later phase.
 */
export async function registerChatRoutes(
  app: FastifyInstance,
  deps: RegisterChatRoutesDeps,
): Promise<void> {
  app.post("/v1/chat/completions", async (req, reply) => {
    const tenant = req.tenant;
    if (!tenant) {
      return reply.code(401).send({ error: "unauthorized", request_id: req.id });
    }

    // ---- 1. Validate ---------------------------------------------------
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
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

    if (body.stream) {
      return reply.code(501).send({
        error: "not_implemented",
        message:
          "SSE streaming over /v1/chat/completions lands in a later phase. " +
          "The mock providers already support streaming at the adapter level " +
          "(see tests/providers.test.ts).",
        request_id: req.id,
      });
    }

    // ---- 2. Resolve the route ----------------------------------------
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

    // ---- 3. Failover loop --------------------------------------------
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

        req.log.info(
          {
            tenant_id: tenant.id,
            route_policy: routePolicyName,
            selected_provider: adapter.name,
            selected_model: result.model,
            reason: candidate.reason,
            candidate_count: candidatesConsidered,
            fallback_used: fallbackUsed,
            attempts: attempt + 1,
            latency_ms: latencyMs,
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            cost_usd: costUsd,
          },
          "chat completion ok",
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
