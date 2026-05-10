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

# Chat completion (non-streaming). Default provider in Phase 3 is openai (mock).
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD" \
  -H "Content-Type: application/json" \
  -d '{
    "model_class": "cheap",
    "messages": [{"role":"user","content":"hello there"}]
  }'

# Force the upstream to fail with a 5xx for failure-injection testing
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD" \
  -H "Content-Type: application/json" \
  -H "x-skyclad-fail: 5xx" \
  -d '{ "model_class": "cheap", "messages": [{"role":"user","content":"hi"}] }'

# Pin the anthropic mock and ask for a premium model
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD" \
  -H "Content-Type: application/json" \
  -d '{
    "model_class": "premium",
    "provider": "anthropic",
    "messages": [{"role":"user","content":"explain SSL termination"}]
  }'
```

### Failure injection knobs (mock providers only)

| Header | Value | Effect |
|---|---|---|
| `x-skyclad-fail` | `5xx` | Adapter throws ProviderError(500, retryable). Endpoint returns 502. |
| `x-skyclad-fail` | `rate-limit` | Adapter throws ProviderError(429, retryable). Endpoint returns 502. |
| `x-skyclad-fail` | `timeout` | Adapter sleeps 60s. Phase 5 will race this against a timeout. |
| `x-skyclad-fail` | `pre-stream-drop` | `stream()` throws before any chunk. Safe to failover. |
| `x-skyclad-fail` | `stream-drop` | `stream()` emits N chunks, then throws. Not retryable. |
| `x-skyclad-fail-after` | integer | For `stream-drop`: number of chunks before the failure. |
| `x-skyclad-fail-delay` | integer (ms) | Optional artificial latency before the (failing) call. |

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
| `tests/chat.test.ts` | `POST /v1/chat/completions` end-to-end: auth, validation (missing fields, empty messages), normalized response shape, no provider-specific field leakage, provider override, model_class resolution, forced 5xx via header, 501 for stream:true, both seeded tenants. |

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

## What is intentionally NOT yet implemented

Routing (cost-based selection across allowlist), retries, circuit breaker,
cache, SSE streaming end-to-end, request logging, usage ledger writes, budget
enforcement, rate limiting. Each lands in its own phase.

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
      pricing.ts             PricingRepository + calculateCost
    routing/                 (placeholder)
    resilience/              (placeholder)
    cache/                   (placeholder)
    streaming/               (placeholder)
    observability/
      metrics.ts             prom-client registry
      routes.ts              GET /metrics
    persistence/             (placeholder)
db/
  schema.ts                  Drizzle table definitions (6 tables)
  client.ts                  createDbHandle factory
  migrate.ts                 Programmatic migration runner
  seed.ts                    Idempotent seedDatabase + script entry
  seed-fixtures.ts           Shared seed/test constants (tenants, keys, prices)
  migrations/                drizzle-kit-generated SQL
tests/
  setup/db.ts                Test DB bootstrap (auto-create, migrate, seed)
  health.test.ts
  auth.test.ts
  tenants.test.ts
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
