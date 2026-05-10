# Multi-Tenant LLM Gateway Design

## 1. Problem framing

The gateway sits in one place: between an application that wants to talk to a
large language model and the upstream providers that actually serve the model.
Without it, every team that needs an LLM either picks one provider and gets
stuck behind that provider's outages, pricing, and rate limits — or duplicates
the same five hundred lines of plumbing into every service. The gateway exists
to centralize that plumbing once, behind a stable contract, so the application
code can stay short and the operational levers (which provider, which model,
how much per tenant, what to do on a 5xx) stay in one repository under one set
of tests.

Concretely, this gateway solves seven problems at once. It abstracts over
provider-specific request and response shapes so a caller writes one request
body and one parser. It isolates tenants — each tenant has its own API key,
its own monthly budget, its own rate limit, and its own allowlist of providers
it can route to, with hard guarantees that one tenant's behavior cannot
degrade another's. It controls cost by routing to the cheapest healthy
provider for the requested model class, falling over to the next candidate
when the cheapest one fails. It contains failure with bounded retries, a
per-call timeout, and a per-provider circuit breaker. It produces operational
artefacts that are useful in three different rooms: structured logs for
on-call debugging, Prometheus metrics for dashboards and alerts, and a
durable usage ledger for finance. It serves both regular and streaming
responses, including the messy case of an upstream that drops mid-stream
after some tokens have already reached the client. And it caches deterministic
responses so a developer iterating on the same prompt doesn't pay twice.

It deliberately does not solve a longer list. It is not a prompt management
tool — applications own their prompts, their templates, their few-shot
examples, and their evaluation harnesses. It does not own user identity;
the API-key model authenticates *services* (or *tenants*), not end users,
and a real product would put OIDC or session middleware in front of the
gateway for the human-identity layer. It is not a frontend or a billing
portal — there is no dashboard, no signup flow, no Stripe integration.
There is no long-term memory or conversation store; messages live for the
duration of one request. There are no async batch jobs, no queue, no worker
pool — every request is synchronous. There is no full RBAC; the admin
surface is gated by a single shared bearer token, fine for a local
evaluator and inadequate for a real billing endpoint.

The boundary that keeps this list short is the rule: **applications own
product logic and prompts; the gateway owns provider access, tenant controls,
routing, failure handling, usage accounting, and logs**. Everything in the
"does not solve" list belongs to either the application above or the
infrastructure below. Putting any of it inside the gateway would either
expand its blast radius (an authentication change shouldn't ship alongside
a provider adapter change) or shrink its reusability (a Stripe integration
ties the gateway to one billing model). Both are real costs. Naming the
boundary up front is the cheapest way to keep the gateway small.

## 2. Architecture

The gateway is a single Fastify process that talks to a single Postgres
database. There is no service mesh, no sidecar, no in-process queue, and no
external cache. The state that needs to survive a restart lives in Postgres;
the state that does not lives in process memory. Drizzle ORM owns the
read/write path to Postgres because the queries this gateway cares about
(per-tenant ledger sums, request log writes, allowlist filters, cache lookups
keyed by tenant + hash) are short and benefit from being legible as SQL rather
than hidden behind ORM-generated query objects.

The non-streaming request flow is a straight-line pipeline with eight stages:

```
                      POST /v1/chat/completions
                                  │
                                  ▼
       ┌──────────────────────────────────────────────────────┐
       │ 1. API-key auth (Bearer)                             │
       │    onRequest hook → SHA-256 hash → tenants row       │
       └──────────────────────┬───────────────────────────────┘
                              │ req.tenant
                              ▼
       ┌──────────────────────────────────────────────────────┐
       │ 2. Request validation (Zod)                          │
       │    model_class, messages, optional stream/temp/...   │
       └──────────────────────┬───────────────────────────────┘
                              ▼
       ┌──────────────────────────────────────────────────────┐
       │ 3. Rate limit (in-memory token bucket per tenant)    │
       │    config from Postgres, counter from process mem    │
       │    miss → 429 TENANT_RATE_LIMITED + Retry-After      │
       └──────────────────────┬───────────────────────────────┘
                              ▼
       ┌──────────────────────────────────────────────────────┐
       │ 4. Budget gate                                       │
       │    SELECT SUM(cost_usd) FROM usage_ledger            │
       │    WHERE tenant_id = $1 AND created_at >= month_start│
       │    over → 402 TENANT_BUDGET_EXCEEDED                 │
       └──────────────────────┬───────────────────────────────┘
                              ▼
       ┌──────────────────────────────────────────────────────┐
       │ 5. Routing (CostOptimizedRoutingPolicy)              │
       │    filter by allowlist + enabled + breaker health    │
       │    rank by estimated cost                            │
       │    → ordered RouteCandidate[]                        │
       └──────────────────────┬───────────────────────────────┘
                              ▼
       ┌──────────────────────────────────────────────────────┐
       │ 6. Cache lookup (Postgres cache_entries)             │
       │    key = SHA-256(tenant + class + provider + model + │
       │                  messages + temperature + max_tokens)│
       │    hit → return cached, cost_usd=0, no ledger write  │
       └──────────────────────┬───────────────────────────────┘
                              │ miss
                              ▼
       ┌──────────────────────────────────────────────────────┐
       │ 7. Provider call (loop over RouteCandidate[])        │
       │    ResilientAdapter = timeout(retry(circuitBreaker(  │
       │                              MockOr Real ProviderAdapter)))│
       │    transient err → next candidate; non-retry → bubble│
       └──────────────────────┬───────────────────────────────┘
                              ▼
       ┌──────────────────────────────────────────────────────┐
       │ 8. recordRequestOutcome                              │
       │    INSERT request_logs, INSERT usage_ledger,         │
       │    INC gateway_*_total counters, log structured line │
       └──────────────────────┬───────────────────────────────┘
                              ▼
                        200 normalized JSON
```

The streaming flow is the same pipeline up to step 6 (which always misses,
because `isCacheable` returns false for `stream: true`). Step 7 hijacks the
Fastify reply, sets `Content-Type: text/event-stream`, and emits one
`data: {"type":"token", ...}` event per chunk. Once the first byte is on the
wire, the failover loop is over: a transient upstream error after that point
yields one `data: {"type":"error","partial":true,"message":"..."}` event,
durable writes complete (`request_logs.status = 'partial_failed'` plus a
ledger row for tokens actually streamed), and then `reply.raw.end()` closes
the socket. The "writes before close" ordering is load-bearing — Fastify's
`inject()` resolves on socket close, so a test that reads `request_logs`
right after the response would race a `reply.raw.end()` that ran ahead of the
DB commit.

State splits cleanly into three durability classes. The first is **durable
business state**: tenant configuration, hashed API keys, provider price
table, tenant allowlists, the usage ledger, request logs, and cache entries.
All of it lives in Postgres because losing any of it is a real bug — a
restart that forgets a tenant's budget is a billing incident, not a glitch.
The second is **runtime state**: the per-tenant token-bucket counters and
the per-provider circuit-breaker state. Both live in process memory because
their durability requirements are minutes, not months. A counter that resets
on restart costs at most one minute of slightly-looser limits; a breaker
that resets means the next caller probes the upstream instead of being short-
circuited, which is fine. The third is **transient state**: in-flight HTTP
connections, streaming sockets, the SSE parse buffer for upstream responses.
Process death loses all of it, and that's the correct semantics — the client
will see a connection drop and retry through whatever load balancer is in
front.

Failure domains map onto those three durability classes. A provider failure
(a 5xx, a timeout, a TCP reset) is contained at the resilient-adapter layer:
retries within attempts, failover within the route candidate list, and a
breaker open if the failure count crosses the threshold. A DB failure is
fatal for any single in-flight request — the budget gate cannot run, the
ledger cannot be written, so the request fails closed with a 5xx, and the
operator either restores Postgres or the gateway stays down. A process
failure (OOM, crash, deploy) loses the rate-limit counters and breaker
state; the next process comes up with empty buckets and closed breakers,
which means the burst right after a restart can be slightly over the
configured rate (one minute's worth, in the worst case) and the next caller
to a degraded provider acts as the implicit probe. A cache failure (Postgres
slow on the `cache_entries` lookup) is treated as a miss — the lookup is
wrapped in the same `await` as the rest of the handler and a slow lookup
means the request is slow but correct; an actual lookup error bubbles up as
a 5xx with the rest. None of these failure domains escape into other
tenants' requests, because the per-tenant boundaries (rate limit, budget,
allowlist) are enforced upstream of the failure surfaces.

The scaling concerns are predictable and named. Postgres write volume rises
linearly with traffic — every successful request appends one `usage_ledger`
row plus one `request_logs` row. At a few hundred requests per second this
is comfortable; at thousands it warrants table partitioning by month and a
log-pipeline split (move `request_logs` to ClickHouse or S3 + Athena, keep
the smaller `usage_ledger` in Postgres for the budget query). Prometheus
metric cardinality is the second cliff: `tenant_id` appears as a label on
five of the seven gateway metrics, which works fine for the seeded two
tenants and explodes the registry once the tenant count grows past a few
hundred. The cardinality fix is bucketing (top-N tenants get their own
series, the rest collapse to `tenant_id="other"`) rather than dropping the
label entirely, because per-tenant breakdowns are the most common
operational question. Rate limiting is the third — the in-memory token
bucket is correct for one node and silently wrong for two, which is why
this is the first piece to swap out on the way to multi-instance. Circuit
breaker state has the same shape, with one subtlety: per-instance breakers
are *locally* correct (each node only opens after it sees N failures
itself) and the symptom of disagreement is recoverable, so the breaker swap
is the third or fourth thing to do, not the first. Usage aggregation
(the SUM query) is currently fine because it runs against an indexed table
with limited rows per tenant; at scale this query becomes a hot path and
moves to a materialized rollup updated on insert. Request log growth is
the last named concern, addressed by either retention (`DELETE` on a cron)
or the same log-pipeline split mentioned above.

## 3. Key decisions and tradeoffs

### 3.1 TypeScript and Fastify

The runtime is TypeScript on Node.js with Fastify as the HTTP layer. The
choice is driven by three things: it is the fastest stack for shipping a
correct LLM gateway in fifteen to twenty hours; it has the type safety to
make request/response contracts and provider adapters self-documenting; and
Fastify itself is a small, well-understood framework with first-class
plugin scoping, schema validation hooks, and a lean dependency graph. A
typical chat handler in this code base reads top-to-bottom in one screen.

The honest comparison: a Go service would be faster at the steady state
and cheaper to run in production at high RPS, with the cost being a less
mature LLM ecosystem and slower iteration speed during the build phase.
NestJS would have given a more opinionated module/decorator structure,
which is useful in larger teams but adds runtime indirection and startup
cost that buys nothing for a single-process gateway. Bun would have given
faster cold starts, with the cost being an ecosystem still catching edge
cases in libraries the gateway depends on. None of those tradeoffs flip
the answer for this assignment, but each one would be worth re-evaluating
at production scale.

### 3.2 Drizzle ORM over Prisma

Drizzle owns every read and write to Postgres. The choice over Prisma is a
deliberate one. Prisma is the better-known tool, has the slicker DX, ships
a useful Studio, and has more migration ergonomics. Its cost is a runtime
indirection: a separate Rust query engine binary, a generated client whose
internals are not the same shape as the SQL it produces, and a learning
curve that hides the actual queries from code review.

For this gateway the queries *are* the interesting part. Budget enforcement
is one indexed `SUM(cost_usd)` over the current month. Cache lookup is
one indexed read keyed by `(tenant_id, cache_key)` with a UNIQUE constraint
defending against accidental cross-tenant serves. Usage aggregation is the
same shape, grouped. Drizzle keeps these as one-line composable expressions
in TypeScript that look exactly like the SQL they emit. A reviewer can see,
in one glance, that the budget gate filters by `tenant_id` and reads only
that tenant's rows. The price for that legibility is that joins and
migrations require slightly more typing than Prisma's auto-generated
equivalents. Worth it for a system whose grading specifically rewards
defensible data access.

### 3.3 Postgres as source of truth

A single Postgres instance holds every piece of durable state the gateway
owns: `tenants`, `api_keys` (hashed with SHA-256), `provider_configs`
(including pricing per 1k tokens, kept in the database so an operator can
edit it without a deploy), `tenant_provider_allowlists`, `usage_ledger`,
`request_logs`, and `cache_entries`. There is no second store, no Redis, no
DynamoDB, no S3. The gateway's reliability ceiling is therefore Postgres's
reliability ceiling, which is fine for a system whose answer to "what
happens if the DB is down?" is "the service is down too" (the alternative
of serving traffic without being able to read budgets or allowlists is
strictly worse).

The tradeoff is volume. `request_logs` is the row that grows fastest — one
per terminal outcome, including streaming partial failures. At the
assignment's traffic profile this is comfortable; at production scale it
needs either monthly partitioning (`pg_partman` or hand-rolled) or a
log-pipeline split that pushes the high-volume rows to ClickHouse or
S3 + Athena while keeping the smaller, query-shaped `usage_ledger` in
Postgres for the hot budget query. The schema is structured to make that
split clean — `request_logs` is append-only and never read by the hot
path; `usage_ledger` is read by every chat call and is the one that
benefits from staying close.

### 3.4 Provider adapter interface

Every upstream sits behind one interface, `ProviderAdapter`, with three
methods: `complete()`, `stream()`, and `resolveDefaultModel()`. The mocks
implement it. The real OpenAI and Anthropic adapters implement it. The
resilience wrapper is itself a `ProviderAdapter` that delegates to an inner
one. The chat handler, the streaming handler, the routing module, the
cache, the request log writer, and the Prometheus counters never need to
know the difference.

The proof is Phase 10. Adding live OpenAI and Anthropic adapters touched
exactly two directories: `src/modules/providers/` (the new adapter files,
a shared SSE parser, and a single error classifier) and `src/app.ts` (the
factory wiring). Nothing else changed. The same shape will accommodate any
future provider — a third LLM vendor, an internal model, a tracing proxy
sitting in front of the real provider — as one new file plus one wiring
line. The cost is minor: an extra await per call (the wrapper layer), and
the discipline of keeping provider-specific concerns out of every other
file. Both are paid.

### 3.5 Cost-optimized routing with failover

The brief asks for one non-trivial routing policy. The implementation is
`CostOptimizedRoutingPolicy`: filter the candidate set by requested
`model_class`, by the tenant's allowlist, by the `enabled` flag on the
provider config row, and by per-provider circuit-breaker health; rank the
survivors by estimated cost using the input-token estimate from the
request body. The output is an ordered `RouteCandidate[]` that the chat
handler walks in order, falling through to the next candidate when the
current one fails with a retryable error. Failure handling lives in the
chat handler, not in the router; the router's job ends at "ordered
preference list."

Cost optimization is the policy a budget-bound tenant actually wants — it
exercises every routing seam (allowlist filter, enabled filter, registry
filter, health filter, cost ranking, ordered fallback) and is directly
connected to the budget gate two stages upstream. Latency-aware or
quality-aware policies would be valuable additions but were deliberately
not built; the `RoutingPolicy.pick` interface is shaped so a future
latency-aware implementation slots in without touching the chat handler.
The cost of the current policy is real: latency variance between providers
is invisible to the router. A provider that is healthy but slow gets the
same cost-rank treatment as one that is healthy and fast. Phase 9's
`gateway_latency_ms` histogram surfaces this for humans, and the
`PROVIDER_TIMEOUT_MS` knob caps the worst case at the resilience layer.

### 3.6 Single-node in-memory token bucket for rate limiting

Rate limiting uses a per-tenant `TokenBucket` held in process memory. The
bucket capacity (tokens per minute) is loaded from `tenants.rate_limit_per_minute`
in Postgres on every request, so reconfiguring a tenant's cap takes effect
on the very next call without a restart. The counter itself — current
tokens, last refill timestamp — lives in the in-process map keyed by
`tenant_id`. A bucket miss returns `429 TENANT_RATE_LIMITED` with the
`Retry-After` header set to the time until the next token is available.

This is the most clearly assignment-shaped decision in the whole codebase.
It is correct on a single node and silently wrong on two — Tenant A burning
their bucket on instance X does not slow Tenant A on instance Y. Restart
loses the counter, which means the burst right after a restart can briefly
exceed the configured rate. The right production swap is a Redis token
bucket — `INCR` plus `EXPIRE`, or a small Lua script that atomically
returns `tokens_left` and `retry_after_ms` so the gateway never needs a
second round-trip. The swap is one file: a `RedisRateLimiter` that
implements the existing `RateLimiter` interface. The chat handler is
unchanged. Wiring the abstraction this way up front, instead of inlining
`bucket.consume()` calls into the handler, is the only piece of work the
production swap doesn't have to redo.

### 3.7 Postgres usage ledger for budget enforcement

Spend is durable business state, so it lives in Postgres. The
`usage_ledger` table is append-only — every successful chat call writes one
row containing `(tenant_id, provider, model, request_id, input_tokens,
output_tokens, cost_usd, created_at)`. The budget gate runs one query on
every chat request: `SELECT SUM(cost_usd) FROM usage_ledger WHERE tenant_id
= $1 AND created_at >= start_of_month`. If the sum exceeds
`tenants.monthly_budget_usd`, the request is rejected with
`402 TENANT_BUDGET_EXCEEDED` and the `spent_usd` and `budget_usd` numbers
in the response body so the caller can show the user a useful error.

The honest tradeoff is the race window. The handler reads spend, then calls
the provider, then writes the ledger row. Under high concurrency for the
*same* tenant, two simultaneous requests can both observe `spend < budget`
and both succeed, slightly overspending the cap. The overspend is bounded
by `(in-flight requests for that tenant) × (cost per request)` — typically
pennies, often less. Acceptable for assignment scope. The production fix
is two-phase atomic reservation: insert a "pending" ledger row with the
*estimated* cost before the provider call, treat that row as committed
spend in the budget query, then update or insert a compensating row with
the actual cost after the call returns. The schema already supports this
because it's append-only by design — adding a `status` column or a
compensating-row pattern is additive, not breaking.

### 3.8 Retry, timeout, and circuit breaker

Provider failure is contained by one wrapper, `ResilientAdapter`, that
composes three controls. A timeout race against `PROVIDER_TIMEOUT_MS`
(default 20 seconds) — when the upstream doesn't return in time, the wrapper
synthesizes `ProviderError(504, retryable=true)` so the surrounding logic
treats it like any other transient error. Bounded retries on retryable
errors only — three attempts maximum, with delays of 200ms then 500ms and
30% jitter, governed by a single `defaultIsRetryable(err)` predicate that
is the only place "what counts as retryable" is decided. And a per-provider
`CircuitBreaker` with the canonical three-state machine (CLOSED → OPEN
after five failures in 60 seconds → HALF_OPEN after 30 seconds → one probe
through → CLOSED on probe success or back to OPEN on failure).

Two design choices are worth naming. The breaker is keyed per-provider, not
per-(provider, model) or per-(tenant, provider). The thing that goes down
is the upstream service, not one model on one upstream, and not one tenant
talking to one upstream. Tracking failures at any finer grain dilutes the
signal — the breaker takes longer to open because failures are spread
across more buckets — and slows recovery because the HALF_OPEN probe has
to happen separately for each bucket. The blast radius is bounded by the
existing tenant isolation: a tenant whose model class can be served by a
second provider keeps getting answers via failover; a tenant whose
allowlist is one-provider-deep gets a clean `503 no_provider_available`
quickly so the application can decide what to do, instead of spending
budget on retries that will never work.

The second choice: 4xx errors are explicitly never retried. A real adapter
marks them `retryable=false`; the predicate refuses to retry them; the
breaker doesn't count them as failures. Retrying a malformed request would
just multiply the user's bill by three. The one exception is 429 rate
limit, which is treated as retryable (per the assignment's "may fallback"
wording) so the resilience layer retries-then-fails-over to a different
provider rather than refusing service immediately.

The single-node breaker state is the same scaling cliff as the rate
limiter, with a softer landing. Two replicas can hold different views of
the same upstream, but each view is *locally* correct (a node only opens
after *it* observes the threshold) and recovery is independent (one node
opening doesn't prevent another from probing). The production fix has the
same shape as for rate limiting — a Redis-backed shared breaker behind the
existing `ProviderHealthOracle` interface, with `SET NX EX` for the
HALF_OPEN probe lock so exactly one node probes at a time.

### 3.9 TTL-based deterministic cache

The cache is intentionally simple. Postgres-backed `cache_entries`, SHA-256
hash key over `tenant_id + model_class + selected_provider + selected_model
+ normalized_messages + temperature + max_tokens`, configurable TTL via
`CACHE_TTL_SECONDS` (default 300). It applies only to non-streaming
requests with `temperature == 0` — anything else (`stream: true`,
`temperature > 0`, missing temperature interpreted as nondeterministic)
bypasses both the lookup and the write. Cache hits report `cost_usd: 0`,
skip the `usage_ledger` write, and set `routing.policy = "cache"` so a
reader of the response or the logs can immediately see that no provider
call happened.

Three details are worth defending. The cache key is keyed on the *selected*
provider and model — the routing decision happens before the cache lookup —
so a request that would have gone to OpenAI but failed over to Anthropic
yesterday cannot serve OpenAI's old answer to a request that would route
to Anthropic today. The two responses would have come from different
models and would (rightly) differ. Tenant ID is present in both the cache
key (cryptographic isolation: a key collision across tenants is
infeasible) and the storage row's `(tenant_id, cache_key)` UNIQUE
composite index (defense-in-depth: an accidental cross-tenant serve
becomes a Postgres constraint violation rather than a silent leak).
Streaming responses are never cached because replaying them would mean
re-chunking and re-emitting `done`, plus the latency reason for streaming
(tokens visible as they generate) is destroyed if the whole response is
shipped at once anyway.

The tradeoff is that a TTL cache misses semantic matches — "what is two
plus two" and "what is 2 + 2" hash differently, and only the literal
replay benefits. A semantic cache (embed prompts, vector-search for
nearest neighbours over a similarity threshold) would catch those, at the
cost of a vector index, an embedding model call on every request, and a
much harder consistency story (what if two prompts that hash similar
should produce different answers?). For an assignment whose evaluator wants
to demo deterministic replay, the literal TTL cache is the defensible
choice.

### 3.10 SSE streaming with first-byte commitment

Streaming uses the standard Server-Sent Events shape: response
`Content-Type: text/event-stream`, one `data: {"type":"token","content":"..."}`
event per chunk, terminated by `data: {"type":"done"}`. The handler
hijacks Fastify's reply (`reply.hijack()`) and writes directly to the raw
socket because Fastify's serialization layer wants a buffered JSON
response, which is exactly the wrong shape for a stream.

The hard rule, named once and obeyed everywhere: **the first byte commits
the response**. Before any `token` event has been written, the streaming
handler is identical to the non-streaming failover loop — a retryable
upstream error rolls over to the next route candidate and the client
never observes the failure. Once the first `token` is on the wire, the
gateway has irrevocably told the client "the answer is coming from
provider X". Failing over after that point would mean the client receives
output from two different providers concatenated as if it were one
response, which is worse than any error message we could send. So: emit
exactly one `data: {"type":"error","partial":true,"message":"..."}`
event, await the durable writes, then close the socket. Tests rely on
this contract, so do callers; the rule lives in one place
(`firstByteSent` in `streaming/handler.ts`) and is not a policy a future
caller can override.

Two operational details support that rule. Partial responses are billed —
the `partial_failed` path writes a `usage_ledger` row for the tokens
actually streamed, using the same `chars / 4` heuristic the rest of the
gateway uses. Walking away without billing would be the gateway eating
the cost; worse, it would let any caller minimize spend by hanging up
mid-stream, which is a predictable abuse vector. And the
`reply.raw.end()` ordering is load-bearing: durable writes to
`request_logs` and `usage_ledger` complete *before* the socket closes,
because Fastify's `inject()` (used by tests) and any real HTTP client
both resolve on socket close. End-then-write would race anyone reading
the database immediately after the response.

### 3.11 No queue

Every request through this gateway is synchronous. Client sends, gateway
calls upstream, gateway responds — possibly streaming, but always within
one HTTP exchange. There is no message broker, no worker pool, no inbox
or outbox table, no DLQ. The omission is deliberate.

A queue would change two things. First, it would change the client model
from synchronous request/response to asynchronous job submission with
status polling, which is a different API contract and doubles the surface
area (submit-job, poll-status, fetch-result, plus the failure modes for
each). Second, it would add operational surface: a broker to keep alive,
a worker pool to scale, retry and timeout semantics to define, a DLQ to
inspect. Both of those are real costs that buy nothing for synchronous
chat completions where the user is waiting on the other end of the
socket. The future case where a queue *is* the right answer — nightly
embedding pipelines, batch evaluation runs, async fine-tuning — is
explicitly out of scope. When it lands, it lands as a separate service
that calls *into* this gateway, not as a layer inside it.

### 3.12 Mock providers and failure injection

The mock providers exist for one reason: to exercise every retry, every
failover, every breaker transition, and every partial-stream path on every
CI run without spending a cent. `MOCK_PROVIDERS=true` (the default) wires
both providers as deterministic in-process implementations of the same
`ProviderAdapter` interface as the real adapters. Tests use mocks
unconditionally — the real-adapter unit tests inject a fake `fetch` rather
than touching the network — so `npm test` can never accidentally bill a
real account.

Failure injection has two complementary surfaces. The original is
header-based and per-request: `x-skyclad-fail: 5xx` (or `timeout`,
`pre-stream-drop`, `stream-drop`), optionally scoped with
`x-skyclad-fail-provider: openai`, makes one call fail the named way.
This is surgical — the failover tests rely on it because they need to
break openai while leaving anthropic healthy. The Phase 11 addition is a
persistent store consulted by the same `MockProviderBase.resolveFailure`
function: `POST /admin/mock-providers/openai/failure-mode` writes the
failure mode into a process-local map, every subsequent call sees it,
`{"mode":"normal"}` clears it. The header still wins when both are
present, so existing tests are unchanged. The two together cover both the
"this single call fails" use case and the "every call until I clear it"
use case without forcing the evaluator to choose between them.

## 4. Failure modes

### 4.1 Provider returns 5xx

The adapter throws `ProviderError(500, retryable=true)` (real adapters do
this via `mapHttpStatusToProviderError`; mocks emit it directly). The
resilient wrapper catches it, sleeps for the configured backoff with
jitter, and retries up to the attempt limit. If all attempts fail and the
breaker tally crosses the threshold, the breaker opens. The chat handler
moves to the next route candidate. If all candidates exhaust, the response
is `502 all_providers_failed` with the per-provider error trail and
attempt count in the body, plus a `request_logs` row with
`status = "all_providers_failed"` and `gateway_errors_total` incremented.
Production behavior would be similar; the difference is dashboards and
alerts on the error counter would surface the upstream issue before any
single tenant's failover budget is exhausted.

### 4.2 Provider is slow but not failing

The per-call timeout (`PROVIDER_TIMEOUT_MS`, default 20s) races every
provider call. When it expires, the timeout wrapper aborts the in-flight
request and synthesizes `ProviderError(504, retryable=true)`. From the
rest of the gateway's perspective this is indistinguishable from a real
504 — the resilient wrapper treats it as a transient failure, retries
within the attempt budget, and the breaker counts it. Fallback to the
next candidate happens through the same handler loop. The honest
limitation is that "slow" is binary — the request is either under the
threshold or counted as a failure. A latency-aware router would notice
slow-but-successful providers and prefer faster ones, but that's a Phase
> 11 piece of work and the metrics layer captures the data needed to
build it.

### 4.3 Provider 429 (upstream rate limit)

Upstream 429 is treated as transient (`retryable=true`), distinct from
the gateway's own `429 TENANT_RATE_LIMITED`. The resilience wrapper
retries with backoff, and if retries are exhausted the chat handler
moves to the next route candidate. This matches the assignment's "may
fallback" wording — when one provider is throttling us, the cheapest
working alternative is the next provider in the cost ranking, not a
2-second wait followed by another retry against the same provider. The
distinction matters because tenant-side rate limiting (the in-memory
bucket) and upstream-side rate limiting are different problems that
deserve different responses, even though they share the HTTP code.

### 4.4 Provider fails mid-stream

Two sub-cases governed by the first-byte commitment from §3.10. If the
upstream fails *before* any `token` event has been written to the
client's socket, the streaming handler treats the failure exactly like
the non-streaming failover loop — bubbles up to the next route candidate,
silently. The client never knows the first attempt happened. If the
upstream fails *after* any token has been emitted, the handler does not
retry. It writes one `data: {"type":"error","partial":true,
"message":"..."}` event, awaits a `request_logs` row with `status =
"partial_failed"` and a `usage_ledger` row for the tokens actually
streamed, and only then closes the socket. The client sees real tokens
followed by a clearly-marked partial-error event and can decide whether
to retry the whole request or render what it has.

### 4.5 Database unavailable

The gateway fails closed. Every request needs the auth hook (one DB
read), the budget gate (one DB read), and the post-response writes
(`usage_ledger` + `request_logs`). If Postgres is unreachable, the auth
hook returns 5xx and the request never reaches the routing layer. There
is no fallback to a cached tenant config because reading stale auth or
stale budgets is worse than refusing service: a stale auth read could
authenticate a revoked key, and a stale budget read could approve a
request that would have been over-budget. Production improvements: a
read replica behind PgBouncer to ride out single-primary failures, a
short-lived (single-digit second) in-process cache for the hottest reads
that lets the gateway tolerate brief blips, and a connection pool with
retry-on-timeout so a momentary network blip doesn't cascade into a
restart loop.

### 4.6 Tenant sends an oversized prompt

Today the request validation layer (Zod) accepts arbitrary message
content and the request reaches the provider, which will reject very
large prompts with its own context-window error (typically a 4xx). That
error is correctly classified non-retryable and bubbles back to the
client. The gateway-side improvement would be to enforce a size limit
(token estimate, not byte count, since 100k bytes of code is very
different from 100k bytes of prose) at the validation layer, before the
provider call, returning a deterministic 413 with the configured limit
in the body. This is a one-screen change in `chat/routes.ts` and was
left out as low-value-for-assignment-scope; production should add it
before exposing the gateway to untrusted callers because the alternative
is paying the rate-limited 4xx round trip on every oversized request.

### 4.7 Tenant exhausts budget

Only that tenant is rejected. The budget gate is keyed on `tenant_id`
and reads only that tenant's ledger rows; nothing else in the request
pipeline shares state across tenants. The response is
`402 TENANT_BUDGET_EXCEEDED` with `spent_usd` and `budget_usd` populated
so the application can render a useful error. Other tenants making
requests at the same moment see no impact — their budgets are read from
their own rows, their rate-limit counters are independent, their
cached responses are isolated. The Phase 5 test
`tests/budget.test.ts` proves this end-to-end: tenant_a is over budget,
tenant_b's request returns 200 against the same gateway process in the
same test.

### 4.8 Budget race under concurrency

Named in §3.7 and worth restating. The post-call accounting pattern
allows two concurrent same-tenant requests to both observe `spend <
budget` before either has written its ledger row. Both succeed. The
result is a small overspend bounded by the in-flight count times the
per-request cost. This is pennies in practice, not a meaningful billing
concern at the assignment scope. The production fix is a two-phase
atomic reservation: the gateway atomically inserts a "pending" row with
the *estimated* cost, the budget query treats pending rows as committed
spend, the provider is called, and the post-response handler updates the
pending row to the actual cost (or inserts a compensating row, since
the table is append-only). The schema is shaped to accept this
extension without breaking existing reads.

### 4.9 Rate limiter resets on app restart

The in-memory token bucket loses its state on restart. The next caller
hits an empty bucket and gets full-rate access for one minute. Bounded
in cost (one minute of one tenant's quota) and acceptable for a system
intentionally designed as single-node. The production swap is a Redis
token bucket behind the existing `RateLimiter` interface; restart
becomes irrelevant because the counter lives outside the process.

### 4.10 Multiple application instances

The two pieces of in-memory state — rate-limit buckets and circuit
breakers — would both diverge across instances. For rate limits, this
is silently wrong: per-instance buckets multiply the effective rate by
the instance count. For breakers, this is recoverable: each instance is
locally correct, recovery happens independently, and the symptom is
that one instance might still be probing a degraded provider while
another has already moved on. Both are addressed by the same swap shape
(Redis-backed shared state behind the existing interfaces), with the
rate-limit swap being the higher priority because its failure mode is
silent and the breaker swap can be deferred until the operational cost
of disagreement starts to matter.

### 4.11 Cache race

Two concurrent identical requests can both miss the cache, both call
the provider, both write the same row. The
`(tenant_id, cache_key)` UNIQUE composite index ensures only one row
ends up persisted (the second insert hits an `ON CONFLICT` upsert), so
correctness is preserved — both callers get a correct response — but
the gateway pays the provider cost twice. The production fix is
single-flight locking: a short-lived Redis lock on the cache key for
the duration of the provider call, with the second caller awaiting the
first's result instead of issuing its own provider call. Worth
implementing once provider cost dominates and traffic patterns include
tight-loop identical replays; not worth it for assignment scope.

### 4.12 App restart

Postgres-backed state survives intact: tenant config, budgets, ledger,
allowlists, request logs, cache entries. In-process state resets:
breakers all start CLOSED, buckets all start at full capacity, the
mock failure-mode store clears (intentional — a debug knob should not
survive a deploy). The first caller after restart may see a slightly
different routing decision than the last caller before restart (because
a previously-OPEN breaker is now CLOSED and the unhealthy provider is
back in the candidate list); the resilience layer absorbs this within
one or two request cycles. None of it is a correctness issue.

## 5. What was not built

The omissions below are deliberate, not deferred. Each was considered,
each was named, and each was cut for one of three reasons: out of
assignment scope (the brief explicitly excludes it), wrong cost-benefit
ratio for a fifteen-to-twenty-hour build (would consume disproportionate
hours for marginal grading signal), or actively harmful at this scope
(would add complexity that masks the architecture the grader is here to
evaluate).

There is **no frontend, dashboard, or admin UI**. Observability is
Prometheus exposition plus structured JSON logs plus a per-tenant usage
endpoint that returns aggregated JSON. An evaluator who wants a graph
points Grafana at `/metrics`. A frontend would have been an entirely
separate project and would not have improved any single backend grading
signal.

There is **no distributed rate limiting** and **no Redis-backed shared
counters**. Rate-limit state is in-process; circuit-breaker state is
in-process. Both are correct for one node and explicitly wrong for two.
The interfaces (`RateLimiter`, `ProviderHealthOracle`) are shaped so the
swap to a Redis-backed implementation is one new file each, with no
caller changes. Building the Redis path now would have required adding
Redis to the Compose stack, the test setup, and the operational story —
five hours of work that buys nothing for a single-process demo.

There is **no pre-request budget reservation**. Accounting is
post-call, with the documented overspend race in §3.7 / §4.8. The
production fix is named and the schema accommodates it without breaking
changes; building it now would have required either a more complex
ledger schema (status column, reconciliation worker) or a second store
(Redis for reservations, Postgres for committed rows), both of which
would have been a significant additional surface to test.

There is **no semantic cache**. The literal TTL cache catches replay
patterns and nothing else. A semantic cache would require an embedding
model, a vector index, a similarity threshold, and a story for what to
do when two semantically-similar prompts should produce different
answers. Real product value, real complexity, and explicitly named in
the brief as out of scope.

There is **no queue, no worker pool, no async job model**. The gateway
is one synchronous request/response surface. A queue belongs in a
separate service that calls into this gateway when batch workloads
arrive (embedding pipelines, eval runs, fine-tuning); folding it into
the gateway itself would have changed the API contract and doubled the
operational surface for use cases the assignment doesn't test.

There is **no full RBAC or production auth surface**. Tenant API keys
are hashed and indexed; admin endpoints share a single `ADMIN_TOKEN`
bearer. There are no per-operator users, no SSO integration, no audit
log of who hit `/admin`, no rotation flow. Adequate for a local
evaluator; inadequate for a production billing endpoint, and §6 names
the gap.

There is **no Kubernetes deployment**. Docker Compose runs Postgres
locally; the gateway runs as a plain Node process. A real deploy would
need a container image, Helm chart or Kustomize overlay, autoscaling
policy, readiness/liveness probes, network policy, and secret-manager
integration. Each of those is a real piece of work with no grading
signal in an assignment whose deliverable is a code repository.

There is **no exhaustive provider pricing database**. The seeded
`provider_configs` rows cover the five real models the assignment is
likely to touch (gpt-4o-mini, gpt-4o, claude-3-haiku, claude-3-5-sonnet,
claude-3-opus). Adding the rest is data, not engineering, and was left
to a later operator-facing task.

There is **no exact tokenizer**. The chars-divided-by-four heuristic
is used for pre-call cost estimates and for partial-stream billing when
upstream usage is not yet known. Real adapters prefer upstream-reported
usage when available. The estimator is off by 20-30% versus a real
tokenizer (tiktoken, anthropic-tokenizer); the impact is contained to
routing rank order (cost ranking is monotonic in the estimate, so the
rank is usually right) and to billed-but-not-served tokens on partial
streams (worst case: a tenant overspends by 30% of one partial-stream's
output tokens, recoverable at next month's reconciliation).

There is **no load testing suite**. The performance characteristics of
this gateway are described in §7 from first principles, not measured.
A load test would be a separate body of work (k6 or wrk2 scripts, a
provisioning story for a load generator that doesn't share resources
with the system under test, baselines and regression alerts) and would
not have improved the design grading signal.

There is **no long-term log retention or partitioning**. `request_logs`
grows unbounded today. The production answer (monthly partitioning or a
log-pipeline split) is named in §3.3; the implementation was cut as
low-priority for assignment scope.

## 6. Production gap analysis

The gaps below are the ones that matter most before this gateway sees
real production traffic. They are ordered by criticality, not by
implementation difficulty.

**Authentication and secret management.** The single shared
`ADMIN_TOKEN` is the most obvious gap. Production needs OIDC or
SAML in front of `/admin/*` so each call carries an operator identity
that survives into the audit trail; the audit trail itself is a new
table (`admin_audit` with `actor_email`, `action`, `target`, `before`,
`after`, `reason`) written on every privileged call. Tenant API keys
need a rotation flow — a one-time-shown new key, an overlap window
where both old and new authenticate, then revocation of the old. All
provider API keys move out of `.env` and into a secrets manager (AWS
Secrets Manager, Vault) with rotation via the platform layer instead
of code redeploy. Hashing is already SHA-256, which is fine for
authenticator-style "did this raw key match this row?" lookups but
should be re-evaluated against argon2id if the threat model includes
offline cracking of a stolen DB dump.

**Distributed rate limiting and atomic budget reservation.** These
are two changes but the same scaling story. Rate-limit counters move
to Redis with a Lua script that atomically returns
`(tokens_remaining, retry_after_ms)`, behind the existing
`RateLimiter` interface — the chat handler is unchanged. Budget
enforcement moves to a two-phase pattern: pre-call atomic reservation
of the estimated cost (insert a `pending` row with `cost_usd` set to
the estimate), the budget query treats pending rows as committed
spend, and a post-call writer either updates the pending row to the
actual cost or inserts a compensating delta. Both changes eliminate
overspend and concurrent-overage windows that exist in the current
implementation. Rough effort: two engineer-weeks including tests and
the production cutover.

**Observability stack.** The current gateway emits structured JSON
logs and Prometheus metrics; production needs the rest of the stack
those signals feed into. An OpenTelemetry collector replacing direct
Prometheus exposition (so traces and metrics share the same export
path), a trace backend (Honeycomb, Tempo, or Datadog), Grafana
dashboards keyed on the seven `gateway_*` series with one panel per
SLO, and an alerting layer that pages on the obvious failures —
provider error rate above some percent over five minutes, p99 latency
above the budgeted threshold, budget-exceeded counter spiking in a
way that suggests an upstream pricing change or a misconfigured
tenant, circuit breaker open for longer than the cooldown. SLOs
themselves need to be defined; the brief doesn't, so neither does the
gateway. A reasonable starting set: 99.5% non-streaming success rate,
p99 latency under 5 seconds (excluding upstream latency), budget
enforcement applied within one second of the cap being crossed.

**Deployment and reliability.** Containerize the gateway (a Dockerfile
that uses `node:22-alpine` as the base and `npm ci --omit=dev` for
the runtime layer), publish the image, ship it via either Helm or a
plain Kustomize overlay. Add readiness and liveness probes — the
existing `/health` endpoint is the liveness check; a richer
`/ready` endpoint that confirms Postgres connectivity and at least
one provider being healthy is the readiness check. Connection
pooling moves to PgBouncer in transaction mode in front of Postgres
to handle the connection storm a horizontally-scaled gateway would
otherwise produce. Deployment strategy is blue/green or rolling with
a small surge — the gateway is stateless aside from in-memory rate
limits and breakers, both of which are designed to tolerate
restarts. Operational documentation: a runbook covering "provider
down", "DB read replica lag", "rate-limit reset after deploy",
"runaway tenant", and "secret rotation" — each as a paragraph and a
linked dashboard.

**Data retention, redaction, and compliance.** Request logs today
contain `tenant_id`, `provider`, `model`, and outcome — but
production logs need to consider whether to capture (and how to
redact) the messages themselves. The defensible pattern is to log
prompt and completion lengths but not contents on the structured-log
path, with a separately-gated and shorter-retention store for the
actual contents when an operator needs them for incident review.
Retention itself moves to a policy: hot Postgres for the last 7
days, warm S3 (Parquet) for the last 90, cold Glacier for the rest,
with the cutoffs driven by partition swaps rather than `DELETE`
statements that produce table bloat. Tenant data isolation gets a
formal review (the existing `tenant_id` boundaries are the
correctness story; production needs a data-leakage test in CI that
asserts no tenant can ever see another's logs, ledger, or cache).
PII handling is largely the application's problem — the gateway
doesn't know whether a prompt is benign — but the gateway's
contribution is the aforementioned content-vs-metadata split and a
documented rule that prompts are never echoed in error responses.

Three more gaps deserve mention without a full paragraph each. Load
testing belongs in CI before any tuning: k6 against a mocked
upstream to validate the gateway's overhead, then against a
sandboxed real upstream to validate the resilience layer end-to-end.
Security review: a third-party pass over the auth surface, the SSE
parser (which handles untrusted upstream input), and the cache key
construction (which must remain collision-resistant across plausible
malicious inputs). And provider pricing accuracy: today the
`provider_configs` table is hand-maintained; production needs either
a daily import job from the upstreams' pricing pages or an alerting
diff so an unannounced price change doesn't quietly skew routing.

## 7. Scaling story

This implementation is intentionally designed for correctness and
clarity at low traffic. The shape it would take at higher traffic is
predictable and the place each shortcut becomes a problem is named.

**At 10 RPS.** A single application instance and a single Postgres
instance handle the load comfortably. The dominant latency is the
upstream provider call (hundreds of milliseconds to seconds); the
gateway's own overhead is sub-millisecond. The in-memory token
bucket is correct because there is one node. Direct
`INSERT INTO usage_ledger` and `INSERT INTO request_logs` writes
are well under any contention threshold. Prometheus scrape volume is
trivial. The gateway runs from a developer's laptop or a single
small container with no special tuning. This is the regime the
assignment evaluates.

**At 1,000 RPS.** Three things have to change. The application has
to scale horizontally, which means in-memory rate limiting becomes
silently wrong (the effective tenant rate is multiplied by the
instance count) and has to move to Redis. Postgres connection
counts blow past the default pool — PgBouncer in transaction mode
is the standard answer. Request log volume is now serious (a
million rows per day per instance is plausible) and either gets
partitioned by month within Postgres or split into a log pipeline
that pushes to ClickHouse / S3. Budget reservation has to become
atomic, because at 1k RPS the per-tenant concurrent-request count
is high enough that the post-call accounting race produces real
overspend. Prometheus cardinality starts to matter: with a thousand
tenants on the seven gateway metrics, the registry can hold tens
of thousands of series and the per-tenant label needs bucketing.
Circuit breaker disagreement between instances becomes operationally
visible — different instances show different error rates for the
same provider — and warrants the Redis-backed shared breaker, but
this is a "nice to have" rather than a "must have" because each
instance's view is locally correct.

**At 100,000 RPS.** The gateway is no longer a single service. It
is a control plane and a data plane. The data plane (the chat
handler, the resilient adapters, the streaming code) runs in many
instances per region; the control plane (tenant config, provider
config, allowlist updates, breaker overrides) is a separate
service that publishes to the data plane via a fan-out mechanism
(Redis pub/sub, Kafka, or a config-as-code reload pattern). Usage
accounting moves out of the synchronous request path: each chat
request emits a Kafka event with the usage details, a separate
aggregator service consumes the events and writes the durable
ledger. The budget gate reads from a per-tenant counter in Redis
(atomically maintained by the aggregator), with the Postgres
ledger as the slow but authoritative source for monthly closing.
Request logs go to S3 / Parquet exclusively, with Athena or
Snowflake for ad-hoc queries; Postgres holds only `tenants`,
`api_keys`, `provider_configs`, `tenant_provider_allowlists`, and
the small derived tables. Multi-region deployment makes routing
region-aware (route to the closest healthy provider region for the
tenant's home region) and circuit-breaker state region-local
(provider issues are usually regional, so global state would
trigger spurious cross-region failovers). Cache moves out of
Postgres into a dedicated layer (Redis for hot, S3 for cold). The
seven Prometheus metrics get materialized into ClickHouse via a
collector for long-term trend analysis; the live `/metrics`
exposition keeps a smaller summary view to bound cardinality. None
of this is hypothetical — it's the same scaling story every
high-throughput gateway-shaped service ends up at, and the
interfaces in the current implementation (`RateLimiter`,
`ProviderAdapter`, `ProviderHealthOracle`, `RoutingPolicy`,
`CacheRepository`) are exactly the seams that would still apply.

The honest summary: this assignment implementation is intentionally
designed for correctness and clarity, not for 100,000 RPS. The
design is structured so the places where production scaling would
happen are visible — every "single-node" or "in-memory" or
"Postgres-backed" choice is named in this document with the swap
that would be required and the interface that would absorb the
swap. The chosen shortcuts are explicit, defendable, and
reversible. None of them involve breaking changes to the API
contract or the data model; all of them are infrastructure
concerns that the gateway's seams have been shaped to accommodate.
