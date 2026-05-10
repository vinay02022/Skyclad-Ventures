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

> **Provider mode.** `MOCK_PROVIDERS=true` (the default) uses
> deterministic in-process mock adapters for both `openai` and
> `anthropic` so this Quick Start, every test, and every demo runs
> with **zero external calls and zero spend**. Real adapters land in
> the next section.

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

# Phase 8: SSE streaming. Returns text/event-stream; client sees one
# `data: {"type":"token","content":"..."}` line per chunk, finishing with
# `data: {"type":"done"}`. Use `curl -N` to disable buffering.
curl -N -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD" \
  -H "Content-Type: application/json" \
  -d '{"model_class":"cheap","stream":true,"messages":[{"role":"user","content":"tell me a joke"}]}'

# Streaming failover: openai pre-stream-drops, anthropic answers. The client
# sees only anthropic's tokens followed by `done` -- no error event.
curl -N -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD" \
  -H "Content-Type: application/json" \
  -H "x-skyclad-fail: pre-stream-drop" \
  -H "x-skyclad-fail-provider: openai" \
  -d '{"model_class":"cheap","stream":true,"messages":[{"role":"user","content":"hi"}]}'

# Partial-stream failure: openai sends 2 tokens then drops. Client sees those
# 2 tokens followed by ONE error event with `partial:true`. NEVER fails over
# (the client is already committed to the partial response).
curl -N -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD" \
  -H "Content-Type: application/json" \
  -H "x-skyclad-fail: stream-drop" \
  -H "x-skyclad-fail-after: 2" \
  -H "x-skyclad-fail-provider: openai" \
  -d '{"model_class":"cheap","stream":true,"messages":[{"role":"user","content":"hi"}]}'

# Inspect what got logged for the partial failure
docker exec -it skyclad-postgres psql -U gateway -d gateway -c \
  "SELECT request_id, status, streaming, provider, output_tokens, error_type FROM request_logs ORDER BY created_at DESC LIMIT 5;"

# Phase 9: Prometheus metrics. The seven gateway_* series appear in the
# output once they have been incremented at least once by a request.
curl -s http://localhost:8080/metrics | grep '^gateway_' | head -20

# Phase 9: per-tenant usage summary. Only mounted when ADMIN_TOKEN is set
# in the environment (see .env.example). Unset = 404 to anyone.
export ADMIN_TOKEN="local-dev-admin-token"   # restart the server after setting
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:8080/admin/tenants/00000000-0000-0000-0000-00000000000a/usage?from=2026-05-01&to=2026-05-31" | jq .
```

### Running with real OpenAI / Anthropic providers (Phase 10)

Mock mode (the default) is the right choice for everything except a
demo against a live model. To switch on the real adapters:

```bash
# 1. Provide one or both API keys.
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...

# 2. Flip the mode flag.
export MOCK_PROVIDERS=false

# 3. Restart the server.
npm run dev
```

Behaviour:

- `MOCK_PROVIDERS=false` + both keys set → both upstreams are real.
- `MOCK_PROVIDERS=false` + one key missing → that one provider falls
  back to mock with a logged warning; the other is real. Lets you
  test the OpenAI path without an Anthropic key (or vice versa).
- `MOCK_PROVIDERS=false` + both keys missing → both fall back to mock
  with two warnings. The server still boots; you'll see warnings in
  the logs telling you the mode was a no-op.
- `MOCK_PROVIDERS=true` (or unset) → always mock, regardless of keys.
  This is the safe default and the value the test suite uses.

Both real adapters implement the **same `ProviderAdapter` interface**
as the mocks. Routing, failover, the resilience wrapper, the cache,
the streaming handler, `request_logs`, the Prometheus metrics, and
the admin usage endpoint all work identically in either mode — the
only thing that changes is whose servers handle the actual generation.

### Avoiding provider spend during evaluation

The default flow already avoids spend:

- `npm test` always runs with mocks. The 156-test suite never makes a
  network call to a real provider; the real-adapter tests inject a
  fake `fetch` so request shape, error mapping, and SSE parsing are
  all verified against constructed `Response` objects.
- `npm run dev` with `.env.example` copied verbatim runs in mock mode
  even if you've exported real `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
  in your shell — `MOCK_PROVIDERS=true` overrides them.
- The seeded provider price table is the source of truth for cost
  calculations regardless of mode, so dashboards and billing math
  give the same answer in mock mode and real mode.

If you want to demo against real upstreams without leaving the gateway
running on real keys: `unset MOCK_PROVIDERS` (or set it back to
`true`) when you're done; the server picks the new value up on
restart.

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
| `tests/streaming.test.ts` | `formatSSEEvent` emits the right wire format for token/done/error. End-to-end SSE: `text/event-stream` headers; multiple `token` events followed by exactly one `done`; ledger and `request_logs` rows written on success (`streaming=true`, `status=success`, `cache_hit=false`); cache fully bypassed for streaming. Failover before first byte succeeds silently (anthropic answers when openai pre-drops). After-N-tokens drop emits exactly one `error` event with `partial:true` and NO `done` after it; partial response is logged with `status=partial_failed` and tenant is billed for what was actually sent. All-providers-pre-drop emits one `error` with `partial:false` and logs `status=all_providers_failed`. Tenant isolation under concurrent streams. |
| `tests/observability.test.ts` | Successful non-streaming request writes a complete `request_logs` row (`tenant_id`, `provider`, `model`, `status=success`, `latency_ms`, `input_tokens`, `output_tokens`, `cost_usd`, `cache_hit=false`, `streaming=false`). Forced provider failure writes a row with `status=all_providers_failed` and `error_type` populated, AND increments `gateway_errors_total`. The seven gateway-level Prometheus series are present in the registry serialization, with `tenant_id` / `provider` / `model` / `status` labels populated and tokens partitioned by `token_type`. |
| `tests/admin-usage.test.ts` | `GET /admin/tenants/:tenantId/usage` rejects no-token (401) and wrong-token (401), validates date params (400 on malformed or `from > to`), returns zero totals (not 404) for empty ranges, aggregates `usage_ledger` rows correctly into `total_*` / `by_provider` / `by_model`, and is fully tenant-isolated (tenant_b's response never carries tenant_a's numbers). |
| `tests/providers-real.test.ts` | Pure-function coverage for the SSE parser (chunk-boundary mid-line, `\r\n` endings, comment lines, multi-line `data:`, EOF flush) and `mapHttpStatusToProviderError` (400/401/422 → not retryable, 429 → retryable, 5xx → retryable, transport AbortError → 504, other transport → 503). `OpenAIProvider`: rejects empty key; `resolveDefaultModel` matches the seeded rows; `complete()` sends the right URL/headers/body and parses the response; missing `usage` falls back to the chars/4 estimator; all four error classes map correctly; `stream()` opts in via `stream_options.include_usage` and yields delta + done with upstream-reported usage; pre-stream 5xx maps to retryable. Same coverage for `AnthropicProvider` plus `hoistSystemMessages` (system role extracted to top-level), multi-text-block concatenation, and the named-event SSE shape (`message_start`, `content_block_delta`, `message_delta`, `message_stop`). |
| `tests/factory.test.ts` | `mode: "mock"` wires both mocks; `mode: "live"` + both keys wires both real adapters; `mode: "live"` + one missing key falls back to mock for that provider only and emits exactly one warning; both keys missing emits two warnings; `fetchImpl` and `baseUrl` overrides reach the real adapter for network-free tests. |

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

**Phase 8 — SSE streaming + partial-failure handling**

- `POST /v1/chat/completions` with `stream: true` now returns
  `text/event-stream` instead of 501. Same gates (rate limit, budget)
  and same routing decision; only the response framing changes
- Wire format: one `data: {...}\n\n` line per event. Three event
  shapes: `{type:"token",content:"..."}`, `{type:"done"}`,
  `{type:"error",message:"...",partial:true|false}`
- **First-byte commitment** is the load-bearing rule. Before any
  `token` event reaches the client: a retryable upstream error is
  treated as a normal failover trigger; the chat handler walks the
  candidate list and the client never observes the failure. After
  the first `token`: NEVER retry, NEVER fall over. Emit one `error`
  event with `partial:true`, end the stream cleanly, log the partial
  outcome
- Cache is bypassed for streams (the `isCacheable` predicate from
  Phase 7 already returns false; the streaming branch sits before the
  cache check anyway, so neither read nor write happens)
- New `RequestLogRepository.insert` writes one `request_logs` row per
  streaming outcome with `streaming=true` and one of: `success`,
  `partial_failed` (tokens reached the client then upstream dropped),
  `upstream_failed` (non-retryable error before first byte),
  `all_providers_failed` (every candidate dropped pre-byte)
- Usage is billed honestly: clean stream → upstream-reported usage;
  partial stream → tokens accumulated from streamed deltas
  (output tokens approximated via the `chars / 4` heuristic). Both
  paths write to `usage_ledger`. `upstream_failed` and
  `all_providers_failed` skip the ledger (no work done) but still
  write `request_logs`

**Phase 9 — observability (logs, metrics, admin usage)**

- Single `recordRequestOutcome` helper in `observability/outcome.ts` is
  the one call site that, for every terminal in both the streaming and
  non-streaming paths, (a) writes a `request_logs` row, (b) updates the
  seven Prometheus series, (c) emits the structured Pino log line. Logs
  and metrics can no longer drift apart.
- `request_logs` is now written for every outcome — `success`,
  `partial_failed`, `upstream_failed`, `all_providers_failed`,
  `rate_limited`, `budget_exceeded`, `invalid_request`,
  `no_provider_available` — with the assignment-listed fields
  (`request_id`, `tenant_id`, `provider`, `model`, `status`,
  `error_type`, `latency_ms`, `cache_hit`, `streaming`,
  `input_tokens`, `output_tokens`, `cost_usd`) populated.
- `GET /metrics` exposes the seven gateway-level series in addition
  to Node default metrics:
  - `gateway_requests_total{tenant_id, provider, model, status}`
  - `gateway_errors_total{tenant_id, provider, error_type}`
  - `gateway_latency_ms{provider, model}` (histogram)
  - `gateway_tokens_total{tenant_id, provider, model, token_type}`
  - `gateway_cost_usd_total{tenant_id, provider, model}`
  - `gateway_cache_hits_total{tenant_id}`
  - `gateway_provider_circuit_state{provider, state}` (gauge with
    `collect()` callback that snapshots the breaker registry at scrape
    time — no background poller, no stale state)
- `GET /admin/tenants/:tenantId/usage?from=YYYY-MM-DD&to=YYYY-MM-DD`
  returns `{ tenant_id, total_cost_usd, total_input_tokens,
  total_output_tokens, by_provider, by_model }` aggregated from
  `usage_ledger` over a half-open date range. Bearer-protected by a
  single `ADMIN_TOKEN` env var.
- `ADMIN_TOKEN` empty / unset → `/admin/*` is not mounted at all
  (404 to anyone). Misconfigured deploy fails closed.

**Phase 10 — real OpenAI + Anthropic adapters**

- `OpenAIProvider` (`POST /v1/chat/completions` with Bearer token,
  optional `stream_options.include_usage` for streamed usage) and
  `AnthropicProvider` (`POST /v1/messages` with `x-api-key`,
  `anthropic-version: 2023-06-01`, system-message hoisting) both
  implementing the same `ProviderAdapter` interface as the mocks.
  Routing, failover, the resilience wrapper, the cache, the streaming
  handler, `request_logs`, and `/metrics` work identically against
  either kind of adapter.
- Shared `parseSseStream` helper for both upstreams. Hand-rolled
  (~70 lines) instead of pulling a dependency, with explicit handling
  for chunk-boundary mid-line, `\r\n` endings, comment lines, and
  EOF without a trailing blank line.
- Single `mapHttpStatusToProviderError` + `mapTransportErrorToProviderError`
  classification used by both real adapters: 4xx → not retryable
  (no failover, no retry), 429 → retryable (gets retries plus
  failover, the spec's "may fallback"), 5xx + transport (DNS, ECONN,
  AbortError) → retryable. Mocks already throw the same `ProviderError`
  shape, so the rest of the gateway sees one uniform error contract.
- Token usage prefers upstream-reported figures (OpenAI's
  `prompt_tokens`/`completion_tokens`, Anthropic's `usage` block in
  `message_start` / `message_delta`) and falls back to the existing
  chars/4 estimator only when the upstream omits them.
- Mode selection via `MOCK_PROVIDERS` env var (default `true`). When
  `false`, each provider goes real if its API key is set, otherwise
  falls back to mock per-provider with a logged warning. Tests
  default to mock mode unconditionally; the test suite never makes
  a real network call.

## What is intentionally NOT yet implemented

Nothing scoped to the assignment is missing. Production gaps that are
deliberately out of scope (called out in `DESIGN.md`): multi-instance
circuit-breaker state via Redis pub/sub, atomic budget reservation
against the ledger, RBAC on the admin surface, dropping `tenant_id`
from Prometheus labels at fleet scale, and tokenizer-accurate token
counts (vs the chars/4 heuristic) for pre-call routing decisions.

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
      openai-real.ts         OpenAIProvider (real chat/completions adapter)
      anthropic-real.ts      AnthropicProvider (real messages API adapter)
      sse-parser.ts          Shared line-based SSE parser used by both real adapters
      http-errors.ts         mapHttpStatusToProviderError + mapTransportErrorToProviderError
      registry.ts            ProviderRegistry (in-memory map by name)
      factory.ts             buildProviderRegistry({ mode, keys, ... }) — mock vs live + per-provider fallback
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
    streaming/
      sse.ts                 formatSSEEvent (token / done / error wire format)
      handler.ts             streamChatCompletion (failover before 1st byte; partial after)
    observability/
      metrics.ts             prom-client default registry + Node defaults
      gateway-metrics.ts     7 gateway-level series + breaker-state gauge
      outcome.ts             recordRequestOutcome (request_logs + metrics + log line)
      routes.ts              GET /metrics
    admin/
      routes.ts              GET /admin/tenants/:id/usage (ADMIN_TOKEN-gated)
    persistence/
      request-logs-repo.ts   RequestLogRepository (writes for every terminal)
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
  streaming.test.ts
  observability.test.ts
  admin-usage.test.ts
  providers-real.test.ts
  factory.test.ts
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
