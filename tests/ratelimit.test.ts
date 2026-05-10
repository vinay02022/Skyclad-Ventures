import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { InMemoryRateLimiter } from "../src/modules/ratelimit/rate-limiter.js";
import { TokenBucket } from "../src/modules/ratelimit/token-bucket.js";
import { TENANT_A_API_KEY, TENANT_B_API_KEY } from "../db/seed-fixtures.js";
import {
  closeTestDb,
  getTestDb,
  isTestDbAvailable,
  truncateUsageLedger,
} from "./setup/db.js";
import type { DbHandle } from "../db/client.js";

// --- TokenBucket pure unit tests (no app, no DB) -----------------------

describe("TokenBucket", () => {
  it("starts full and drains one token per call", () => {
    const now = 1_000_000;
    const bucket = new TokenBucket({ capacity: 3, refillPerMs: 0, now: () => now });

    expect(bucket.tryConsume().allowed).toBe(true);
    expect(bucket.tryConsume().allowed).toBe(true);
    expect(bucket.tryConsume().allowed).toBe(true);

    const blocked = bucket.tryConsume();
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    // refillPerMs = 0 -> a request at this size will never accumulate.
    expect(blocked.retryAfterMs).toBe(Number.POSITIVE_INFINITY);
  });

  it("refills proportionally to elapsed time, capped at capacity", () => {
    let now = 1_000_000;
    // capacity=10, 10 tokens per second -> refillPerMs = 0.01
    const bucket = new TokenBucket({ capacity: 10, refillPerMs: 0.01, now: () => now });

    // Drain it.
    for (let i = 0; i < 10; i++) bucket.tryConsume();
    expect(bucket.tryConsume().allowed).toBe(false);

    // Advance 500ms -> 5 tokens back.
    now += 500;
    let snap = bucket.snapshot();
    expect(snap.tokens).toBeLessThanOrEqual(10);
    // First five consume calls succeed, sixth fails.
    for (let i = 0; i < 5; i++) {
      expect(bucket.tryConsume().allowed).toBe(true);
    }
    expect(bucket.tryConsume().allowed).toBe(false);

    // Advance well past full -> should NOT exceed capacity.
    now += 10_000;
    bucket.tryConsume();
    snap = bucket.snapshot();
    expect(snap.tokens).toBeLessThanOrEqual(snap.capacity);
  });

  it("retryAfterMs estimates how long until one token is available", () => {
    let now = 1_000_000;
    const bucket = new TokenBucket({ capacity: 1, refillPerMs: 0.001, now: () => now });
    expect(bucket.tryConsume().allowed).toBe(true);
    const denied = bucket.tryConsume();
    expect(denied.allowed).toBe(false);
    // 1 token / 0.001 tokens-per-ms = 1000ms
    expect(denied.retryAfterMs).toBe(1000);
  });

  it("reconfigure resizes capacity and clamps tokens", () => {
    let now = 1_000_000;
    const bucket = new TokenBucket({ capacity: 10, refillPerMs: 0.001, now: () => now });
    // Bucket starts full at 10. Shrink to 3 -> tokens should clamp to 3.
    bucket.reconfigure(3, 0.001);
    expect(bucket.snapshot().capacity).toBe(3);
    expect(bucket.snapshot().tokens).toBeLessThanOrEqual(3);
  });
});

// --- InMemoryRateLimiter unit tests ------------------------------------

describe("InMemoryRateLimiter", () => {
  it("creates one bucket per tenant; one tenant cannot drain another", () => {
    let now = 1_000_000;
    const limiter = new InMemoryRateLimiter({ now: () => now });

    // tenant_a: limit 3/min. Drain it.
    for (let i = 0; i < 3; i++) {
      expect(limiter.checkPerMinute("tenant_a", 3).allowed).toBe(true);
    }
    expect(limiter.checkPerMinute("tenant_a", 3).allowed).toBe(false);

    // tenant_b is untouched.
    expect(limiter.checkPerMinute("tenant_b", 3).allowed).toBe(true);
  });

  it("resizes a tenant's bucket when their config changes mid-flight", () => {
    let now = 1_000_000;
    const limiter = new InMemoryRateLimiter({ now: () => now });
    // First call sizes the bucket at 5.
    limiter.checkPerMinute("tenant_a", 5);
    // Second call with a smaller cap should reconfigure (and clamp).
    const r = limiter.checkPerMinute("tenant_a", 2);
    expect(r.capacity).toBe(2);
    expect(r.allowed).toBe(true);
  });

  it("reset() drops every bucket (test helper)", () => {
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < 60; i++) limiter.checkPerMinute("tenant_a", 60);
    expect(limiter.checkPerMinute("tenant_a", 60).allowed).toBe(false);
    limiter.reset();
    expect(limiter.checkPerMinute("tenant_a", 60).allowed).toBe(true);
  });
});

// --- Integration: rate-limiting via the chat endpoint -----------------

const dbAvailable = await isTestDbAvailable();

let app: FastifyInstance;
let handle: DbHandle;
let limiter: InMemoryRateLimiter;

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
  // We hold a reference to the limiter so beforeEach can reset it between
  // scenarios; tests for rate limiting need predictable starting state.
  limiter = new InMemoryRateLimiter();
  app = await buildApp({ config, logger, db: handle.db, rateLimiter: limiter });
  await app.ready();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  limiter.reset();
  // Also clear the ledger so the budget gate never fires unexpectedly.
  await truncateUsageLedger(handle);
});

afterAll(async () => {
  if (app) await app.close();
  await closeTestDb();
});

const tenantAHeaders = { authorization: `Bearer ${TENANT_A_API_KEY}` };
const tenantBHeaders = { authorization: `Bearer ${TENANT_B_API_KEY}` };
const goodBody = () => ({
  model_class: "cheap",
  messages: [{ role: "user", content: "hi" }],
});

describe.skipIf(!dbAvailable)("rate limiting on POST /v1/chat/completions", () => {
  it("uses the per-tenant limit loaded from Postgres (tenant_b = 10/min)", async () => {
    // tenant_b's seeded rate_limit_per_minute is 10. Burst 10 -> success;
    // 11th -> 429 with TENANT_RATE_LIMITED.
    for (let i = 0; i < 10; i++) {
      const ok = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: tenantBHeaders,
        payload: goodBody(),
      });
      expect(ok.statusCode, `call #${i + 1} should succeed`).toBe(200);
      expect(ok.headers["x-ratelimit-limit"]).toBe("10");
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: goodBody(),
    });
    expect(blocked.statusCode).toBe(429);
    const body = blocked.json();
    expect(body.error).toBe("TENANT_RATE_LIMITED");
    expect(body.retry_after_ms).toBeGreaterThan(0);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(blocked.headers["x-ratelimit-limit"]).toBe("10");
    expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("isolates rate-limit counters per tenant: A unaffected while B is throttled", async () => {
    // Drain tenant_b's bucket (10/min).
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: tenantBHeaders,
        payload: goodBody(),
      });
    }
    const blockedB = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: goodBody(),
    });
    expect(blockedB.statusCode).toBe(429);

    // tenant_a should still flow through fine, with its own 60/min limit.
    const allowedA = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: goodBody(),
    });
    expect(allowedA.statusCode).toBe(200);
    expect(allowedA.headers["x-ratelimit-limit"]).toBe("60");
  });

  it("includes Retry-After (seconds) and TENANT_RATE_LIMITED when throttled", async () => {
    // Drain tenant_b
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: tenantBHeaders,
        payload: goodBody(),
      });
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: goodBody(),
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("TENANT_RATE_LIMITED");
    const ra = Number(blocked.headers["retry-after"]);
    expect(Number.isFinite(ra)).toBe(true);
    expect(ra).toBeGreaterThanOrEqual(1);
  });

});
