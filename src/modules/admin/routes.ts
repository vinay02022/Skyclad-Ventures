import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { UsageLedgerRepository } from "../budget/repository.js";

export interface RegisterAdminRoutesDeps {
  usageLedger: UsageLedgerRepository;
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
