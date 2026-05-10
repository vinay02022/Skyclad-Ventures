import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { UsageLedgerRepository } from "../src/modules/budget/repository.js";
import { CacheRepository } from "../src/modules/cache/repository.js";
import { buildCacheKey } from "../src/modules/cache/key.js";
import { isCacheable } from "../src/modules/cache/policy.js";
import { CircuitBreakerRegistry } from "../src/modules/resilience/circuit-breaker.js";
import { defaultIsRetryable } from "../src/modules/resilience/defaults.js";
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
  truncateCacheEntries,
  truncateUsageLedger,
} from "./setup/db.js";
import type { DbHandle } from "../db/client.js";

const dbAvailable = await isTestDbAvailable();

let app: FastifyInstance;
let handle: DbHandle;
let ledger: UsageLedgerRepository;
let breakers: CircuitBreakerRegistry;

// Cache tests don't care about retries or breakers; mirror chat.test.ts
// so the assertions stay focused on cache behaviour.
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
  breakers = new CircuitBreakerRegistry(fastResilienceConfig.breaker);
  app = await buildApp({
    config,
    logger,
    db: handle.db,
    usageLedger: ledger,
    resilience: fastResilienceConfig,
    breakers,
    // Default 5-min TTL — long enough that no test in this file expires
    // it before assertion time. The TTL-expiry test fakes expiry by
    // hand-mutating the row's expires_at, which is more deterministic
    // than waiting on a clock.
  });
  await app.ready();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  // Each test starts from an empty cache + empty ledger so scenarios are
  // independent. Tenants and provider_configs are kept (expensive to
  // reseed and these tests don't mutate them).
  await truncateCacheEntries(handle);
  await truncateUsageLedger(handle);
  breakers.reset();
});

afterAll(async () => {
  if (app) await app.close();
  await closeTestDb();
});

const tenantAHeaders = { authorization: `Bearer ${TENANT_A_API_KEY}` };
const tenantBHeaders = { authorization: `Bearer ${TENANT_B_API_KEY}` };
const cacheableBody = (overrides: Record<string, unknown> = {}) => ({
  model_class: "cheap",
  messages: [{ role: "user", content: "what is 2 + 2" }],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Pure-unit tests: no DB, no Fastify. The handler-level integration tests
// below cover the wiring.
// ---------------------------------------------------------------------------

describe("buildCacheKey", () => {
  it("is deterministic for identical inputs", () => {
    const input = {
      tenantId: TENANT_A_ID,
      modelClass: "cheap" as const,
      provider: "openai",
      model: "gpt-4o-mini",
      messages: [{ role: "user" as const, content: "hello" }],
      temperature: 0,
      maxTokens: 256,
    };
    expect(buildCacheKey(input)).toBe(buildCacheKey(input));
  });

  it("includes tenant_id: same body, different tenants -> different keys", () => {
    const base = {
      modelClass: "cheap" as const,
      provider: "openai",
      model: "gpt-4o-mini",
      messages: [{ role: "user" as const, content: "hello" }],
      temperature: 0,
      maxTokens: 256,
    };
    expect(buildCacheKey({ ...base, tenantId: TENANT_A_ID })).not.toBe(
      buildCacheKey({ ...base, tenantId: TENANT_B_ID }),
    );
  });

  it("includes provider/model: routing to a different upstream changes the key", () => {
    const base = {
      tenantId: TENANT_A_ID,
      modelClass: "cheap" as const,
      messages: [{ role: "user" as const, content: "hello" }],
      temperature: 0,
      maxTokens: 256,
    };
    expect(buildCacheKey({ ...base, provider: "openai", model: "gpt-4o-mini" })).not.toBe(
      buildCacheKey({ ...base, provider: "anthropic", model: "claude-3-haiku-20240307" }),
    );
  });

  it("ignores message fields outside {role, content}", () => {
    // The cache must not be invalidated by transient envelope fields a
    // caller might attach later (timestamps, ids).
    const a = buildCacheKey({
      tenantId: TENANT_A_ID,
      modelClass: "cheap",
      provider: "openai",
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0,
      maxTokens: 256,
    });
    const b = buildCacheKey({
      tenantId: TENANT_A_ID,
      modelClass: "cheap",
      provider: "openai",
      model: "gpt-4o-mini",
      messages: [
        // @ts-expect-error -- extra fields must be ignored on purpose
        { role: "user", content: "hello", id: "abc-123", ts: 999 },
      ],
      temperature: 0,
      maxTokens: 256,
    });
    expect(a).toBe(b);
  });

  it("returns a 64-char lowercase hex string (sha256)", () => {
    const k = buildCacheKey({
      tenantId: TENANT_A_ID,
      modelClass: "cheap",
      provider: "openai",
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "x" }],
      temperature: 0,
      maxTokens: 1,
    });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isCacheable", () => {
  it("true for non-streaming, temperature 0", () => {
    expect(
      isCacheable({
        model_class: "cheap",
        messages: [{ role: "user", content: "x" }],
        stream: false,
        temperature: 0,
        max_tokens: 256,
      }),
    ).toBe(true);
  });

  it("false when streaming", () => {
    expect(
      isCacheable({
        model_class: "cheap",
        messages: [{ role: "user", content: "x" }],
        stream: true,
        temperature: 0,
        max_tokens: 256,
      }),
    ).toBe(false);
  });

  it("false when temperature > 0", () => {
    expect(
      isCacheable({
        model_class: "cheap",
        messages: [{ role: "user", content: "x" }],
        stream: false,
        temperature: 0.7,
        max_tokens: 256,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Repository round-trip (no Fastify, just Postgres).
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)("CacheRepository", () => {
  it("get returns null for an empty cache", async () => {
    const repo = new CacheRepository(handle.db);
    expect(await repo.get(TENANT_A_ID, "no-such-key")).toBeNull();
  });

  it("set then get round-trips the payload", async () => {
    const repo = new CacheRepository(handle.db);
    const key = "k-roundtrip";
    await repo.set({
      tenantId: TENANT_A_ID,
      cacheKey: key,
      payload: {
        model_class: "cheap",
        provider: "openai",
        model: "gpt-4o-mini",
        message: { role: "assistant", content: "[mock-openai] hi" },
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      },
      ttlMs: 60_000,
    });
    const got = await repo.get(TENANT_A_ID, key);
    expect(got).not.toBeNull();
    expect(got!.message.content).toBe("[mock-openai] hi");
    expect(got!.usage.total_tokens).toBe(7);
  });

  it("does not return another tenant's row even with the same cache_key", async () => {
    // Defense-in-depth: the SHA256 already encodes tenant_id, so callers
    // would never reuse the same cache_key across tenants in practice.
    // This proves the repo's WHERE clause holds even if they did.
    const repo = new CacheRepository(handle.db);
    const sharedKey = "shared-by-bug";
    await repo.set({
      tenantId: TENANT_A_ID,
      cacheKey: sharedKey,
      payload: {
        model_class: "cheap",
        provider: "openai",
        model: "gpt-4o-mini",
        message: { role: "assistant", content: "tenant_a payload" },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
      ttlMs: 60_000,
    });
    expect(await repo.get(TENANT_B_ID, sharedKey)).toBeNull();
    expect((await repo.get(TENANT_A_ID, sharedKey))!.message.content).toBe(
      "tenant_a payload",
    );
  });

  it("set with the same (tenant, key) is an upsert (no duplicate row)", async () => {
    const repo = new CacheRepository(handle.db);
    const key = "k-upsert";
    const base = {
      model_class: "cheap" as const,
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    await repo.set({
      tenantId: TENANT_A_ID,
      cacheKey: key,
      payload: { ...base, message: { role: "assistant", content: "v1" } },
      ttlMs: 60_000,
    });
    await repo.set({
      tenantId: TENANT_A_ID,
      cacheKey: key,
      payload: { ...base, message: { role: "assistant", content: "v2" } },
      ttlMs: 60_000,
    });
    const got = await repo.get(TENANT_A_ID, key);
    expect(got!.message.content).toBe("v2");
    const { rowCount } = await handle.pool.query(
      "SELECT 1 FROM cache_entries WHERE tenant_id = $1 AND cache_key = $2",
      [TENANT_A_ID, key],
    );
    expect(rowCount).toBe(1);
  });

  it("expired entries are not returned", async () => {
    const repo = new CacheRepository(handle.db);
    const key = "k-expired";
    await repo.set({
      tenantId: TENANT_A_ID,
      cacheKey: key,
      payload: {
        model_class: "cheap",
        provider: "openai",
        model: "gpt-4o-mini",
        message: { role: "assistant", content: "stale" },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
      ttlMs: 60_000,
    });
    // Stamp it into the past, deterministically.
    await handle.pool.query(
      "UPDATE cache_entries SET expires_at = now() - interval '1 second' WHERE tenant_id = $1 AND cache_key = $2",
      [TENANT_A_ID, key],
    );
    expect(await repo.get(TENANT_A_ID, key)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Handler integration: end-to-end through Fastify, verifying the chat
// route honours all five caching rules from the assignment.
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)("POST /v1/chat/completions caching", () => {
  it("same deterministic request returns a cache hit on the second call", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: cacheableBody(),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.cached).toBe(false);
    expect(firstBody.cost_usd).toBeGreaterThan(0);
    expect(firstBody.routing.policy).toBe("cost-optimized");

    const second = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: cacheableBody(),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.cached).toBe(true);
    // Cache hits don't bill the tenant.
    expect(secondBody.cost_usd).toBe(0);
    // routing block reflects that this came from cache, not the policy.
    expect(secondBody.routing.policy).toBe("cache");
    expect(secondBody.routing.reason).toBe("cache_hit");
    // Response identity is fresh; payload is the cached one.
    expect(secondBody.id).toBe(second.headers["x-request-id"]);
    expect(secondBody.id).not.toBe(firstBody.id);
    expect(secondBody.message.content).toBe(firstBody.message.content);
    expect(secondBody.provider).toBe(firstBody.provider);
    expect(secondBody.model).toBe(firstBody.model);
    expect(secondBody.usage).toEqual(firstBody.usage);
  });

  it("does not write a usage_ledger row on cache hit", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: cacheableBody(),
    });
    const spendAfterFirst = await ledger.getCurrentMonthSpend(TENANT_A_ID);
    expect(spendAfterFirst).toBeGreaterThan(0);

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: cacheableBody(),
    });
    const spendAfterHit = await ledger.getCurrentMonthSpend(TENANT_A_ID);
    expect(spendAfterHit).toBe(spendAfterFirst);
  });

  it("tenant_b does NOT hit tenant_a's cached response (cross-tenant isolation)", async () => {
    // Prime tenant_a's cache.
    const aRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: cacheableBody(),
    });
    expect(aRes.json().cached).toBe(false);

    // Same body, different tenant. Must MISS and call the provider.
    const bRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantBHeaders,
      payload: cacheableBody(),
    });
    expect(bRes.statusCode).toBe(200);
    expect(bRes.json().cached).toBe(false);
    expect(bRes.json().cost_usd).toBeGreaterThan(0);

    // ...and the request_id of the assistant content reflects tenant_b's
    // own provider call, not tenant_a's cached payload. Mock providers
    // don't echo request id, but storage isolation is the strong claim:
    // verify two distinct cache rows exist, one per tenant.
    const { rowCount } = await handle.pool.query(
      "SELECT tenant_id FROM cache_entries WHERE tenant_id IN ($1, $2)",
      [TENANT_A_ID, TENANT_B_ID],
    );
    expect(rowCount).toBe(2);
  });

  it("streaming requests bypass the cache entirely (no read, no write)", async () => {
    // Prime a non-streaming entry first so we can prove the streaming
    // request neither reads from nor pollutes the cache.
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: cacheableBody(),
    });
    const cacheRowsBefore = await handle.pool.query(
      "SELECT count(*)::int AS n FROM cache_entries WHERE tenant_id = $1",
      [TENANT_A_ID],
    );

    // Streaming returns 200 SSE (Phase 8). The point of this test is
    // that no cache_entries row materializes for the streaming
    // request — neither read nor write — regardless of outcome.
    const stream = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: cacheableBody({ stream: true }),
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");

    const cacheRowsAfter = await handle.pool.query(
      "SELECT count(*)::int AS n FROM cache_entries WHERE tenant_id = $1",
      [TENANT_A_ID],
    );
    expect(cacheRowsAfter.rows[0].n).toBe(cacheRowsBefore.rows[0].n);
  });

  it("temperature > 0 bypasses the cache (no read, no write)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: cacheableBody({ temperature: 0.7 }),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().cached).toBe(false);

    const cacheRows = await handle.pool.query(
      "SELECT count(*)::int AS n FROM cache_entries WHERE tenant_id = $1",
      [TENANT_A_ID],
    );
    expect(cacheRows.rows[0].n).toBe(0);

    // Second identical request must also miss (cache layer never sees it).
    const second = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: cacheableBody({ temperature: 0.7 }),
    });
    expect(second.json().cached).toBe(false);
  });

  it("expired cache entries cause a miss (TTL is honoured)", async () => {
    // Prime the cache.
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: cacheableBody(),
    });
    expect(first.json().cached).toBe(false);

    // Immediate replay: hit (sanity-check the entry was actually written).
    const hit = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: cacheableBody(),
    });
    expect(hit.json().cached).toBe(true);

    // Force the row to be expired in Postgres-time. Deterministic, no
    // sleeping. The repository's read filter (expires_at > now()) must
    // now return nothing, and the handler must call the provider again.
    await handle.pool.query(
      "UPDATE cache_entries SET expires_at = now() - interval '1 second' WHERE tenant_id = $1",
      [TENANT_A_ID],
    );

    const afterExpiry = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: tenantAHeaders,
      payload: cacheableBody(),
    });
    expect(afterExpiry.statusCode).toBe(200);
    expect(afterExpiry.json().cached).toBe(false);
    // ...and the provider call billed the tenant (proves we re-ran).
    expect(afterExpiry.json().cost_usd).toBeGreaterThan(0);
  });
});
