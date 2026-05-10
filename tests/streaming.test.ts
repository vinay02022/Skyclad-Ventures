import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { UsageLedgerRepository } from "../src/modules/budget/repository.js";
import { RequestLogRepository } from "../src/modules/persistence/request-logs-repo.js";
import { CircuitBreakerRegistry } from "../src/modules/resilience/circuit-breaker.js";
import { defaultIsRetryable } from "../src/modules/resilience/defaults.js";
import { formatSSEEvent } from "../src/modules/streaming/sse.js";
import {
  TENANT_A_API_KEY,
  TENANT_A_ID,
  TENANT_B_API_KEY,
} from "../db/seed-fixtures.js";
import {
  closeTestDb,
  getTestDb,
  isTestDbAvailable,
  truncateCacheEntries,
  truncateRequestLogs,
  truncateUsageLedger,
} from "./setup/db.js";
import type { DbHandle } from "../db/client.js";

const dbAvailable = await isTestDbAvailable();

let app: FastifyInstance;
let handle: DbHandle;
let ledger: UsageLedgerRepository;
let requestLogs: RequestLogRepository;
let breakers: CircuitBreakerRegistry;

// Streaming tests assert on SSE wire format and partial-failure semantics,
// not on retry timing. Disable retries (so a pre-stream-drop is one upstream
// attempt, exactly like the failover loop expects) and keep the breaker out
// of the way of test isolation.
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
  });
  const logger = createLogger(config);
  handle = await getTestDb();
  ledger = new UsageLedgerRepository(handle.db);
  requestLogs = new RequestLogRepository(handle.db);
  breakers = new CircuitBreakerRegistry(fastResilienceConfig.breaker);
  app = await buildApp({
    config,
    logger,
    db: handle.db,
    usageLedger: ledger,
    requestLogs,
    resilience: fastResilienceConfig,
    breakers,
  });
  await app.ready();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await truncateCacheEntries(handle);
  await truncateUsageLedger(handle);
  await truncateRequestLogs(handle);
  breakers.reset();
});

afterAll(async () => {
  if (app) await app.close();
  await closeTestDb();
});

const tenantAHeaders = { authorization: `Bearer ${TENANT_A_API_KEY}` };
const tenantBHeaders = { authorization: `Bearer ${TENANT_B_API_KEY}` };
const streamBody = (overrides: Record<string, unknown> = {}) => ({
  model_class: "cheap",
  messages: [{ role: "user", content: "tell me a joke" }],
  stream: true,
  ...overrides,
});

// --- helpers ---------------------------------------------------------

interface ParsedSseEvent {
  type: string;
  content?: string;
  message?: string;
  partial?: boolean;
}

/**
 * Parse the body of an inject() SSE response into the ordered list of
 * decoded `data:` payloads. Empty lines between events are ignored.
 */
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

// ---------------------------------------------------------------------
// formatSSEEvent unit tests — pure, no DB.
// ---------------------------------------------------------------------

describe("formatSSEEvent", () => {
  it("emits one data: line followed by the required blank line", () => {
    const out = formatSSEEvent({ type: "token", content: "hi" });
    expect(out).toBe('data: {"type":"token","content":"hi"}\n\n');
  });

  it("emits done with no content field", () => {
    expect(formatSSEEvent({ type: "done" })).toBe('data: {"type":"done"}\n\n');
  });

  it("emits error with partial flag", () => {
    expect(
      formatSSEEvent({ type: "error", message: "oops", partial: true }),
    ).toBe('data: {"type":"error","message":"oops","partial":true}\n\n');
  });
});

// ---------------------------------------------------------------------
// Handler integration — end-to-end through Fastify, asserting on the
// 5 assignment-required scenarios.
// ---------------------------------------------------------------------

describe.skipIf(!dbAvailable)("POST /v1/chat/completions streaming", () => {
  it("returns text/event-stream with token events and a final done event", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: streamBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toContain("no-cache");

    const events = parseSseStream(res.payload);
    expect(events.length).toBeGreaterThan(1); // at least one token + done
    expect(events.at(-1)).toEqual({ type: "done" });

    const tokens = events.filter((e) => e.type === "token");
    expect(tokens.length).toBeGreaterThan(0);
    // Mock providers prepend "[mock-openai]" / "[mock-anthropic]"; cheap
    // class routes to openai first.
    const joined = tokens.map((t) => t.content).join("");
    expect(joined).toContain("[mock-openai]");
  });

  it("writes usage_ledger and request_logs (streaming=true, status=success) on a clean stream", async () => {
    const before = await ledger.getCurrentMonthSpend(TENANT_A_ID);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: streamBody(),
    });
    expect(res.statusCode).toBe(200);

    const after = await ledger.getCurrentMonthSpend(TENANT_A_ID);
    expect(after).toBeGreaterThan(before);

    const rows = await handle.pool.query(
      "SELECT status, streaming, cache_hit, provider, output_tokens FROM request_logs WHERE tenant_id = $1",
      [TENANT_A_ID],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      status: "success",
      streaming: true,
      cache_hit: false,
      provider: "openai",
    });
    expect(rows.rows[0].output_tokens).toBeGreaterThan(0);
  });

  it("bypasses the cache entirely (no read, no write) for streaming requests", async () => {
    // Prime the cache with a non-streaming request first so we can prove
    // the streaming request neither reads the existing entry nor adds
    // a new one. (Different message body than the stream call to keep
    // the cache row from being relevant either way.)
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: { model_class: "cheap", messages: [{ role: "user", content: "warm cache" }] },
    });
    const cacheBefore = await handle.pool.query(
      "SELECT count(*)::int AS n FROM cache_entries WHERE tenant_id = $1",
      [TENANT_A_ID],
    );
    expect(cacheBefore.rows[0].n).toBe(1);

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: streamBody(),
    });
    expect(res.statusCode).toBe(200);

    const cacheAfter = await handle.pool.query(
      "SELECT count(*)::int AS n FROM cache_entries WHERE tenant_id = $1",
      [TENANT_A_ID],
    );
    expect(cacheAfter.rows[0].n).toBe(1); // exactly the warm-cache row, no new one
  });

  it("falls over to anthropic when openai pre-stream-drops (no byte sent yet)", async () => {
    // Cheap class normally routes to openai. Forcing pre-stream-drop on
    // openai must cause a clean failover to anthropic — the client sees
    // no error event, just anthropic's tokens followed by done.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        ...tenantAHeaders,
        "x-skyclad-fail": "pre-stream-drop",
        "x-skyclad-fail-provider": "openai",
      },
      payload: streamBody(),
    });
    expect(res.statusCode).toBe(200);
    const events = parseSseStream(res.payload);
    expect(events.at(-1)).toEqual({ type: "done" });

    const tokens = events.filter((e) => e.type === "token");
    const joined = tokens.map((t) => t.content).join("");
    // anthropic answered, not openai
    expect(joined).toContain("[mock-anthropic]");
    expect(joined).not.toContain("[mock-openai]");
    expect(events.some((e) => e.type === "error")).toBe(false);

    // The successful provider is recorded, not the one that dropped.
    const rows = await handle.pool.query(
      "SELECT provider, status FROM request_logs WHERE tenant_id = $1",
      [TENANT_A_ID],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      provider: "anthropic",
      status: "success",
    });
  });

  it("emits a partial error event after upstream drops mid-stream (NO failover)", async () => {
    // openai emits 2 token chunks, then drops. Client must see those 2
    // tokens followed by exactly ONE error event with partial:true,
    // then nothing else. NEVER fall over to anthropic — the client is
    // already committed to the partial response.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        ...tenantAHeaders,
        "x-skyclad-fail": "stream-drop",
        "x-skyclad-fail-after": "2",
        "x-skyclad-fail-provider": "openai",
      },
      payload: streamBody(),
    });
    expect(res.statusCode).toBe(200);
    const events = parseSseStream(res.payload);

    const tokens = events.filter((e) => e.type === "token");
    expect(tokens.length).toBe(2);
    // Only openai's tokens; we never tried anthropic after the drop.
    expect(tokens.map((t) => t.content).join("")).toContain("[mock-openai]");

    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatchObject({
      type: "error",
      partial: true,
    });
    expect(errors[0]!.message).toContain("partial");

    // No "done" event after a partial drop — the response is incomplete
    // by definition.
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("logs the partial failure to request_logs (streaming=true, status=partial_failed) and bills usage", async () => {
    const before = await ledger.getCurrentMonthSpend(TENANT_A_ID);

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        ...tenantAHeaders,
        "x-skyclad-fail": "stream-drop",
        "x-skyclad-fail-after": "2",
        "x-skyclad-fail-provider": "openai",
      },
      payload: streamBody(),
    });

    // Honest accounting: the upstream did real work for the bytes the
    // client received, so the tenant pays for those tokens.
    const after = await ledger.getCurrentMonthSpend(TENANT_A_ID);
    expect(after).toBeGreaterThan(before);

    const rows = await handle.pool.query(
      "SELECT status, streaming, provider, output_tokens, error_type FROM request_logs WHERE tenant_id = $1",
      [TENANT_A_ID],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      status: "partial_failed",
      streaming: true,
      provider: "openai",
    });
    expect(rows.rows[0].output_tokens).toBeGreaterThan(0);
    expect(rows.rows[0].error_type).toBeTruthy();
  });

  it("emits one error event (partial:false) and logs all_providers_failed when every candidate pre-drops", async () => {
    // No targetProvider -> both openai and anthropic pre-stream-drop.
    // The failover loop walks the whole list without ever sending a
    // byte, then emits a single error event with partial:false.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...tenantAHeaders, "x-skyclad-fail": "pre-stream-drop" },
      payload: streamBody(),
    });
    expect(res.statusCode).toBe(200);
    const events = parseSseStream(res.payload);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ type: "error", partial: false });

    const rows = await handle.pool.query(
      "SELECT status, streaming, provider FROM request_logs WHERE tenant_id = $1",
      [TENANT_A_ID],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].status).toBe("all_providers_failed");
    expect(rows.rows[0].streaming).toBe(true);
    expect(rows.rows[0].provider).toBeNull();
  });

  it("still enforces tenant isolation: tenant_b's stream succeeds even if tenant_a streamed concurrently", async () => {
    // Lightweight isolation check — we don't share any rate-limit /
    // budget / breaker state across tenants in the streaming path.
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: tenantAHeaders,
        payload: streamBody(),
      }),
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: tenantBHeaders,
        payload: streamBody(),
      }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(parseSseStream(a.payload).at(-1)).toEqual({ type: "done" });
    expect(parseSseStream(b.payload).at(-1)).toEqual({ type: "done" });
  });
});
