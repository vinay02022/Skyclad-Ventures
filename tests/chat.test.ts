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
        "usage",
      ].sort(),
    );
    expect(body.model_class).toBe("cheap");
    expect(body.provider).toBe("openai"); // default in Phase 3
    expect(body.model).toBe("gpt-4o-mini"); // openai's default for "cheap"
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

  it("rejects model_class 'premium' on the openai mock (no model resolves)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: goodBody({ model_class: "premium" }),
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
  });

  it("returns 502 when the provider is forced to fail with x-skyclad-fail: 5xx", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...tenantAHeaders, "x-skyclad-fail": "5xx" },
      payload: goodBody(),
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toBe("provider_error");
    expect(body.provider).toBe("openai");
    expect(body.retryable).toBe(true);
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
