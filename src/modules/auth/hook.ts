import type { FastifyInstance } from "fastify";

import type { TenantRepository } from "../tenants/repository.js";
import type { AuthenticatedTenant } from "../tenants/types.js";

declare module "fastify" {
  interface FastifyRequest {
    tenant?: AuthenticatedTenant;
  }
}

// Public paths skip auth. Anything else under /v1 must carry a valid bearer.
const PUBLIC_PREFIXES = ["/health", "/metrics"];

export function registerAuthHook(app: FastifyInstance, tenantRepo: TenantRepository): void {
  app.addHook("onRequest", async (req, reply) => {
    if (PUBLIC_PREFIXES.some((p) => req.url === p || req.url.startsWith(`${p}?`))) {
      return;
    }
    if (!req.url.startsWith("/v1/")) {
      return;
    }

    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Missing or malformed Authorization header. Expected: Bearer <api_key>.",
        request_id: req.id,
      });
    }

    const rawKey = auth.slice("Bearer ".length).trim();
    if (rawKey.length === 0) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Empty bearer token.",
        request_id: req.id,
      });
    }

    const tenant = await tenantRepo.findByApiKey(rawKey);
    if (!tenant) {
      // Same response shape and status as a malformed header so attackers
      // can't enumerate which tokens are real-but-revoked vs nonexistent.
      req.log.warn({ url: req.url }, "auth: invalid api key");
      return reply.code(401).send({
        error: "unauthorized",
        message: "Invalid API key.",
        request_id: req.id,
      });
    }

    if (tenant.status !== "active") {
      req.log.warn({ tenant_id: tenant.id, status: tenant.status }, "auth: tenant not active");
      return reply.code(403).send({
        error: "tenant_disabled",
        message: `Tenant status is '${tenant.status}'.`,
        request_id: req.id,
      });
    }

    req.tenant = tenant;
    // Logged once on attach so every subsequent log line for this request
    // can be grepped by tenant_id.
    req.log.info({ tenant_id: tenant.id }, "auth: ok");
  });
}
