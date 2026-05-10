# Skyclad Ventures — Multi-tenant LLM gateway

A small, production-shaped backend that fronts OpenAI and Anthropic
behind one API. Each tenant has its own API key, monthly budget,
rate limit, and provider allowlist. Requests go through a
cost-optimized router with failover, retries with backoff, per-call
timeouts, and a per-provider circuit breaker. SSE streaming and a
deterministic Postgres-backed response cache are first-class.
Structured logs and Prometheus metrics expose every interesting
event. Mock providers ship in the box so you can run, test, and
demo every flow with **zero external calls and zero spend**.

The brief, the design tradeoffs, and the failure-mode reasoning live
in [`DESIGN.md`](./DESIGN.md). This README is the operator's manual.

---

## What is implemented

- **Unified chat endpoint** — `POST /v1/chat/completions` with a
  normalized request and response shape; `?stream=true` switches to
  SSE without changing the URL.
- **Two real providers** — `OpenAIProvider` (chat/completions API)
  and `AnthropicProvider` (messages API), both behind the same
  `ProviderAdapter` interface. Token usage prefers upstream-reported
  figures and falls back to a chars/4 estimator when absent.
- **Mock providers** — drop-in replacements wired by default
  (`MOCK_PROVIDERS=true`). Same interface, deterministic output,
  rich failure-injection knobs (header-based per-request and admin-
  endpoint persistent — see below).
- **Multi-tenant API keys** — Bearer-token auth backed by SHA-256
  hashed keys in `api_keys`; resolution is one indexed lookup.
- **Budget caps using a Postgres usage ledger** — every successful
  call appends to `usage_ledger`; the budget gate sums the current
  month's rows for that tenant and rejects with
  `402 TENANT_BUDGET_EXCEEDED` when the cap is exceeded.
- **Single-node in-memory token-bucket rate limiting** — per tenant,
  config read from Postgres, bucket state in-process.
  `429 TENANT_RATE_LIMITED` with `Retry-After`. Intentionally
  single-node (see Known limitations).
- **Provider allowlists** — per-tenant rows in
  `tenant_provider_allowlists` filter routing candidates. Tenant_b's
  openai-only allowlist exists in the seed data so you can prove
  failover stays on the allowed list.
- **Cost-optimized routing** — `CostOptimizedRoutingPolicy` picks
  the cheapest healthy enabled candidate for the requested
  `model_class` from the tenant's allowlist; `routing.fallback_used`
  in the response tells you whether failover happened.
- **Retry, timeout, and per-provider circuit breaker** —
  `ResilientAdapter` wraps every adapter with bounded retries
  (200ms / 500ms with jitter, 3 attempts), per-call timeout
  (`PROVIDER_TIMEOUT_MS`, default 20s, synthesizes a retryable 504),
  and a `CLOSED → OPEN → HALF_OPEN` breaker (5 failures in 60s →
  open for 30s → one probe). The breaker registry is also the
  router's health oracle; OPEN providers are skipped entirely.
- **SSE streaming** — `text/event-stream`, one
  `data: {"type":"token", ...}` per chunk, terminated by
  `data: {"type":"done"}`. Failover before any byte is sent is
  silent; failure after the first byte produces exactly one
  `partial: true` error event.
- **Partial streaming failure handling** — `request_logs` row gets
  `status = "partial_failed"`, the tenant is billed for tokens
  actually streamed (not the would-be full response), and the
  socket closes cleanly.
- **Postgres persistence using Drizzle ORM** — schemas, migrations,
  and seed live in `db/`. Every durable surface (`tenants`,
  `api_keys`, `provider_configs`, `tenant_provider_allowlists`,
  `usage_ledger`, `request_logs`, `cache_entries`) is one table
  inspectable via plain SQL.
- **Structured logs** — Pino JSON. Every request line carries
  `request_id`, `tenant_id`, `provider`, `model`, `model_class`,
  `route_policy`, `routing_reason`, `cache_hit`, `streaming`,
  `latency_ms`, `input_tokens`, `output_tokens`, `cost_usd`,
  `status`, and `error_type` when relevant.
- **Prometheus metrics** — `GET /metrics` exposes seven `gateway_*`
  series: requests, errors, latency histogram, tokens, cost,
  cache hits, and circuit-breaker state. Plus the prom-client
  default Node metrics.
- **Simple deterministic cache** — Postgres-backed
  `cache_entries`, SHA-256 key over
  `tenant_id + model_class + provider + model + normalized
  messages + temperature + max_tokens`. Configurable TTL
  (`CACHE_TTL_SECONDS`, default 300). Streaming and `temperature
  > 0` bypass; cache hits never write to `usage_ledger` and never
  bill the tenant.
- **Eval-only admin helpers** (Phase 11) — three small endpoints
  that make the assignment walkthrough one curl per scenario; see
  the Failure-injection and Budget-exhaustion sections.

---

## What is intentionally NOT implemented

- **Frontend / dashboard** — out of scope; observability is
  Prometheus + JSON logs + an admin usage endpoint.
- **Distributed rate limiting / Redis-backed shared counters** —
  rate limit state is in-process and resets on restart. The
  scaling cliff is honest and called out in DESIGN.md.
- **Pre-request budget reservation** — accounting is post-call,
  which under high concurrency can allow slight overspend within
  one wall-clock second per tenant. Production fix is two-phase:
  reserve estimated cost, reconcile with actual.
- **Semantic cache** — only deterministic cache. No embeddings,
  no nearest-neighbour lookup, no false-positive risk.
- **Queue-based async jobs** — every request is synchronous. No
  job runner, no retry queue, no inbox/outbox.
- **Full production auth or RBAC** — admin endpoints share one
  `ADMIN_TOKEN` Bearer secret; tenant API keys are hashed but not
  rotated. No per-operator users, no audit trail, no SSO.
- **Kubernetes deployment** — Docker Compose for local Postgres;
  the gateway itself runs as a plain Node process.
- **Tokenizer-accurate token counting** — `chars / 4` heuristic for
  pre-call estimates; upstream-reported usage is preferred when
  available.

DESIGN.md goes deeper on each of these.

---

## Quick start

```bash
git clone <repo-url> skyclad-ventures
cd skyclad-ventures
cp .env.example .env
docker compose up -d postgres        # postgres on :5432
npm install
npm run db:generate                  # idempotent; up-to-date if no schema changes
npm run db:migrate                   # creates tables
npm run db:seed                      # tenant_a / tenant_b + provider_configs
npm run dev                          # listens on :8080
```

Health check:

```bash
curl http://localhost:8080/health
```

Full clone-to-running on a warm machine: under 5 minutes. Cold
(needs Docker pulls): 10–15 minutes depending on bandwidth.

---

## Running tests

```bash
npm test                             # full suite, 171 tests across 16 files
npx vitest run tests/chat.test.ts    # single file
```

The suite uses a separate `gateway_test` database which the setup
auto-creates on first run. DB-dependent suites skip gracefully (with
a clear console message) if Postgres is unreachable, so `npm test`
never produces spurious failures on a fresh clone with the container
not yet started.

---

## Environment variables

Defaults are in `.env.example`. Only `DATABASE_URL` is strictly
required; everything else has a sensible default.

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `postgres://gateway:gateway@localhost:5432/gateway` | Primary Postgres connection. Matches the Compose file. |
| `MOCK_PROVIDERS` | `true` | When `true`, both providers are deterministic in-process mocks (zero spend). When `false`, each provider goes real if its API key is set; missing keys fall back to mock per-provider with a logged warning. |
| `OPENAI_API_KEY` | (empty) | Required only for live OpenAI calls. |
| `ANTHROPIC_API_KEY` | (empty) | Required only for live Anthropic calls. |
| `ADMIN_TOKEN` | (empty) | When set, mounts `/admin/*` (read-only usage endpoint + Phase 11 eval-only helpers) behind Bearer auth. When unset, the entire admin surface is unmounted (404 to anyone — fail closed). |
| `CACHE_TTL_SECONDS` | `300` | TTL for the deterministic response cache. Set lower for cache-expiry demos. |
| `PROVIDER_TIMEOUT_MS` | `20000` | Per-call upstream timeout. Below this the timeout wrapper synthesizes a retryable 504. |
| `PORT` | `8080` | HTTP port. |
| `LOG_LEVEL` | `info` | `fatal | error | warn | info | debug | trace | silent`. |

---

## API examples (curl)

Set these once for the rest of this README:

```bash
A="Authorization: Bearer sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD"
B="Authorization: Bearer sk_test_tenantb_demo_key_DO_NOT_USE_IN_PROD"
JSON="Content-Type: application/json"
URL=http://localhost:8080
```

### Non-streaming request (tenant_a)

tenant_a's allowlist is `[openai, anthropic]`; the cost-optimized
router picks `gpt-4o-mini` for the `cheap` class.

```bash
curl -s -X POST $URL/v1/chat/completions -H "$A" -H "$JSON" \
  -d '{"model_class":"cheap","messages":[{"role":"user","content":"hello"}]}' | jq .
```

Response (excerpt):

```json
{
  "request_id": "...",
  "provider": "openai",
  "model": "gpt-4o-mini",
  "message": { "role": "assistant", "content": "..." },
  "usage": { "input_tokens": 4, "output_tokens": 21 },
  "cost_usd": 0.000013,
  "cached": false,
  "routing": {
    "policy": "cost_optimized",
    "candidate_count": 2,
    "fallback_used": false,
    "reason": "cheapest healthy candidate"
  }
}
```

### Streaming request (tenant_a)

```bash
curl -N -X POST $URL/v1/chat/completions -H "$A" -H "$JSON" \
  -d '{"model_class":"cheap","stream":true,"messages":[{"role":"user","content":"tell me a joke"}]}'
```

Wire format:

```
data: {"type":"token","content":"[mock-openai]"}

data: {"type":"token","content":" tell me"}

...

data: {"type":"done"}
```

### Tenant B request (different tenant, different cap, different allowlist)

tenant_b allows only `openai` and is rate-limited at 10/min.

```bash
curl -s -X POST $URL/v1/chat/completions -H "$B" -H "$JSON" \
  -d '{"model_class":"cheap","messages":[{"role":"user","content":"hi"}]}' | jq '{provider, cost_usd}'
```

### Identity check (either tenant)

```bash
curl -s -H "$A" $URL/v1/me | jq .
```

### Override the router (debug; pin a provider/model)

No failover applies on this path.

```bash
curl -s -X POST $URL/v1/chat/completions -H "$A" -H "$JSON" \
  -d '{
    "model_class": "premium",
    "provider": "anthropic",
    "messages": [{"role":"user","content":"explain SSL termination"}]
  }' | jq '{provider, model, cost_usd}'
```

---

## Failure injection

Two ways to drive failures, both for **mock providers only**.

### Per-request, header-based (no admin token needed)

Useful for one-off curl tests. Headers are surgical: pin the
failure to one provider so the other still answers.

```bash
# Force openai to 5xx for THIS request only — anthropic answers,
# routing.fallback_used = true.
curl -s -X POST $URL/v1/chat/completions -H "$A" -H "$JSON" \
  -H "x-skyclad-fail: 5xx" -H "x-skyclad-fail-provider: openai" \
  -d '{"model_class":"cheap","messages":[{"role":"user","content":"hi"}]}' \
  | jq '{provider, routing}'
```

| Header | Values | Effect |
|---|---|---|
| `x-skyclad-fail` | `5xx`, `rate-limit`, `timeout`, `pre-stream-drop`, `stream-drop` | The failure mode. |
| `x-skyclad-fail-after` | integer | For `stream-drop`: chunks before the drop. |
| `x-skyclad-fail-delay` | integer (ms) | Optional artificial latency before the failing call. |
| `x-skyclad-fail-provider` | `openai` / `anthropic` | Limits the failure to one provider — essential for proving failover. |

### Persistent, admin-endpoint-based (requires `ADMIN_TOKEN`)

Useful for multi-step demos where you don't want to re-attach the
header to every request. State is process-local and clears on
restart by design.

```bash
# Set ADMIN_TOKEN in .env (any non-empty string) and restart the server.
ADMIN="Authorization: Bearer $ADMIN_TOKEN"

# Force OpenAI to return 5xx on every subsequent call.
curl -s -X POST $URL/admin/mock-providers/openai/failure-mode \
  -H "$ADMIN" -H "$JSON" -d '{"mode":"fail_5xx"}' | jq .

# Now any tenant_a request goes via anthropic with fallback_used:true.
curl -s -X POST $URL/v1/chat/completions -H "$A" -H "$JSON" \
  -d '{"model_class":"cheap","messages":[{"role":"user","content":"hi"}]}' \
  | jq '{provider, routing}'

# Force a timeout (mock sleeps 60s; the resilience wrapper races
# PROVIDER_TIMEOUT_MS and synthesizes a 504).
curl -s -X POST $URL/admin/mock-providers/openai/failure-mode \
  -H "$ADMIN" -H "$JSON" -d '{"mode":"timeout"}' | jq .

# Force a streaming drop after 2 chunks. The next streaming request
# emits two token events, then exactly one error event with
# partial:true, and writes request_logs.status='partial_failed'.
curl -s -X POST $URL/admin/mock-providers/openai/failure-mode \
  -H "$ADMIN" -H "$JSON" -d '{"mode":"stream_drop_after_chunks","chunks":2}' | jq .

# Reset openai back to normal.
curl -s -X POST $URL/admin/mock-providers/openai/failure-mode \
  -H "$ADMIN" -H "$JSON" -d '{"mode":"normal"}' | jq .
```

Per-request `x-skyclad-fail` headers always win over the persistent
mode set by these endpoints.

---

## Budget exhaustion demo

Tenant budgets are per-month, sourced from `usage_ledger`. The
gate runs on every request (it's one indexed `SUM(cost_usd)` over
the current month).

```bash
ADMIN="Authorization: Bearer $ADMIN_TOKEN"
TENANT_A=00000000-0000-0000-0000-00000000000a

# 1. Drop tenant_a's monthly cap to nearly zero.
curl -s -X POST $URL/admin/tenants/$TENANT_A/set-budget \
  -H "$ADMIN" -H "$JSON" -d '{"monthly_budget_usd":0.0001}' | jq .

# 2. Send one request as tenant_a. The auth hook re-reads the tenant
#    on every call, so the new cap applies immediately. Expect 402.
curl -s -w "\nHTTP %{http_code}\n" -X POST $URL/v1/chat/completions \
  -H "$A" -H "$JSON" \
  -d '{"model_class":"cheap","messages":[{"role":"user","content":"hi"}]}'

# 3. Tenant B is untouched — different tenant_id, different budget row.
#    Prove isolation: tenant_b still gets 200.
curl -s -w "\nHTTP %{http_code}\n" -X POST $URL/v1/chat/completions \
  -H "$B" -H "$JSON" \
  -d '{"model_class":"cheap","messages":[{"role":"user","content":"hi"}]}'

# 4. Cleanup: restore tenant_a's seeded $10 cap and clear its ledger.
curl -s -X POST $URL/admin/tenants/$TENANT_A/set-budget \
  -H "$ADMIN" -H "$JSON" -d '{"monthly_budget_usd":10}' > /dev/null
curl -s -X POST $URL/admin/tenants/$TENANT_A/reset-usage -H "$ADMIN" | jq .
```

Step 2 returns:

```json
{
  "error": "TENANT_BUDGET_EXCEEDED",
  "tenant_id": "00000000-0000-0000-0000-00000000000a",
  "spent_usd": 0.000013,
  "budget_usd": 0.0001,
  ...
}
```

---

## Rate-limit demo

Rate limiting is a **single-node in-memory token bucket** per
tenant. The bucket capacity comes from `tenants.rate_limit_per_minute`
in Postgres; the bucket state itself lives in-process and resets on
restart. Tenant_b is seeded at 10/min, so the 11th request inside one
minute returns `429 TENANT_RATE_LIMITED` with a `Retry-After` header.

```bash
# Burst 11 requests; expect ten 200s then one 429.
for ($i=1; $i -le 11; $i++) {
  curl -s -o /dev/null -w "%{http_code}`n" \
    -X POST $URL/v1/chat/completions -H "$B" -H "$JSON" \
    -d '{"model_class":"cheap","messages":[{"role":"user","content":"hi"}]}'
}
```

(POSIX shell: `for i in $(seq 1 11); do ... ; done` instead.)

This is intentionally single-node for assignment scope. The right
production swap is a Redis token bucket (`INCR` + `EXPIRE`, or a
Lua script that returns `tokens_left + retry_after_ms` atomically).
The interface in `src/modules/ratelimit/rate-limiter.ts` is already
shaped to allow swapping the implementation without touching
callers. See DESIGN.md for the scaling cliff.

---

## Metrics and logs

### `/metrics`

Standard Prometheus exposition. The seven gateway-level series are
named with a `gateway_` prefix:

```bash
curl -s $URL/metrics | grep '^gateway_' | head -30
```

| Metric | Type | Labels | What it tells you |
|---|---|---|---|
| `gateway_requests_total` | counter | `tenant_id, provider, model, status` | Per-tenant traffic and outcome breakdown. |
| `gateway_errors_total` | counter | `tenant_id, provider, error_type` | Errors classified by upstream cause. |
| `gateway_latency_ms` | histogram | `provider, model` | End-to-end provider latency. |
| `gateway_tokens_total` | counter | `tenant_id, provider, model, token_type` | Input vs output tokens per tenant. |
| `gateway_cost_usd_total` | counter | `tenant_id, provider, model` | Spend; matches `usage_ledger` over the same window. |
| `gateway_cache_hits_total` | counter | `tenant_id` | Cache effectiveness. |
| `gateway_provider_circuit_state` | gauge | `provider, state` | Real-time breaker state, sampled at scrape. |

### Per-tenant usage summary

`/admin/tenants/:tenantId/usage` aggregates `usage_ledger` over a
date range. Requires `ADMIN_TOKEN`.

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$URL/admin/tenants/00000000-0000-0000-0000-00000000000a/usage?from=2026-05-01&to=2026-05-31" | jq .
```

```json
{
  "tenant_id": "00000000-0000-0000-0000-00000000000a",
  "from": "2026-05-01",
  "to": "2026-05-31",
  "total_cost_usd": 0.001482,
  "total_input_tokens": 1240,
  "total_output_tokens": 873,
  "by_provider": { "openai": { ... }, "anthropic": { ... } },
  "by_model":    { "openai/gpt-4o-mini": { ... }, ... }
}
```

### Example log line

A successful chat request emits one structured line that contains
everything you need for triage:

```json
{
  "level":"info",
  "time":"2026-05-10T14:21:09.123Z",
  "request_id":"r-9f3b...",
  "tenant_id":"00000000-0000-0000-0000-00000000000a",
  "provider":"anthropic",
  "model":"claude-3-haiku-20240307",
  "model_class":"cheap",
  "route_policy":"cost_optimized",
  "routing_reason":"cheapest healthy candidate",
  "cache_hit":false,
  "streaming":false,
  "latency_ms":312,
  "input_tokens":4,
  "output_tokens":21,
  "cost_usd":0.000027,
  "status":"success",
  "msg":"chat request completed"
}
```

For a partial streaming failure, `status` becomes `partial_failed`
and `error_type` is populated; `output_tokens` is the count
actually streamed (the tenant is billed for what was sent).

---

## Design doc

See [`DESIGN.md`](./DESIGN.md) for the architecture, the per-decision
tradeoffs, the failure-mode catalog, and the production gap analysis
(distributed rate limiting, atomic budget reservation, secret
management, multi-instance breaker state, etc.).

---

## Known limitations

These are deliberate; each has a one-paragraph "production fix" in
DESIGN.md.

- **Drizzle ORM, not Prisma.** Drizzle was chosen because tenant
  config, API keys, the usage ledger, provider allowlists, request
  logs, and budget aggregation all benefit from SQL-first control.
  Migrations are generated, applied, and inspectable as plain SQL.
  Prisma's runtime indirection gets in the way for an exercise
  whose grading rewards explicit, defensible queries.
- **Rate limiting is single-node, in-memory, and resets on process
  restart.** Configuration (rate per minute) is in Postgres; the
  counter is in-process. Tenant A burning their bucket on instance
  X does not slow Tenant A on instance Y. Production fix: Redis
  token-bucket behind the same `RateLimiter` interface.
- **Budget accounting is post-request.** Under high concurrency a
  tenant can briefly overspend their cap (bounded by
  in-flight-request-count × per-request-cost, typically pennies).
  Production fix: two-phase reservation — pre-call estimated debit,
  post-call reconciliation — with the ledger as source of truth.
- **`chars / 4` token estimator.** Used for pre-call cost routing
  and for billable-token accounting on partial streams when
  upstream usage isn't yet known. Real adapters prefer
  upstream-reported usage; mocks always use the heuristic. Off by
  20–30% vs a real tokenizer; never used to make a hard policy
  decision (only to rank candidates).
- **One shared `ADMIN_TOKEN` for `/admin/*`.** No per-operator
  identity, no audit trail of who hit what. Fine for a local
  evaluator; not fine for a production billing surface. Production
  fix: OIDC/JWKS in front of the admin routes plus an
  `admin_audit` table with `actor_email, action, target,
  before, after`.
- **Mock providers are the default.** A fresh clone runs against
  in-process mocks so tests and demos cost nothing and produce
  deterministic output. To exercise real upstreams, set
  `MOCK_PROVIDERS=false` plus the relevant API key(s) and
  restart. Tests **always** use mocks unconditionally — the suite
  never makes a real network call.
