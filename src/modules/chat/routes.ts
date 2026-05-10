import type { FastifyInstance } from "fastify";

import { ProviderError } from "../providers/errors.js";
import { parseFailureInjection } from "../providers/failure-injection.js";
import { calculateCost, PricingRepository } from "../providers/pricing.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type {
  ProviderChatRequest,
  UnifiedChatResponse,
} from "../providers/types.js";
import { ChatRequestSchema } from "./validation.js";

export interface RegisterChatRoutesDeps {
  providers: ProviderRegistry;
  pricing: PricingRepository;
}

// Phase 3 default. The real router (Phase 4) replaces this with cost-based
// selection across the tenant's allowlist. Today, if the client doesn't pin a
// provider, we use OpenAI as a stable, well-known default.
const DEFAULT_PROVIDER = "openai";

export async function registerChatRoutes(
  app: FastifyInstance,
  deps: RegisterChatRoutesDeps,
): Promise<void> {
  app.post("/v1/chat/completions", async (req, reply) => {
    const tenant = req.tenant;
    if (!tenant) {
      // The auth hook should have caught this. Defensive 401 just in case.
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

    // ---- 2. Streaming is wired in a later phase ------------------------
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

    // ---- 3. Resolve provider ------------------------------------------
    // Phase 3: caller-provided provider, otherwise a static default.
    // Phase 4 replaces this with the cost-based router that filters by
    // tenant allowlist + model_class + provider health.
    const providerName = body.provider ?? DEFAULT_PROVIDER;
    const adapter = deps.providers.get(providerName);
    if (!adapter) {
      return reply.code(400).send({
        error: "unknown_provider",
        message: `Provider '${providerName}' is not registered. Known: ${deps.providers
          .names()
          .join(", ")}.`,
        request_id: req.id,
      });
    }

    // ---- 4. Resolve model ---------------------------------------------
    const model = body.model ?? adapter.resolveDefaultModel(body.model_class);
    if (!model) {
      return reply.code(400).send({
        error: "no_model_for_class",
        message: `Provider '${adapter.name}' has no default model for class '${body.model_class}'.`,
        request_id: req.id,
      });
    }

    // ---- 5. Build the provider request --------------------------------
    const failure = parseFailureInjection(req.headers);
    const providerReq: ProviderChatRequest = {
      model,
      messages: body.messages,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      ...(failure ? { failure } : {}),
    };

    // ---- 6. Call the adapter ------------------------------------------
    const start = Date.now();
    let result;
    try {
      result = await adapter.complete(providerReq);
    } catch (err) {
      if (err instanceof ProviderError) {
        req.log.warn(
          {
            tenant_id: tenant.id,
            provider: adapter.name,
            model,
            status_code: err.statusCode,
            retryable: err.retryable,
          },
          "provider error",
        );
        // 502 Bad Gateway is the right shape: we (the gateway) reached
        // upstream and upstream said no. Phase 5 will retry/failover before
        // returning this; for Phase 3 we fail straight through.
        return reply.code(502).send({
          error: "provider_error",
          provider: adapter.name,
          message: err.message,
          retryable: err.retryable,
          request_id: req.id,
        });
      }
      throw err;
    }
    const latencyMs = Date.now() - start;

    // ---- 7. Cost --------------------------------------------------------
    // Look up the price for the resolved (provider, model). Missing-price
    // is non-fatal — we log and return cost 0 rather than fail the request.
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

    // ---- 8. Normalize and respond -------------------------------------
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
    };

    req.log.info(
      {
        tenant_id: tenant.id,
        provider: adapter.name,
        model: result.model,
        latency_ms: latencyMs,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cost_usd: costUsd,
      },
      "chat completion ok",
    );

    return response;
  });
}
