import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import {
  TENANT_A_API_KEY,
  TENANT_B_API_KEY,
} from "../db/seed-fixtures.js";
import { closeTestDb, getTestDb, isTestDbAvailable } from "./setup/db.js";

const dbAvailable = await isTestDbAvailable();

let app: FastifyInstance;

beforeAll(async () => {
  if (!dbAvailable) return;
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgres://gateway:gateway@localhost:5432/gateway_test",
  });
  const logger = createLogger(config);
  const handle = await getTestDb();
  app = await buildApp({ config, logger, db: handle.db });
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  await closeTestDb();
});

const goodBody = (overrides: Record<string, unknown> = {}) => ({
  model_class: "cheap",
  messages: [{ role: "user", content: "hello there" }],
  ...overrides,
});

const tenantAHeaders = { authorization: `Bearer ${TENANT_A_API_KEY}` };
const tenantBHeaders = { authorization: `Bearer ${TENANT_B_API_KEY}` };

describe.skipIf(!dbAvailable)("POST /v1/chat/completions", () => {
  it("requires authentication", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: goodBody(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a valid request and returns a normalized response", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: goodBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Shape: exactly the keys we promise the client. Nothing else.
    expect(Object.keys(body).sort()).toEqual(
      [
        "cached",
        "cost_usd",
        "created_at",
        "id",
        "message",
        "model",
        "model_class",
        "provider",
        "routing",
        "usage",
      ].sort(),
    );
    expect(body.model_class).toBe("cheap");
    // Phase 4: router picks openai because gpt-4o-mini is cheaper than
    // claude-3-haiku for the cheap class with the seeded prices.
    expect(body.provider).toBe("openai");
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.routing.policy).toBe("cost-optimized");
    expect(body.routing.fallback_used).toBe(false);
    expect(body.routing.candidate_count).toBeGreaterThanOrEqual(2);
    expect(body.message.role).toBe("assistant");
    expect(body.message.content).toContain("[mock-openai]");
    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBeGreaterThan(0);
    expect(body.usage.total_tokens).toBe(
      body.usage.input_tokens + body.usage.output_tokens,
    );
    expect(body.cached).toBe(false);
    expect(body.cost_usd).toBeGreaterThan(0); // priced from provider_configs
    expect(body.id).toBe(res.headers["x-request-id"]);
  });

  it("rejects a request with no messages", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: goodBody({ messages: [] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("rejects a request with no model_class", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("rejects a request with an empty message content", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: goodBody({ messages: [{ role: "user", content: "" }] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("rejects an unknown provider override", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: goodBody({ provider: "definitely-not-real" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown_provider");
  });

  it("override path: pinning openai + premium without a model returns 400 no_model_for_class", async () => {
    // openai's mock has no premium default model (premium-class lives on
    // anthropic). When the caller forces openai we surface that explicitly
    // rather than silently routing somewhere else.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: goodBody({ provider: "openai", model_class: "premium" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("no_model_for_class");
  });

  it("routes to anthropic when provider is overridden", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: goodBody({ provider: "anthropic", model_class: "premium" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe("anthropic");
    expect(body.model).toBe("claude-3-opus-20240229");
    expect(body.message.content).toContain("[mock-anthropic]");
    expect(body.routing.policy).toBe("override");
    expect(body.routing.reason).toBe("caller_pinned");
  });

  it("router-driven path: model_class 'premium' routes to anthropic for tenant_a", async () => {
    // No provider override. Only anthropic has a premium model in the seed,
    // so the cost-optimized router picks anthropic with no fallback.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: goodBody({ model_class: "premium" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe("anthropic");
    expect(body.routing.policy).toBe("cost-optimized");
    expect(body.routing.fallback_used).toBe(false);
  });

  it("router-driven path: tenant_b asking for premium gets 503 (allowlist excludes anthropic)", async () => {
    // tenant_b's allowlist is openai-only and openai serves no premium model,
    // so no candidate survives. Honest 503 instead of a misleading 400.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: goodBody({ model_class: "premium" }),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("no_provider_available");
  });

  it("fails over to anthropic when openai is forced to fail (x-skyclad-fail-provider: openai)", async () => {
    // Router picks openai (cheapest cheap). openai blows up before any
    // bytes are written. The handler must roll over to the next cheapest
    // candidate (anthropic) and the response should reflect fallback_used.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        ...tenantAHeaders,
        "x-skyclad-fail": "5xx",
        "x-skyclad-fail-provider": "openai",
      },
      payload: goodBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe("anthropic");
    expect(body.routing.fallback_used).toBe(true);
    expect(body.routing.policy).toBe("cost-optimized");
  });

  it("returns 502 all_providers_failed when every candidate fails (x-skyclad-fail: 5xx, no target)", async () => {
    // No targetProvider -> both openai and anthropic blow up, so the
    // failover loop exhausts the candidate list. Honest 502 with the
    // attempt count and per-provider error trail.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...tenantAHeaders, "x-skyclad-fail": "5xx" },
      payload: goodBody(),
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toBe("all_providers_failed");
    expect(body.attempts).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("returns 501 for stream:true (SSE wiring lands in a later phase)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: goodBody({ stream: true }),
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe("not_implemented");
  });

  it("does NOT leak provider-specific fields (no choices[], no system_fingerprint)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: goodBody(),
    });
    const body = res.json();
    // OpenAI shape would have these; our normalized response must not.
    expect(body).not.toHaveProperty("choices");
    expect(body).not.toHaveProperty("system_fingerprint");
    expect(body).not.toHaveProperty("object");
    expect(body).not.toHaveProperty("finish_reason");
    // Anthropic shape would have these; same deal.
    expect(body).not.toHaveProperty("stop_reason");
    expect(body).not.toHaveProperty("type");
  });

  it("works for tenant_b too (different keys, same normalized shape)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: goodBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe("openai");
    expect(body.message.role).toBe("assistant");
  });
});
