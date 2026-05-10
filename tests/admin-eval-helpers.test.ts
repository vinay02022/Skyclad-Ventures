import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { UsageLedgerRepository } from "../src/modules/budget/repository.js";
import { RequestLogRepository } from "../src/modules/persistence/request-logs-repo.js";
import { CircuitBreakerRegistry } from "../src/modules/resilience/circuit-breaker.js";
import { defaultIsRetryable } from "../src/modules/resilience/defaults.js";
import { TenantRepository } from "../src/modules/tenants/repository.js";
import {
  TENANT_A_API_KEY,
  TENANT_A_ID,
  TENANT_B_API_KEY,
  TENANT_B_ID,
} from "../db/seed-fixtures.js";
import {
  closeTestDb,
  getTestDb,
  isTestDbAvailable,
  truncateRequestLogs,
  truncateUsageLedger,
} from "./setup/db.js";
import type { DbHandle } from "../db/client.js";

const dbAvailable = await isTestDbAvailable();

const ADMIN_TOKEN = "test-admin-token-do-not-use-in-prod";

let app: FastifyInstance;
let handle: DbHandle;
let ledger: UsageLedgerRepository;
let tenantsRepo: TenantRepository;
let breakers: CircuitBreakerRegistry;

// Disable retries so a single forced 5xx triggers exactly one upstream
// attempt per provider — the chat handler then moves to the next
// candidate. Keeps the test's expected provider sequence deterministic.
const fastResilienceConfig = {
  timeoutMs: 5_000,
  retry: { maxAttempts: 1, delaysMs: [], jitterFactor: 0, isRetryable: defaultIsRetryable },
  breaker: { failureThreshold: 9_999, failureWindowMs: 60_000, openCooldownMs: 1_000 },
};

const tenantAHeaders = { authorization: `Bearer ${TENANT_A_API_KEY}` };
const tenantBHeaders = { authorization: `Bearer ${TENANT_B_API_KEY}` };
const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}` };

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
  handle = await getTestDb();
  ledger = new UsageLedgerRepository(handle.db);
  tenantsRepo = new TenantRepository(handle.db);
  breakers = new CircuitBreakerRegistry(fastResilienceConfig.breaker);
  app = await buildApp({
    config,
    logger,
    db: handle.db,
    usageLedger: ledger,
    requestLogs: new RequestLogRepository(handle.db),
    resilience: fastResilienceConfig,
    breakers,
    // Disable cache so a chat request post-failure-mode actually hits the
    // mock provider instead of returning a stale cached success.
    cacheConfig: { enabled: false, ttlMs: 0 },
  });
  await app.ready();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await truncateUsageLedger(handle);
  await truncateRequestLogs(handle);
  breakers.reset();
  // Reset every mock provider back to "normal" between tests so a
  // failure-mode set in one test doesn't leak into the next.
  for (const provider of ["openai", "anthropic"]) {
    await app.inject({
      method: "POST",
      url: `/admin/mock-providers/${provider}/failure-mode`,
      headers: adminHeaders,
      payload: { mode: "normal" },
    });
  }
  // Restore seeded budgets in case a test mutated them.
  await tenantsRepo.setBudget(TENANT_A_ID, 10);
  await tenantsRepo.setBudget(TENANT_B_ID, 2);
});

afterAll(async () => {
  if (app) await app.close();
  await closeTestDb();
});

const chatBody = (overrides: Record<string, unknown> = {}) => ({
  model_class: "cheap",
  messages: [{ role: "user", content: "hello evaluator" }],
  // temperature high enough to bypass cache eligibility regardless of
  // cacheConfig — defense in depth.
  temperature: 0.5,
  ...overrides,
});

// ---------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------

describe.skipIf(!dbAvailable)("admin eval helpers — auth gate", () => {
  it("rejects failure-mode without a Bearer token (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/mock-providers/openai/failure-mode",
      payload: { mode: "fail_5xx" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects reset-usage without a Bearer token (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/admin/tenants/${TENANT_A_ID}/reset-usage`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects set-budget with the wrong token (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/admin/tenants/${TENANT_A_ID}/set-budget`,
      headers: { authorization: "Bearer not-the-admin-token" },
      payload: { monthly_budget_usd: 5 },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------
// POST /admin/mock-providers/:provider/failure-mode
// ---------------------------------------------------------------------

describe.skipIf(!dbAvailable)("POST /admin/mock-providers/:provider/failure-mode", () => {
  // ---- Test 1: failure-mode endpoint changes mock behavior ----------
  it("toggles a mock provider's behavior across requests", async () => {
    // Baseline: tenant_b's allowlist is openai-only, so a normal
    // request must succeed and report provider=openai.
    const before = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: chatBody(),
    });
    expect(before.statusCode).toBe(200);
    expect(JSON.parse(before.payload).provider).toBe("openai");

    // Now flip openai to fail_5xx.
    const set = await app.inject({
      method: "POST",
      url: "/admin/mock-providers/openai/failure-mode",
      headers: adminHeaders,
      payload: { mode: "fail_5xx" },
    });
    expect(set.statusCode).toBe(200);
    const setBody = JSON.parse(set.payload);
    expect(setBody.provider).toBe("openai");
    expect(setBody.failure_mode).toBe("fail_5xx");
    expect(set.headers["x-skyclad-eval-only"]).toBe("true");

    // tenant_b only allows openai, so with no fallback target the
    // request must surface as upstream/all-providers failed (5xx).
    const after = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: chatBody(),
    });
    expect(after.statusCode).toBeGreaterThanOrEqual(500);

    // Reset the mode and confirm tenant_b can succeed again.
    const clear = await app.inject({
      method: "POST",
      url: "/admin/mock-providers/openai/failure-mode",
      headers: adminHeaders,
      payload: { mode: "normal" },
    });
    expect(clear.statusCode).toBe(200);
    expect(JSON.parse(clear.payload).effective).toBeNull();

    const recovered = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: chatBody(),
    });
    expect(recovered.statusCode).toBe(200);
  });

  // ---- Test 2: forced 5xx causes failover ---------------------------
  it("forced 5xx on openai falls over to anthropic for tenant_a", async () => {
    await app.inject({
      method: "POST",
      url: "/admin/mock-providers/openai/failure-mode",
      headers: adminHeaders,
      payload: { mode: "fail_5xx" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: chatBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.provider).toBe("anthropic");
    expect(body.routing.fallback_used).toBe(true);
  });

  // ---- Test 3: forced stream drop produces a partial error event ---
  it("stream_drop_after_chunks emits a partial error SSE event", async () => {
    await app.inject({
      method: "POST",
      url: "/admin/mock-providers/openai/failure-mode",
      headers: adminHeaders,
      payload: { mode: "stream_drop_after_chunks", chunks: 2 },
    });

    // tenant_b is openai-only, so there's no fallback target — the
    // partial-error path must trigger after the second chunk.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: chatBody({ stream: true }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const events = parseSseStream(res.payload);

    // At least the partial error event must be present.
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.partial).toBe(true);

    // The handler may have emitted token chunks before the drop —
    // that's fine, just confirm we did not also emit a clean done.
    expect(events.some((e) => e.type === "done")).toBe(false);

    // Persistence side: a partial_failed request_log row must exist
    // for this tenant. (recordRequestOutcome runs before the socket
    // closes, so the row is durable by the time inject() resolves.)
    const rows = await handle.pool.query(
      "SELECT status FROM request_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1",
      [TENANT_B_ID],
    );
    expect(rows.rows[0]?.status).toBe("partial_failed");
  });

  // ---- Validation gates --------------------------------------------
  it("rejects an unknown provider name with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/mock-providers/cohere/failure-mode",
      headers: adminHeaders,
      payload: { mode: "normal" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects stream_drop_after_chunks without chunks with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/mock-providers/openai/failure-mode",
      headers: adminHeaders,
      payload: { mode: "stream_drop_after_chunks" },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------
// POST /admin/tenants/:tenantId/reset-usage
// ---------------------------------------------------------------------

describe.skipIf(!dbAvailable)("POST /admin/tenants/:tenantId/reset-usage", () => {
  // ---- Test 4 (a): reset helper drops month spend to 0 -------------
  it("wipes the tenant's usage_ledger and reports rows_deleted", async () => {
    // Seed three rows the budget gate would otherwise see as $9.50 spent.
    for (let i = 0; i < 3; i++) {
      await ledger.recordUsage({
        tenantId: TENANT_A_ID,
        provider: "openai",
        model: "gpt-4o-mini",
        requestId: `seed-${i}`,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 3.0,
      });
    }
    const before = await ledger.getCurrentMonthSpend(TENANT_A_ID);
    expect(before).toBeCloseTo(9, 6);

    const res = await app.inject({
      method: "POST",
      url: `/admin/tenants/${TENANT_A_ID}/reset-usage`,
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.tenant_id).toBe(TENANT_A_ID);
    expect(body.rows_deleted).toBe(3);
    expect(res.headers["x-skyclad-eval-only"]).toBe("true");

    const after = await ledger.getCurrentMonthSpend(TENANT_A_ID);
    expect(after).toBe(0);
  });

  it("returns rows_deleted=0 when the tenant had no usage rows", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/admin/tenants/${TENANT_A_ID}/reset-usage`,
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).rows_deleted).toBe(0);
  });

  it("does not touch other tenants' ledger rows", async () => {
    await ledger.recordUsage({
      tenantId: TENANT_A_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      requestId: "iso-a",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 1,
    });
    await ledger.recordUsage({
      tenantId: TENANT_B_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      requestId: "iso-b",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 1,
    });

    await app.inject({
      method: "POST",
      url: `/admin/tenants/${TENANT_A_ID}/reset-usage`,
      headers: adminHeaders,
    });

    expect(await ledger.getCurrentMonthSpend(TENANT_A_ID)).toBe(0);
    expect(await ledger.getCurrentMonthSpend(TENANT_B_ID)).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------
// POST /admin/tenants/:tenantId/set-budget
// ---------------------------------------------------------------------

describe.skipIf(!dbAvailable)("POST /admin/tenants/:tenantId/set-budget", () => {
  it("lowering the budget below current spend rejects the next request with 402", async () => {
    // tenant_b (allowlist openai-only, seeded budget $2) has $0 spent.
    // Drop the cap to $0.0001; even one $0-cost request shouldn't pass
    // the gate because seeded spend after one call exceeds it. To keep
    // the test independent of estimation, write a small ledger row
    // first and then check the gate.
    await ledger.recordUsage({
      tenantId: TENANT_B_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      requestId: "pre-cap",
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.5,
    });

    const set = await app.inject({
      method: "POST",
      url: `/admin/tenants/${TENANT_B_ID}/set-budget`,
      headers: adminHeaders,
      payload: { monthly_budget_usd: 0.1 },
    });
    expect(set.statusCode).toBe(200);
    expect(JSON.parse(set.payload).monthly_budget_usd).toBeCloseTo(0.1, 6);

    const blocked = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: chatBody(),
    });
    expect(blocked.statusCode).toBe(402);
    expect(JSON.parse(blocked.payload).error).toBe("TENANT_BUDGET_EXCEEDED");
  });

  it("raising the budget back above spend lets the next request through", async () => {
    await ledger.recordUsage({
      tenantId: TENANT_B_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      requestId: "pre-raise",
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.5,
    });
    await app.inject({
      method: "POST",
      url: `/admin/tenants/${TENANT_B_ID}/set-budget`,
      headers: adminHeaders,
      payload: { monthly_budget_usd: 0.1 },
    });

    // Confirm we're blocked.
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: chatBody(),
    });
    expect(blocked.statusCode).toBe(402);

    // Raise the cap back over current spend.
    await app.inject({
      method: "POST",
      url: `/admin/tenants/${TENANT_B_ID}/set-budget`,
      headers: adminHeaders,
      payload: { monthly_budget_usd: 25 },
    });

    const ok = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: chatBody(),
    });
    expect(ok.statusCode).toBe(200);
  });

  it("returns 404 for an unknown tenant", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/tenants/00000000-0000-0000-0000-deadbeefdead/set-budget",
      headers: adminHeaders,
      payload: { monthly_budget_usd: 10 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a negative budget with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/admin/tenants/${TENANT_A_ID}/set-budget`,
      headers: adminHeaders,
      payload: { monthly_budget_usd: -1 },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

interface ParsedSseEvent {
  type: string;
  content?: string;
  message?: string;
  partial?: boolean;
}

function parseSseStream(payload: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  for (const block of payload.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed.startsWith("data:")) continue;
    const json = trimmed.slice("data:".length).trim();
    if (!json) continue;
    events.push(JSON.parse(json) as ParsedSseEvent);
  }
  return events;
}
