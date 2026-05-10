import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { UsageLedgerRepository } from "../budget/repository.js";
import type { MockFailureStore } from "../providers/mock-failure-store.js";
import type { FailureInjection } from "../providers/types.js";
import type { TenantRepository } from "../tenants/repository.js";

export interface RegisterAdminRoutesDeps {
  usageLedger: UsageLedgerRepository;
  tenants: TenantRepository;
  /** Phase 11: shared store consulted by mock providers. */
  mockFailureStore: MockFailureStore;
  /** Bearer token required on every admin call. */
  adminToken: string;
}

/**
 * Admin surface, deliberately tiny.
 *
 * Auth: a single shared bearer token from the ADMIN_TOKEN env var. No RBAC,
 * no per-operator users, no rotation flow. The assignment scope is "an
 * evaluator can answer 'how much has tenant_a spent this week?'". Anything
 * more would be production noise.
 *
 * Production gaps (called out in DESIGN.md):
 *   - one shared secret means the token can't be revoked per-operator,
 *   - no audit log of who hit /admin (the request_log row only knows
 *     "admin", not which human),
 *   - no rate-limit on /admin (a leaked token + a tight loop could DoS
 *     the usage_ledger table).
 *
 * The routes here are mounted only when ADMIN_TOKEN is non-empty. An
 * empty token means the endpoint isn't even registered, so a misconfigured
 * deploy fails closed (404) rather than open (200 to anyone).
 */
export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: RegisterAdminRoutesDeps,
): Promise<void> {
  // ---- shared auth hook ---------------------------------------------
  // Scoped via Fastify's encapsulation: this onRequest runs only on
  // routes registered inside this plugin, not on POST /v1/chat/completions.
  app.addHook("onRequest", async (req, reply) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Admin endpoints require a Bearer token.",
        request_id: req.id,
      });
    }
    const token = header.slice("Bearer ".length).trim();
    if (token !== deps.adminToken) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Invalid admin token.",
        request_id: req.id,
      });
    }
  });

  // ---- GET /admin/tenants/:tenantId/usage ---------------------------
  const ParamsSchema = z.object({
    tenantId: z.string().uuid("tenantId must be a UUID"),
  });
  // YYYY-MM-DD only, no time component. Keeps the URL simple and the
  // semantics ("calendar day in UTC") obvious to whoever's typing it.
  const DateOnly = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
  const QuerySchema = z.object({
    from: DateOnly,
    to: DateOnly,
  });

  app.get("/admin/tenants/:tenantId/usage", async (req, reply) => {
    const params = ParamsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({
        error: "invalid_request",
        details: params.error.issues,
        request_id: req.id,
      });
    }
    const query = QuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({
        error: "invalid_request",
        details: query.error.issues,
        request_id: req.id,
      });
    }

    const from = new Date(`${query.data.from}T00:00:00.000Z`);
    // Half-open range: to=2026-05-10 means "up to but not including
    // 2026-05-11 00:00 UTC", so the caller can naively pass the same
    // value for from and to to ask for a single day.
    const toExclusive = new Date(`${query.data.to}T00:00:00.000Z`);
    toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);

    if (Number.isNaN(from.getTime()) || Number.isNaN(toExclusive.getTime())) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "from / to must be valid YYYY-MM-DD calendar dates",
        request_id: req.id,
      });
    }
    if (from >= toExclusive) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "from must be on or before to",
        request_id: req.id,
      });
    }

    const breakdown = await deps.usageLedger.getUsageBreakdown(
      params.data.tenantId,
      from,
      toExclusive,
    );

    // Aggregate rollups in JS so the API is always consistent regardless
    // of how the SQL groups out — the breakdown query gives us the
    // primitives, this layer composes them into the assignment-shaped
    // response.
    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    const byProvider: Record<
      string,
      { cost_usd: number; input_tokens: number; output_tokens: number }
    > = {};
    const byModel: Record<
      string,
      { cost_usd: number; input_tokens: number; output_tokens: number }
    > = {};

    for (const row of breakdown) {
      totalCost += row.costUsd;
      totalInput += row.inputTokens;
      totalOutput += row.outputTokens;

      const provBucket = byProvider[row.provider] ?? {
        cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
      };
      provBucket.cost_usd += row.costUsd;
      provBucket.input_tokens += row.inputTokens;
      provBucket.output_tokens += row.outputTokens;
      byProvider[row.provider] = provBucket;

      // Model key is provider-qualified ("openai/gpt-4o-mini") because
      // model names like "gpt-4o-mini" can in principle appear under
      // multiple providers and we don't want to silently sum across
      // them.
      const modelKey = `${row.provider}/${row.model}`;
      const modBucket = byModel[modelKey] ?? {
        cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
      };
      modBucket.cost_usd += row.costUsd;
      modBucket.input_tokens += row.inputTokens;
      modBucket.output_tokens += row.outputTokens;
      byModel[modelKey] = modBucket;
    }

    return {
      tenant_id: params.data.tenantId,
      from: query.data.from,
      to: query.data.to,
      total_cost_usd: round6(totalCost),
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      by_provider: roundProviderMap(byProvider),
      by_model: roundProviderMap(byModel),
    };
  });

  // ===================================================================
  // Phase 11 — EVAL-ONLY HELPERS
  // ===================================================================
  //
  // The next three endpoints exist to make the assignment evaluator's
  // life easier when running the assignment script:
  //
  //   - `POST /admin/mock-providers/:provider/failure-mode` toggles
  //     persistent failure injection on a mock provider, so the
  //     evaluator can demo "OpenAI is broken; watch Anthropic
  //     answer" with one curl + one normal-looking chat request,
  //     instead of remembering to attach `x-skyclad-fail` to every
  //     request in the demo.
  //
  //   - `POST /admin/tenants/:tenantId/reset-usage` truncates the
  //     usage_ledger for one tenant. Used to demo "tenant exhausts
  //     budget -> 402 -> reset -> works again" without waiting for
  //     monthly rollover or dropping into psql.
  //
  //   - `POST /admin/tenants/:tenantId/set-budget` overwrites
  //     `monthly_budget_usd`. Used to demo budget enforcement
  //     ratchet-up and ratchet-down inside one walkthrough.
  //
  // None of these are production-grade endpoints. They're protected
  // by the same shared ADMIN_TOKEN as the read-only usage endpoint;
  // a leaked token plus a malicious caller could permanently zero
  // every tenant's budget or inject failure modes that look like
  // outages. In production, every one of these would need:
  //   - per-operator identity (not a shared secret)
  //   - an audit-log row per call
  //   - rate-limiting and an explicit kill switch
  //   - typically a separate, segregated admin service
  // We make none of those investments here because the assignment
  // scope is "make the evaluator's local walkthrough easy", not
  // "build a billing portal".
  //
  // The endpoints set a response header `x-skyclad-eval-only: true`
  // so anyone scanning logs can immediately tell these were called.

  // ---- POST /admin/mock-providers/:provider/failure-mode -----------
  //
  // Persistent failure injection on a mock provider. Per-request
  // header injection (`x-skyclad-fail`) still wins; this is the
  // "until I clear it" mode for scenario walkthroughs.
  //
  // Modes (mapped to the existing mock-base FailureInjection):
  //
  //   normal                                 -> clear the entry
  //   fail_5xx                               -> mode "5xx" (retryable)
  //   timeout                                -> mode "timeout" (sleeps)
  //   stream_drop_before_first_token         -> mode "pre-stream-drop"
  //   stream_drop_after_chunks {chunks: N}   -> mode "stream-drop"

  const KNOWN_MOCK_PROVIDERS = ["openai", "anthropic"] as const;
  const ProviderParamSchema = z.object({
    provider: z.enum(KNOWN_MOCK_PROVIDERS),
  });
  // Discriminated union so the chunks field is required ONLY for the
  // mode that actually consumes it. Catches "I forgot the chunks
  // count" at the validation layer instead of producing a confusing
  // afterChunks=undefined behavior.
  const FailureModeBody = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("normal") }),
    z.object({ mode: z.literal("fail_5xx") }),
    z.object({ mode: z.literal("timeout") }),
    z.object({ mode: z.literal("stream_drop_before_first_token") }),
    z.object({
      mode: z.literal("stream_drop_after_chunks"),
      chunks: z.number().int().nonnegative(),
    }),
  ]);

  app.post("/admin/mock-providers/:provider/failure-mode", async (req, reply) => {
    reply.header("x-skyclad-eval-only", "true");
    const params = ProviderParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: `provider must be one of: ${KNOWN_MOCK_PROVIDERS.join(", ")}`,
        request_id: req.id,
      });
    }
    const body = FailureModeBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "invalid_request",
        details: body.error.issues,
        request_id: req.id,
      });
    }

    const failure = translateMode(body.data);
    deps.mockFailureStore.set(params.data.provider, failure);

    req.log.warn(
      {
        eval_only: true,
        provider: params.data.provider,
        failure_mode: body.data.mode,
      },
      "EVAL-ONLY: mock provider failure mode changed",
    );

    return {
      provider: params.data.provider,
      failure_mode: body.data.mode,
      effective: failure,
      note:
        "Eval-only helper. Mock providers consult this on every call. " +
        "Per-request `x-skyclad-fail` headers still win. Settings are " +
        "process-local and clear on restart.",
    };
  });

  // ---- POST /admin/tenants/:tenantId/reset-usage -------------------
  app.post("/admin/tenants/:tenantId/reset-usage", async (req, reply) => {
    reply.header("x-skyclad-eval-only", "true");
    const params = ParamsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({
        error: "invalid_request",
        details: params.error.issues,
        request_id: req.id,
      });
    }
    const deleted = await deps.usageLedger.resetTenantUsage(params.data.tenantId);
    req.log.warn(
      { eval_only: true, tenant_id: params.data.tenantId, rows_deleted: deleted },
      "EVAL-ONLY: tenant usage_ledger reset",
    );
    return {
      tenant_id: params.data.tenantId,
      rows_deleted: deleted,
      note:
        "Eval-only helper. Production resets happen via monthly rollover " +
        "or compensating-row writes with an audit trail.",
    };
  });

  // ---- POST /admin/tenants/:tenantId/set-budget --------------------
  const SetBudgetBody = z.object({
    monthly_budget_usd: z.number().nonnegative().finite(),
  });
  app.post("/admin/tenants/:tenantId/set-budget", async (req, reply) => {
    reply.header("x-skyclad-eval-only", "true");
    const params = ParamsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({
        error: "invalid_request",
        details: params.error.issues,
        request_id: req.id,
      });
    }
    const body = SetBudgetBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "invalid_request",
        details: body.error.issues,
        request_id: req.id,
      });
    }
    const updated = await deps.tenants.setBudget(
      params.data.tenantId,
      body.data.monthly_budget_usd,
    );
    if (!updated) {
      return reply.code(404).send({
        error: "tenant_not_found",
        tenant_id: params.data.tenantId,
        request_id: req.id,
      });
    }
    req.log.warn(
      {
        eval_only: true,
        tenant_id: params.data.tenantId,
        monthly_budget_usd: updated.monthlyBudgetUsd,
      },
      "EVAL-ONLY: tenant monthly_budget_usd updated",
    );
    return {
      tenant_id: params.data.tenantId,
      monthly_budget_usd: updated.monthlyBudgetUsd,
      note:
        "Eval-only helper. Takes effect on the next request (the auth hook " +
        "re-reads the tenant row each call).",
    };
  });
}

/**
 * Translate the user-friendly admin mode names into the existing
 * `FailureInjection` shape that `MockProviderBase.resolveFailure`
 * already understands. Returning null means "clear any persistent
 * failure for this provider".
 */
function translateMode(
  body:
    | { mode: "normal" }
    | { mode: "fail_5xx" }
    | { mode: "timeout" }
    | { mode: "stream_drop_before_first_token" }
    | { mode: "stream_drop_after_chunks"; chunks: number },
): FailureInjection | null {
  switch (body.mode) {
    case "normal":
      return null;
    case "fail_5xx":
      return { mode: "5xx" };
    case "timeout":
      return { mode: "timeout" };
    case "stream_drop_before_first_token":
      return { mode: "pre-stream-drop" };
    case "stream_drop_after_chunks":
      return { mode: "stream-drop", afterChunks: body.chunks };
  }
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function roundProviderMap<
  T extends Record<string, { cost_usd: number; input_tokens: number; output_tokens: number }>,
>(map: T): T {
  for (const key of Object.keys(map)) {
    const bucket = map[key as keyof T];
    if (bucket) bucket.cost_usd = round6(bucket.cost_usd);
  }
  return map;
}
