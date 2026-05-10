import type { FastifyInstance } from "fastify";

import type { TenantRepository } from "./repository.js";

// GET /v1/me — identity echo. Doubles as the auth smoke test for the
// evaluator: "did my API key work, and what does this tenant look like?".
// Cheap to call, returns no secret data.
export async function registerTenantRoutes(
  app: FastifyInstance,
  tenantRepo: TenantRepository,
): Promise<void> {
  app.get("/v1/me", async (req, reply) => {
    const tenant = req.tenant;
    if (!tenant) {
      // Defensive: the auth hook should have rejected before we get here.
      return reply.code(401).send({ error: "unauthorized", request_id: req.id });
    }

    const allowlist = await tenantRepo.getAllowlist(tenant.id);
    return {
      tenant_id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      monthly_budget_usd: tenant.monthlyBudgetUsd,
      rate_limit_per_minute: tenant.rateLimitPerMinute,
      allowlist,
    };
  });
}
