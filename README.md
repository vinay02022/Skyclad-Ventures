# Skyclad LLM Gateway

Multi-tenant LLM gateway built for the Skyclad Ventures Senior Backend Engineer
assignment. This README evolves alongside the code; the full DESIGN.md follows
the same trajectory.

## Stack

- TypeScript on Node.js 20+
- Fastify 5
- PostgreSQL 16 + Drizzle ORM
- Pino structured logs
- `prom-client` Prometheus metrics
- Vitest for tests
- Docker Compose for local Postgres

## Quick start

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run db:migrate     # create tenants, api_keys, usage_ledger, etc.
npm run db:seed        # insert tenant_a / tenant_b and provider price table
npm run dev
```

The server boots on `http://localhost:8080`.

```bash
curl http://localhost:8080/health
curl http://localhost:8080/metrics

# Authenticated identity check (tenant_a)
curl -H "Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD" \
  http://localhost:8080/v1/me

# tenant_b has a smaller budget and only OpenAI in its allowlist
curl -H "Authorization: Bearer sk_test_tenantb_demo_key_DO_NOT_USE_IN_PROD" \
  http://localhost:8080/v1/me

# Chat completion (non-streaming). Phase 4: cost-optimized router picks the
# cheapest provider in tenant_a's allowlist that serves the cheap class.
# Returns body.routing = { policy, candidate_count, fallback_used, reason }.
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD" \
  -H "Content-Type: application/json" \
  -d '{
    "model_class": "cheap",
    "messages": [{"role":"user","content":"hello there"}]
  }'

# Failover demo: fail the cheapest pick (openai) only, watch the router fall
# through to anthropic. body.routing.fallback_used will be true.
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD" \
  -H "Content-Type: application/json" \
  -H "x-skyclad-fail: 5xx" \
  -H "x-skyclad-fail-provider: openai" \
  -d '{ "model_class": "cheap", "messages": [{"role":"user","content":"hi"}] }'

# Force EVERY upstream to fail. Endpoint returns 502 all_providers_failed
# with the per-provider error trail and attempt count.
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD" \
  -H "Content-Type: application/json" \
  -H "x-skyclad-fail: 5xx" \
  -d '{ "model_class": "cheap", "messages": [{"role":"user","content":"hi"}] }'

# Override the router (debug only): pin a provider/model. No failover applies.
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD" \
  -H "Content-Type: application/json" \
  -d '{
    "model_class": "premium",
    "provider": "anthropic",
    "messages": [{"role":"user","content":"explain SSL termination"}]
  }'

# Phase 5: trip the per-tenant rate limit. tenant_b is seeded at 10/min,
# so the 11th call in the same minute returns 429 TENANT_RATE_LIMITED.
for i in $(seq 1 11); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://localhost:8080/v1/chat/completions \
    -H "Authorization: Bearer sk_test_tenantb_demo_key_DO_NOT_USE_IN_PROD" \
    -H "Content-Type: application/json" \
    -d '{"model_class":"cheap","messages":[{"role":"user","content":"hi"}]}'
done

# Phase 5: trip the per-tenant budget. Inserting a synthetic ledger row that
# exceeds tenant_b's $2 cap, then any next request returns 402 with the
# spent_usd / budget_usd numbers.
docker exec -it skyclad-postgres psql -U gateway -d gateway -c \
  "INSERT INTO usage_ledger (tenant_id, provider, model, request_id, input_tokens, output_tokens, cost_usd) \
   VALUES ('00000000-0000-0000-0000-00000000000b','openai','gpt-4o-mini','req-demo-overspend',1,1,2.5);"
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk_test_tenantb_demo_key_DO_NOT_USE_IN_PROD" \
  -H "Content-Type: application/json" \
  -d '{"model_class":"cheap","messages":[{"role":"user","content":"hi"}]}'

# Phase 7: cache demo. Fire the same deterministic request twice and watch
# the second response return cached:true, cost_usd:0, routing.policy:"cache".
# Cached responses do not write to usage_ledger.
curl -s -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD" \
  -H "Content-Type: application/json" \
  -d '{"model_class":"cheap","messages":[{"role":"user","content":"what is 2 + 2"}]}' | jq '{cached, cost_usd, routing}'
curl -s -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD" \
  -H "Content-Type: application/json" \
  -d '{"model_class":"cheap","messages":[{"role":"user","content":"what is 2 + 2"}]}' | jq '{cached, cost_usd, routing}'

# Inspect the cache
docker exec -it skyclad-postgres psql -U gateway -d gateway -c \
  "SELECT tenant_id, substring(cache_key for 16) AS cache_key_prefix, expires_at FROM cache_entries;"

# temperature > 0 opts out — replay never hits cache
curl -s -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD" \
  -H "Content-Type: application/json" \
  -d '{"model_class":"cheap","temperature":0.7,"messages":[{"role":"user","content":"hi"}]}' | jq '.cached'
```

### Failure injection knobs (mock providers only)

| Header | Value | Effect |
|---|---|---|
| `x-skyclad-fail` | `5xx` | Adapter throws ProviderError(500, retryable). Resilient wrapper retries up to 3 times before bubbling. |
| `x-skyclad-fail` | `rate-limit` | Adapter throws ProviderError(429, retryable). Same retry path. |
| `x-skyclad-fail` | `timeout` | Adapter sleeps 60s. Resilient wrapper races against the configured `timeoutMs` (default 20s) and synthesizes ProviderError(504, retryable). |
| `x-skyclad-fail` | `pre-stream-drop` | `stream()` throws before any chunk. Safe to failover. |
| `x-skyclad-fail` | `stream-drop` | `stream()` emits N chunks, then throws. Not retryable. |
| `x-skyclad-fail-after` | integer | For `stream-drop`: number of chunks before the failure. |
| `x-skyclad-fail-delay` | integer (ms) | Optional artificial latency before the (failing) call. |
| `x-skyclad-fail-provider` | provider name | Limit the failure to a single provider — essential for proving failover (`x-skyclad-fail-provider: openai`). |

## Tests

```bash
npm test
```

The test suite uses a separate database (`gateway_test`) which the setup
auto-creates on first run. Tests that need Postgres skip gracefully with a
clear console message if the DB is unreachable, so `npm test` never produces
spurious failures on a fresh clone.

| Suite | Covers |
|---|---|
| `tests/health.test.ts` | `/health` returns ok, request id propagation, `/metrics` returns Prometheus exposition format. |
| `tests/auth.test.ts` | Missing / unknown / valid bearer tokens, two seeded tenants, `/health` and `/metrics` are public. |
| `tests/tenants.test.ts` | `TenantRepository` lookup by hashed API key, budget config read, allowlist read, tenant-A vs tenant-B isolation. |
| `tests/providers.test.ts` | Mock provider adapters: name, model resolution, `complete`, `stream`, all five failure modes, token estimation, health. |
| `tests/chat.test.ts` | `POST /v1/chat/completions` end-to-end: auth, validation, normalized response shape, override path (pin provider), router-driven path, **failover** when first provider fails, 502 all-providers-failed, allowlist-induced 503 for tenant_b, 501 for stream:true. |
| `tests/routing.test.ts` | `CostOptimizedRoutingPolicy` unit tests with in-memory fakes: cheapest-wins, allowlist filter, missing-adapter filter, unhealthy-provider filter, returns null when nothing eligible, and the disabled-row contract (filtered in SQL). |
| `tests/budget.test.ts` | `UsageLedgerRepository` round-trip + tenant isolation; chat endpoint writes a `usage_ledger` row on success; `402 TENANT_BUDGET_EXCEEDED` once the SUM crosses `monthly_budget_usd`; tenant_a still succeeds while tenant_b is over budget. |
| `tests/ratelimit.test.ts` | `TokenBucket` unit (drain, refill, retryAfterMs, reconfigure clamp), `InMemoryRateLimiter` per-tenant isolation + reconfigure + `reset()`, integration: tenant_b at 10/min returns `429 TENANT_RATE_LIMITED` on burst 11, `Retry-After` header set, tenant_a unaffected. |
| `tests/resilience.test.ts` | `ResilientAdapter` retries transient errors and succeeds on a later attempt; does NOT retry 4xx; exhausts retries and bubbles. `withTimeout` synthesizes a 504 retryable error. `CircuitBreaker` state machine: opens after threshold, transitions OPEN→HALF_OPEN after cooldown, lets exactly one probe through, closes on probe success or reopens on probe failure. `CircuitBreakerRegistry` as `ProviderHealthOracle` reports OPEN providers unhealthy and recovers after cooldown. End-to-end failover when one provider's circuit is OPEN. |
| `tests/cache.test.ts` | `buildCacheKey` is deterministic, includes `tenant_id`, includes `provider`/`model`, ignores extra message fields, and returns 64-char sha256 hex. `isCacheable` rejects streaming and `temperature > 0`. `CacheRepository` set/get round-trips, isolates tenants on the same key, upserts on conflict, returns null for expired rows. End-to-end: same request hits cache on second call (`cached:true`, `cost_usd:0`, `routing.policy:"cache"`); cache hit writes no `usage_ledger` row; tenant_b doesn't see tenant_a's cache; streaming bypasses cache; `temperature > 0` bypasses cache; expired row causes a real provider call. |

## What is implemented so far

**Phase 1 — skeleton**

- Fastify app builder + process entrypoint with graceful shutdown
- `GET /health`
- `GET /metrics` (Prometheus default Node metrics)
- Request id correlation
- Pino logger with redaction of auth headers
- Zod-validated environment loader
- Drizzle client factory and migration directory
- Docker Compose with Postgres 16 + healthcheck
- Vitest test setup using `app.inject(...)`

**Phase 2 — persistence + tenant auth**

- Drizzle schema for `tenants`, `api_keys`, `provider_configs`,
  `tenant_provider_allowlists`, `usage_ledger`, `request_logs`
- Initial migration generated and applied via `npm run db:migrate`
- Idempotent seed script with two tenants (different budgets and allowlists)
- API keys stored as SHA-256 hashes; auth lookup is one indexed equality
- Fastify `onRequest` auth hook protecting `/v1/*` (public paths still public)
- `TenantRepository` with `findByApiKey`, `getBudgetConfig`, `getAllowlist`
- `GET /v1/me` identity / smoke-test endpoint

**Phase 3 — unified chat API + provider adapter abstraction**

- `POST /v1/chat/completions` (non-streaming) with Zod-validated request body
- `ProviderAdapter` interface: `complete`, `stream`, `estimateTokens`, `health`
- Two mock provider adapters registered as `openai` and `anthropic`
- `MockProviderBase` with failure injection: `5xx`, `rate-limit`, `timeout`,
  `stream-drop` (after N chunks), `pre-stream-drop`
- Failure injection via headers: `x-skyclad-fail`, `x-skyclad-fail-after`,
  `x-skyclad-fail-delay`
- `ProviderRegistry` + `buildProviderRegistry({ mode })` factory
- `PricingRepository` reads `provider_configs` and computes `cost_usd` for
  every response; in-process cache for the static price table
- Normalized `UnifiedChatResponse` — no provider-specific fields leak

**Phase 4 — cost-based routing + failover**

- `RoutingPolicy` interface and `CostOptimizedRoutingPolicy` implementation
- Filters: enabled (in SQL) → tenant allowlist → registered adapter → healthy
- Ranks survivors ascending by estimated cost
  `(input_price * estimated_in + output_price * max_tokens) / 1000`
- Returns `RoutingDecision` with `selected` + ordered `fallback_candidates`
- Chat handler walks the candidates: retryable failure → next, non-retryable
  → 502, all-failed → 502 `all_providers_failed` with the per-provider trail
- `ProviderHealthOracle` interface in place; default `AlwaysHealthyOracle`
  is the seam a future circuit breaker plugs into
- Per-provider failure injection via `x-skyclad-fail-provider: openai`,
  enabling clean failover demos
- Structured `routing decision` log line + `routing` summary on the response
- Override path (`body.provider`) preserved as a debug-only knob, with
  allowlist enforcement and no failover

**Phase 5 — budget enforcement + per-tenant rate limiting**

- `UsageLedgerRepository` (`getCurrentMonthSpend` + `recordUsage`) — Postgres
  is the durable source of truth for tenant spend
- Budget gate before every provider call: `SUM(cost_usd)` over the current
  calendar month vs `tenants.monthly_budget_usd` → `402
  TENANT_BUDGET_EXCEEDED` with `spent_usd` / `budget_usd` in the response
- Append-only ledger write after every successful provider response —
  ledger failures log loud, never break the response (deliberate trade,
  documented in DESIGN.md)
- Documented race window: post-call accounting can let concurrent requests
  for the same tenant slightly overspend the cap. Production fix
  (atomic pre-call reservation) called out in DESIGN.md
- `TokenBucket` (per-tenant, in-memory, time-injectable) +
  `InMemoryRateLimiter` (`RateLimiter` interface with a `RedisRateLimiter`
  drop-in shape)
- Bucket capacity is read from `tenants.rate_limit_per_minute` on every
  call — Postgres remains the source of truth for the *config*; the
  in-memory map is only the short-lived counter
- `429 TENANT_RATE_LIMITED` with `Retry-After` (seconds), `X-RateLimit-Limit`,
  `X-RateLimit-Remaining` headers
- Single-node-only by design; the pluggable `RateLimiter` interface is the
  seam a Redis-backed limiter slots into in production

**Phase 6 — resilience: timeout, retry, circuit breaker**

- `ResilientAdapter` wraps every `ProviderAdapter` in the registry without
  changing the chat handler or routing module
- Per-call timeout (default 20s) via `Promise.race` against `setTimeout`;
  expiry synthesizes `ProviderError(504, retryable=true)` so the rest of
  the resilience stack treats a slow upstream like an upstream 5xx
- Bounded retries on retryable errors only (200ms then 500ms backoff +
  30% jitter, 3 attempts total). `4xx` validation/auth errors are NEVER
  retried; the underlying `ProviderError.retryable` flag is the
  classifier
- Per-provider `CircuitBreaker` (CLOSED → OPEN → HALF_OPEN). Opens after
  5 failures in 60s, stays OPEN 30s, then HALF_OPEN admits exactly one
  probe — success closes, failure reopens with the cooldown clock reset
- `CircuitBreakerRegistry` doubles as the `ProviderHealthOracle` Phase 4
  introduced — when a breaker is OPEN, the router skips the provider
  with zero further wiring
- Streaming has no retries by design (per the assignment: never after
  bytes have been sent); the breaker still protects stream calls
- Structured logs: `transient provider error, retrying` per attempt,
  `circuit breaker state change` on every transition, `provider call
  succeeded after retry` when retries actually saved a request

**Phase 7 — deterministic-response cache**

- New `cache_entries` table (uuid PK, tenant FK, jsonb body, expires_at)
  with a composite UNIQUE on `(tenant_id, cache_key)` — cross-tenant
  isolation enforced at the storage layer, not just at the key level
- SHA-256 cache key over `(tenant_id, model_class, provider, model,
  normalized messages, temperature, max_tokens)` — `tenant_id` is in
  the hash AND in the WHERE clause; provider/model are in the hash so
  a router fallback to a different upstream isn't served stale
- Eligibility predicate `isCacheable(body)`: non-streaming AND
  `temperature == 0` only. Anything else bypasses the cache for both
  read and write
- Cache lookup runs AFTER the routing decision. On hit: response
  shape rebuilt with fresh `id` / `created_at` / `cached:true` /
  `cost_usd:0` / `routing.policy:"cache"`, no provider call, no
  `usage_ledger` write. On miss: failover loop runs, success is cached
  keyed by the provider that actually answered (which may differ from
  the originally selected one if a fallback ran)
- Default 5-minute TTL via `DEFAULT_CACHE_CONFIG`; configurable through
  `cacheConfig: { enabled, ttlMs }` on `buildApp`
- `CacheRepository` get filters `expires_at > now()`, set is an upsert
  on the composite unique index. No background sweeper for assignment
  scope (stale rows are inert; production would add a periodic DELETE)
- Cache write failures are non-fatal — they log loud but never break
  the response; caching is an optimization, not part of the request's
  correctness contract

## What is intentionally NOT yet implemented

SSE streaming end-to-end, `request_logs` writes,
per-tenant/provider/model metrics, `GET /v1/usage` summary. Each lands
in its own phase.

## Repo layout

```
src/
  app.ts                     Fastify app builder (request id, /health, error handler, /v1 mount)
  server.ts                  Process entry, graceful shutdown
  config.ts                  Zod env validation
  logger.ts                  Pino setup
  modules/
    auth/
      hash.ts                SHA-256 hash + key generator
      hook.ts                Fastify onRequest auth hook (Bearer -> tenant)
    tenants/
      types.ts               AuthenticatedTenant interface
      repository.ts          findByApiKey, getBudgetConfig, getAllowlist
      routes.ts              GET /v1/me
    chat/
      validation.ts          Zod schema for POST /v1/chat/completions body
      routes.ts              POST /v1/chat/completions handler
    providers/
      types.ts               ChatMessage, UnifiedChat*, Provider*, FailureInjection
      errors.ts              ProviderError class
      tokens.ts              Token estimator (chars / 4 heuristic)
      failure-injection.ts   Header parser for x-skyclad-fail*
      mock-base.ts           Shared mock behaviour (failures, streaming)
      mock-openai.ts         MockOpenAIProvider (registered as "openai")
      mock-anthropic.ts      MockAnthropicProvider (registered as "anthropic")
      registry.ts            ProviderRegistry (in-memory map by name)
      factory.ts             buildProviderRegistry({ mode })
      pricing.ts             PricingRepository + calculateCost (+ listEnabledByModelClass)
    routing/
      types.ts               RoutingPolicy, RouteCandidate, RoutingDecision, ProviderHealthOracle
      health.ts              AlwaysHealthyOracle (circuit breaker plugs in here)
      cost-optimized.ts      CostOptimizedRoutingPolicy
    budget/
      repository.ts          UsageLedgerRepository (getCurrentMonthSpend + recordUsage)
    ratelimit/
      token-bucket.ts        Single-node TokenBucket (time-injectable for tests)
      rate-limiter.ts        RateLimiter interface + InMemoryRateLimiter
    resilience/
      types.ts               BreakerState, RetryPolicy, ResilienceConfig
      defaults.ts            DEFAULT_RESILIENCE_CONFIG (20s timeout, 3 attempts, 5/60s breaker)
      circuit-breaker.ts     CircuitBreaker + CircuitBreakerRegistry (= ProviderHealthOracle)
      resilient-adapter.ts   ResilientAdapter wrapper + withTimeout helper
      factory.ts             buildResilientRegistry (wraps every adapter in the registry)
    cache/
      types.ts               CacheConfig, CacheKeyInput, CachedResponsePayload
      defaults.ts            DEFAULT_CACHE_CONFIG (5-min TTL)
      key.ts                 buildCacheKey (sha256 over tenant + routing + messages)
      policy.ts              isCacheable (non-streaming + temperature == 0)
      repository.ts          CacheRepository (Postgres-backed get/set)
    streaming/               (placeholder)
    observability/
      metrics.ts             prom-client registry
      routes.ts              GET /metrics
    persistence/             (placeholder)
db/
  schema.ts                  Drizzle table definitions (7 tables)
  client.ts                  createDbHandle factory
  migrate.ts                 Programmatic migration runner
  seed.ts                    Idempotent seedDatabase + script entry
  seed-fixtures.ts           Shared seed/test constants (tenants, keys, prices)
  migrations/                drizzle-kit-generated SQL
tests/
  setup/db.ts                Test DB bootstrap (auto-create, migrate, seed) + truncate helpers
  health.test.ts
  auth.test.ts
  tenants.test.ts
  providers.test.ts
  chat.test.ts
  routing.test.ts
  budget.test.ts
  ratelimit.test.ts
  resilience.test.ts
  cache.test.ts
```

## Useful one-liners

```bash
# Reset the dev DB
docker compose down -v && docker compose up -d postgres
npm run db:migrate && npm run db:seed

# See what's in the tenants table
docker exec -it skyclad-postgres psql -U gateway -d gateway -c "SELECT id, name, monthly_budget_usd, rate_limit_per_minute FROM tenants;"

# See what's in the price table
docker exec -it skyclad-postgres psql -U gateway -d gateway -c "SELECT provider, model, model_class, input_cost_per_1k_tokens, output_cost_per_1k_tokens FROM provider_configs ORDER BY model_class, provider;"
```
