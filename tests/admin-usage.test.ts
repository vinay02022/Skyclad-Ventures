import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { UsageLedgerRepository } from "../src/modules/budget/repository.js";
import { defaultIsRetryable } from "../src/modules/resilience/defaults.js";
import { CircuitBreakerRegistry } from "../src/modules/resilience/circuit-breaker.js";
import {
  TENANT_A_ID,
  TENANT_B_ID,
} from "../db/seed-fixtures.js";
import {
  closeTestDb,
  getTestDb,
  isTestDbAvailable,
  truncateUsageLedger,
} from "./setup/db.js";

const dbAvailable = await isTestDbAvailable();

const ADMIN_TOKEN = "test-admin-token-do-not-use-in-prod";

let app: FastifyInstance;
let breakers: CircuitBreakerRegistry;
let ledger: UsageLedgerRepository;

const fastResilienceConfig = {
  timeoutMs: 5_000,
  retry: { maxAttempts: 1, delaysMs: [], jitterFactor: 0, isRetryable: defaultIsRetryable },
  breaker: { failureThreshold: 9_999, failureWindowMs: 60_000, openCooldownMs: 1_000 },
};

beforeAll(async () => {
  if (!dbAvailable) return;
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgres://gateway:gateway@localhost:5432/gateway_test",
    ADMIN_TOKEN,
  });
  const logger = createLogger(config);
  const handle = await getTestDb();
  ledger = new UsageLedgerRepository(handle.db);
  breakers = new CircuitBreakerRegistry(fastResilienceConfig.breaker);
  app = await buildApp({
    config,
    logger,
    db: handle.db,
    resilience: fastResilienceConfig,
    breakers,
    cacheConfig: { enabled: false, ttlMs: 0 },
    usageLedger: ledger,
  });
  await app.ready();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  const handle = await getTestDb();
  await truncateUsageLedger(handle);
});

afterAll(async () => {
  if (app) await app.close();
  await closeTestDb();
});

const today = () => {
  const d = new Date();
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!dbAvailable)("GET /admin/tenants/:tenantId/usage", () => {
  // ---- Test 1: 401 without an admin token -----------------------------
  it("rejects requests without a Bearer token (401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/admin/tenants/${TENANT_A_ID}/usage?from=${today()}&to=${today()}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects requests with the wrong Bearer token (401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/admin/tenants/${TENANT_A_ID}/usage?from=${today()}&to=${today()}`,
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  // ---- Test 2: aggregation correctness with a valid token ------------
  it("returns aggregated usage broken down by provider and model", async () => {
    // Hand-craft ledger rows so the test's expected totals are
    // independent of the mock provider's token estimation behaviour.
    await ledger.recordUsage({
      tenantId: TENANT_A_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      requestId: "req-test-1",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.000045,
    });
    await ledger.recordUsage({
      tenantId: TENANT_A_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      requestId: "req-test-2",
      inputTokens: 200,
      outputTokens: 75,
      costUsd: 0.000075,
    });
    await ledger.recordUsage({
      tenantId: TENANT_A_ID,
      provider: "anthropic",
      model: "claude-3-haiku-20240307",
      requestId: "req-test-3",
      inputTokens: 150,
      outputTokens: 60,
      costUsd: 0.000113,
    });

    const res = await app.inject({
      method: "GET",
      url: `/admin/tenants/${TENANT_A_ID}/usage?from=${today()}&to=${today()}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    expect(body.tenant_id).toBe(TENANT_A_ID);
    expect(body.total_input_tokens).toBe(450);
    expect(body.total_output_tokens).toBe(185);
    expect(body.total_cost_usd).toBeCloseTo(0.000233, 6);

    expect(body.by_provider.openai.input_tokens).toBe(300);
    expect(body.by_provider.openai.output_tokens).toBe(125);
    expect(body.by_provider.openai.cost_usd).toBeCloseTo(0.000120, 6);

    expect(body.by_provider.anthropic.input_tokens).toBe(150);
    expect(body.by_provider.anthropic.output_tokens).toBe(60);

    expect(body.by_model["openai/gpt-4o-mini"].input_tokens).toBe(300);
    expect(body.by_model["anthropic/claude-3-haiku-20240307"].input_tokens).toBe(150);
  });

  // ---- Test 3: tenant isolation --------------------------------------
  it("does not mix usage from another tenant", async () => {
    await ledger.recordUsage({
      tenantId: TENANT_A_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      requestId: "req-iso-a",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.5,
    });
    await ledger.recordUsage({
      tenantId: TENANT_B_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      requestId: "req-iso-b",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.05,
    });

    const resA = await app.inject({
      method: "GET",
      url: `/admin/tenants/${TENANT_A_ID}/usage?from=${today()}&to=${today()}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const bodyA = JSON.parse(resA.payload);
    expect(bodyA.total_cost_usd).toBeCloseTo(0.5, 6);
    expect(bodyA.total_input_tokens).toBe(1000);

    const resB = await app.inject({
      method: "GET",
      url: `/admin/tenants/${TENANT_B_ID}/usage?from=${today()}&to=${today()}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const bodyB = JSON.parse(resB.payload);
    expect(bodyB.total_cost_usd).toBeCloseTo(0.05, 6);
    expect(bodyB.total_input_tokens).toBe(100);

    // Defense in depth: tenant B's response must not contain tenant A's
    // higher input-token total under any breakdown key.
    expect(JSON.stringify(bodyB)).not.toContain('"input_tokens":1000');
  });

  // ---- Test 4: from/to validation ------------------------------------
  it("rejects malformed date params with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/admin/tenants/${TENANT_A_ID}/usage?from=not-a-date&to=${today()}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects from > to with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/admin/tenants/${TENANT_A_ID}/usage?from=2026-12-31&to=2026-01-01`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
  });

  // ---- Test 5: empty range returns zeros, not 404 --------------------
  it("returns zero totals (not 404) when the tenant has no ledger rows in the range", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/admin/tenants/${TENANT_A_ID}/usage?from=2020-01-01&to=2020-01-01`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.total_cost_usd).toBe(0);
    expect(body.total_input_tokens).toBe(0);
    expect(body.total_output_tokens).toBe(0);
    expect(body.by_provider).toEqual({});
    expect(body.by_model).toEqual({});
  });
});
