import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { UsageLedgerRepository } from "../src/modules/budget/repository.js";
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
  truncateUsageLedger,
} from "./setup/db.js";
import type { DbHandle } from "../db/client.js";

const dbAvailable = await isTestDbAvailable();

let app: FastifyInstance;
let handle: DbHandle;
let ledger: UsageLedgerRepository;

beforeAll(async () => {
  if (!dbAvailable) return;
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgres://gateway:gateway@localhost:5432/gateway_test",
  });
  const logger = createLogger(config);
  handle = await getTestDb();
  ledger = new UsageLedgerRepository(handle.db);
  // Inject the same ledger instance the app uses, so tests can read back
  // exactly what the handler wrote.
  app = await buildApp({ config, logger, db: handle.db, usageLedger: ledger });
  await app.ready();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  // Each test starts from a clean ledger (and therefore $0 spend) so
  // scenarios are independent and self-explanatory.
  await truncateUsageLedger(handle);
});

afterAll(async () => {
  if (app) await app.close();
  await closeTestDb();
});

const tenantAHeaders = { authorization: `Bearer ${TENANT_A_API_KEY}` };
const tenantBHeaders = { authorization: `Bearer ${TENANT_B_API_KEY}` };
const goodBody = (overrides: Record<string, unknown> = {}) => ({
  model_class: "cheap",
  messages: [{ role: "user", content: "hello there" }],
  ...overrides,
});

describe.skipIf(!dbAvailable)("UsageLedgerRepository", () => {
  it("returns 0 spend for a tenant with no ledger rows", async () => {
    const spent = await ledger.getCurrentMonthSpend(TENANT_A_ID);
    expect(spent).toBe(0);
  });

  it("recordUsage round-trips through getCurrentMonthSpend", async () => {
    await ledger.recordUsage({
      tenantId: TENANT_A_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      requestId: "req-budget-roundtrip",
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0.001234,
    });
    const spent = await ledger.getCurrentMonthSpend(TENANT_A_ID);
    expect(spent).toBeCloseTo(0.001234, 6);
  });

  it("isolates spend between tenants", async () => {
    await ledger.recordUsage({
      tenantId: TENANT_A_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      requestId: "req-iso-a",
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.5,
    });
    expect(await ledger.getCurrentMonthSpend(TENANT_A_ID)).toBeCloseTo(0.5, 6);
    expect(await ledger.getCurrentMonthSpend(TENANT_B_ID)).toBe(0);
  });
});

describe.skipIf(!dbAvailable)("budget enforcement on POST /v1/chat/completions", () => {
  it("succeeds when tenant_a is well within budget and writes a usage_ledger row", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: goodBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cost_usd).toBeGreaterThan(0);

    // The handler should have appended exactly one row. Sum it back.
    const spent = await ledger.getCurrentMonthSpend(TENANT_A_ID);
    expect(spent).toBeCloseTo(body.cost_usd, 6);

    // Spot-check the row's columns.
    const rows = await handle.pool.query(
      `SELECT tenant_id, provider, model, request_id, input_tokens, output_tokens, cost_usd
       FROM usage_ledger
       WHERE request_id = $1`,
      [body.id],
    );
    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0];
    expect(row.tenant_id).toBe(TENANT_A_ID);
    expect(row.provider).toBe(body.provider);
    expect(row.model).toBe(body.model);
    expect(row.input_tokens).toBe(body.usage.input_tokens);
    expect(row.output_tokens).toBe(body.usage.output_tokens);
    expect(Number(row.cost_usd)).toBeCloseTo(body.cost_usd, 6);
  });

  it("rejects tenant_b with 402 TENANT_BUDGET_EXCEEDED when the ledger sum is at-or-above the budget", async () => {
    // tenant_b's seeded budget is $2. Push spend to $2.50 so the gate trips
    // on the *next* request.
    await ledger.recordUsage({
      tenantId: TENANT_B_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      requestId: "req-budget-pre-seed",
      inputTokens: 1000,
      outputTokens: 2000,
      costUsd: 2.5,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: goodBody(),
    });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.error).toBe("TENANT_BUDGET_EXCEEDED");
    expect(body.spent_usd).toBeCloseTo(2.5, 4);
    expect(body.budget_usd).toBeCloseTo(2.0, 4);

    // Ledger must NOT grow when the budget gate fires (we never called
    // the provider, so there is nothing to charge).
    const spentAfter = await ledger.getCurrentMonthSpend(TENANT_B_ID);
    expect(spentAfter).toBeCloseTo(2.5, 6);
  });

  it("isolates tenants: tenant_a still succeeds while tenant_b is over-budget", async () => {
    // Same setup as above: tenant_b is intentionally over budget.
    await ledger.recordUsage({
      tenantId: TENANT_B_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      requestId: "req-iso-b-overspend",
      inputTokens: 1000,
      outputTokens: 2000,
      costUsd: 5.0,
    });

    const blocked = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: goodBody(),
    });
    expect(blocked.statusCode).toBe(402);

    const allowed = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: goodBody(),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().provider).toBe("openai");

    // tenant_a's spend reflects exactly its own ledger row, not tenant_b's.
    const aSpent = await ledger.getCurrentMonthSpend(TENANT_A_ID);
    const bSpent = await ledger.getCurrentMonthSpend(TENANT_B_ID);
    expect(aSpent).toBeCloseTo(allowed.json().cost_usd, 6);
    expect(bSpent).toBeCloseTo(5.0, 6);
  });
});
