import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import {
  TENANT_A_API_KEY,
  TENANT_A_ID,
  TENANT_B_API_KEY,
  TENANT_B_ID,
} from "../db/seed-fixtures.js";
import { closeTestDb, getTestDb, isTestDbAvailable } from "./setup/db.js";

// Top-level await so describe.skipIf sees the real value at registration
// time. beforeAll runs too late for skipIf decisions.
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

describe.skipIf(!dbAvailable)("auth + tenant identity", () => {
  it("rejects requests with no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("rejects requests with an unknown bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Bearer sk_test_definitely_not_a_real_key" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
  });

  it("resolves tenant_a from its seeded API key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${TENANT_A_API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenant_id).toBe(TENANT_A_ID);
    expect(body.name).toBe("tenant_a");
    expect(body.monthly_budget_usd).toBe(10);
    expect(body.rate_limit_per_minute).toBe(60);
    expect(body.allowlist).toEqual(expect.arrayContaining(["openai", "anthropic"]));
  });

  it("resolves tenant_b from its seeded API key with a restricted allowlist", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${TENANT_B_API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenant_id).toBe(TENANT_B_ID);
    expect(body.name).toBe("tenant_b");
    expect(body.monthly_budget_usd).toBe(2);
    expect(body.rate_limit_per_minute).toBe(10);
    expect(body.allowlist).toEqual(["openai"]);
    expect(body.allowlist).not.toContain("anthropic");
  });

  it("does not require auth for /health or /metrics", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
  });
});
