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
```

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
- Test infrastructure: separate `gateway_test` DB, auto-create on first run,
  truncate-and-reseed before each suite

## What is intentionally NOT yet implemented

Providers (OpenAI / Anthropic / mock), routing, retries, circuit breaker,
cache, SSE streaming, request logging, usage ledger writes, budget
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
    providers/               (placeholder)
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
