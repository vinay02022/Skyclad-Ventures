# DESIGN

> Phase 1 placeholder. The real design document is written incrementally as
> features land, then tightened into a single coherent narrative before
> submission. This file already commits to the structure the assignment
> requires so nothing gets forgotten.

## 1. Problem framing

_To be written._ One paragraph on what this gateway exists to solve (unified
provider surface, tenant isolation, cost control, resilience, observability)
and an explicit list of what it does not solve (it is not a model router for
agent frameworks, not a billing system, not a prompt management tool).

## 2. Architecture

_To be written._ Single Fastify process, single Postgres, in-memory cache and
rate limiter. Diagram of request flow: auth → rate limit → cache lookup →
router → resilience wrapper → provider adapter → response. State boundaries
called out explicitly.

## 3. Key decisions and tradeoffs

Locked in so far:

- **TypeScript + Fastify** over Go/Rust: faster to ship adapters, evaluator
  reads it, plenty of production precedent. Cost: GC pauses, single-thread
  hot path.
- **Drizzle over Prisma**: SQL-first, no separate query engine binary, lighter
  runtime, easier to reason about for the usage ledger and request log queries
  the assignment cares about. Cost: less migration ergonomics than Prisma.
- **Single-node, in-memory token bucket** for rate limiting; Postgres
  `usage_ledger` for budgets. Cost: documented scaling cliff at >1 node.
- **No off-the-shelf gateway** (LiteLLM/Portkey/etc.) — assignment hard
  constraint, and the point is to show the engineering judgment those
  libraries embed.
- **One routing policy: cost-optimized with failover.** The spec asks for
  one non-trivial policy. Cost-optimized exercises every routing seam
  (allowlist filter, enabled filter, registry filter, health filter, cost
  ranking, ordered fallback) and is the policy a budget-bound tenant
  actually wants. The seam (`RoutingPolicy.pick`) makes a future
  latency-aware policy a drop-in. Building both today would be over-
  engineering. Cost: latency variance between providers is invisible to
  the router (Phase 6 metrics will surface it for humans).
- **`ProviderHealthOracle` interface in place before the breaker exists.**
  Phase 4 ships an `AlwaysHealthyOracle`. Phase 5's circuit breaker plugs
  into the same interface — no router changes. Cost: a small extra
  abstraction now, in exchange for not having to refactor the routing
  module a phase later.
- **Failover only happens before the first byte is written.** Non-streaming
  is trivially safe. For streaming (later phase), the loop only applies up
  to the first emitted chunk; after that, `stream-drop` is `retryable:
  false` and we surface a final SSE error event with `partial=true` rather
  than silently retry. Documented as a hard rule, not a default.
- **Budget is durable state in Postgres; rate-limit counters are runtime
  state in memory.** The two have different durability requirements: a
  rate-limit counter that resets on a process restart costs at most one
  minute of slightly looser limits, but spend that resets is a billing
  bug. So `usage_ledger` is the source of truth for spend (every read is
  `SUM(cost_usd) WHERE tenant_id=$1 AND created_at >= start_of_month`)
  while the per-tenant `TokenBucket` lives in process memory. Cost:
  Single-node only. Production swaps `InMemoryRateLimiter` for a Redis-
  backed implementation behind the same `RateLimiter` interface.
- **Post-call accounting (with a documented overspend race).** The chat
  handler reads spend, then calls the provider, then writes the ledger
  row. Under high concurrency for the same tenant, two requests can both
  observe `spend < budget` and both succeed — slightly overspending the
  cap. Acceptable for assignment scope; production fix is to atomically
  insert a "pending" reservation row with the estimated cost before the
  call, then reconcile to the actual cost after. The existing
  `usage_ledger` schema already supports compensating rows (it's
  append-only by design).
- **Tenant rate-limit *config* still comes from Postgres.** The limiter
  does not cache `tenants.rate_limit_per_minute`. Every call passes the
  current value in (lifted from `req.tenant`, set by the auth hook).
  Reconfiguring a tenant's cap takes effect on the very next request.
- **Resilience is a wrapper, not a framework.** Every `ProviderAdapter`
  is wrapped at registry build time with a `ResilientAdapter` that
  composes three controls: a timeout race (default 20s, expiry
  synthesizes `ProviderError(504, retryable=true)`), bounded retries
  on retryable errors only (200ms/500ms backoff with 30% jitter, 3
  attempts), and a per-provider `CircuitBreaker`. The wrapper
  implements the same `ProviderAdapter` interface as the inner
  adapter, so the registry, router, and chat handler stay
  unchanged. Cost: an extra await per call. Worth it.
- **Retries are bounded and classified at one level.** The single
  `defaultIsRetryable(err)` predicate is the only place "what counts as
  retryable?" is decided. `ProviderError.retryable` is the wire-level
  signal each adapter is responsible for setting honestly. 4xx
  validation/auth errors are explicitly never retried — retrying a
  malformed request just multiplies the user's bill.
- **Circuit breaker is per-provider.** The thing that goes down is the
  upstream, not (provider, model) or (tenant, provider). Tracking
  failures at any finer grain dilutes the signal and slows recovery.
  The breaker registry doubles as the `ProviderHealthOracle` Phase 4
  introduced — when a breaker is OPEN, the router skips the provider
  and the chat handler's failover loop rolls over to the next
  candidate. No special-case wiring.
- **Provider blast radius is bounded.** A provider going dark trips its
  own breaker only. Tenants whose model_class can be served by another
  provider keep getting answers (failover); tenants whose allowlist is
  one-provider-deep get a clean `503 no_provider_available` so they
  can decide what to do — instead of spending budget on retries that
  will never work. No tenant-vs-tenant impact: the breaker is keyed on
  provider name, the rate limiter is keyed on tenant_id, and the
  budget gate reads only that tenant's ledger rows.
- **Single-node breaker state — explicit production gap.** Each
  process owns its own `CircuitBreakerRegistry`. Two replicas can hold
  different views of the same upstream. Acceptable here because: each
  view is locally correct (a node only opens after *it* sees 5
  failures), recovery is independent (one node opening doesn't
  prevent another from probing), and the blast radius is bounded by
  per-node failover. Production fix is the same shape as for rate
  limiting: a Redis-backed shared breaker (state + opened_at +
  probe_lock) behind the same `ProviderHealthOracle` interface, with
  a `SET NX EX` for the HALF_OPEN probe lock so exactly one node
  probes at a time.
- **Streaming has no retries.** Per the assignment: once bytes are
  on the wire we never retry. `stream-drop` mock failures are
  hard-coded `retryable: false`, the resilient adapter never wraps a
  stream in a retry loop, and the breaker still records success/
  failure for the stream attempt as a whole. SSE end-to-end + the
  `partial=true` final event lands in a later phase.
- **Cache is a TTL cache, not a write-through cache or anything
  smarter.** A 5-minute TTL is the cheapest invalidation strategy
  that's defensible end-to-end: no fanout on writes, no event bus to
  invalidate by tenant or by model, no consistency story to debug.
  The cost is staleness — for up to `ttlMs` after a price change or
  a model upgrade, the gateway can keep serving the old answer.
  Acceptable for the assignment's deterministic-replay use case
  (same prompt / same tenant / same model_class within minutes); not
  acceptable for cases that need "the answer the model would give
  *right now*" (that's exactly why temperature > 0 opts out, and why
  we never cache streaming).
- **Tenant_id is in the cache key AND in the storage row.** Two
  layers of isolation: the SHA-256 hash makes a key collision
  across tenants cryptographically impossible; the composite UNIQUE
  index `(tenant_id, cache_key)` turns a "leak across tenants" bug
  into a Postgres constraint violation rather than a silent serve.
  Every read also filters by `tenant_id` explicitly. The repository
  test `does not return another tenant's row even with the same
  cache_key` documents this as a contract, not an accident.
- **Cache key uses the SELECTED provider/model, not the requested
  one.** The router can pick anthropic for a request that originally
  hit openai (because openai's breaker is OPEN). Caching under the
  routed (provider, model) prevents serving openai's old answer for
  an anthropic-routed request — the model would have produced
  different output. After a successful call we re-key on the
  provider that *actually* answered (which may differ from the
  selected one if the failover loop rolled over) so future identical
  requests routed the same way hit the cache.
- **Cache lookup happens AFTER rate limit + budget gates.** The
  assignment flow puts gates first, and there's a defensible reason:
  rate-limiting is a property of the *caller*, not the response, so
  a cache hit shouldn't let a tenant bypass it. Budget gating cached
  hits is more debatable — cached responses are free to serve — but
  staying inside the spec's flow keeps the contract obvious. On a
  cache hit we set `cost_usd: 0` and skip the `usage_ledger` write,
  so cached answers do not move the budget needle even though they
  pass the gate.
- **Cache invalidation tradeoff.** TTL is the only invalidation we
  have. There is no per-tenant flush, no per-model purge, no
  invalidate-on-price-change. Three concrete consequences this
  trades for simplicity:
    1. A pricing update in `provider_configs` doesn't invalidate
       cached responses; replays continue to report the cached
       (now stale) `usage` figures, but the cache hit reports
       `cost_usd: 0` so no over- or under-billing is possible.
    2. A `enabled = false` flip on a `provider_configs` row prevents
       the router from selecting that provider going forward, but
       cached responses for it remain valid for the rest of their
       TTL. This is intentional — a hit is only ever served after
       the router has independently picked the same provider/model
       on the current request, so a disabled provider just stops
       being picked and its cache rows time out naturally.
    3. There is no cleanup sweeper. Stale rows accumulate until
       the next request with a matching key replaces them. Storage
       is bounded by the working set (cardinality of distinct
       prompts × tenants × models), but production would add
       `DELETE FROM cache_entries WHERE expires_at < now()` on a
       cron and possibly a TTL extension.
- **Streaming has one rule and the rest follows from it: the first
  byte commits the response.** Before the first `token` event is
  written to the socket, the streaming handler is identical to the
  non-streaming failover loop — a retryable upstream error rolls
  over to the next candidate and the client never observes the
  failure. Once the first `token` is on the wire, the gateway has
  irrevocably told the client "the answer is coming from provider
  X". Retrying or failing over after that would mean the client
  receives output from two different providers concatenated as if
  it were one response, which is worse than any error we could
  send. So: emit one `error` event with `partial:true`, end the
  stream, log it, and stop. This rule lives in exactly one place
  (the `firstByteSent` flag in `streaming/handler.ts`); it is not
  a policy a future caller can override.
- **Streaming responses are NEVER cached.** The cache stores a
  fully assembled response; replaying it as SSE would mean
  re-chunking and re-emitting `done`, plus deciding what to do
  about partially cached rows. That is a separate piece of work,
  and the latency reason for streaming (tokens visible as they are
  generated) is destroyed if the whole response is shipped at once
  anyway. `isCacheable(body)` returns false for `stream:true`, and
  the streaming branch in `chat/routes.ts` short-circuits before
  the cache lookup runs at all.
- **Partial responses are billed.** The upstream did real token-
  generation work for every byte the client received. Walking away
  without writing a `usage_ledger` row would be the gateway eating
  the cost. The `partial_failed` path bills the tenant for the
  output tokens accumulated from streamed deltas (using the same
  `chars / 4` heuristic as estimate-time). The alternative — only
  billing on clean completion — would let any caller minimize
  spend by hanging up mid-stream, which is a predictable abuse
  vector worth designing out from day one.
- **`reply.hijack()` ordering is load-bearing.** Once Fastify
  hands us the raw socket, the route handler's return value no
  longer unblocks the response — `reply.raw.end()` does. So the
  streaming handler writes the terminal SSE event (`done` or
  `error`), then awaits all DB writes (`usage_ledger`,
  `request_logs`), and only then calls `reply.raw.end()`. End-
  then-write would race anyone (test or operator) querying the DB
  right after the response. The ordering is documented at the
  call site so the next maintainer doesn't innocently "tidy up"
  the flow and reintroduce the race.
- **Single `request_logs` row per streaming request.** Phase 8
  introduces durable per-request logging only for the streaming
  path. Non-streaming paths still log via Pino (the structured
  `chat completion ok` line is searchable in the JSON log
  pipeline). Full `request_logs` coverage for non-streaming
  arrives alongside the per-tenant Prometheus histograms — the
  same insertion API serves both, so shipping the API now and the
  writers later costs nothing.
- **One outcome recorder, two consumers.** Phase 9 lifts the
  request-logs / metrics / Pino bookkeeping out of every terminal
  in the chat handler and into a single function,
  `recordRequestOutcome(outcome)`. Both the streaming handler and
  the non-streaming handler call it. The contract: if there is a
  `request_logs` row, there is a Prometheus increment, and there
  is a structured Pino log line — and they all carry the same set
  of labels. Eliminates the failure mode where a 4xx terminal
  remembers to log but forgets to bump a counter (or vice versa).
- **Logs are the operational artefact; metrics are the
  dashboardable artefact; the ledger is the billable artefact.**
  Three different audiences, three different stores. An on-call
  engineer pulls structured logs by `request_id`. A platform
  engineer queries Prometheus for `gateway_errors_total` by
  `provider` to spot upstream issues. Finance reads
  `usage_ledger` (or the admin usage endpoint that aggregates it)
  for billing. Splitting them up front avoids the classic mistake
  of "let's just query the logs for billing" — which collapses
  the moment log volume forces sampling.
- **Prometheus label cardinality is a known cliff.** `tenant_id`
  appears as a label on five of the seven gateway metrics. With
  the seeded two tenants this is harmless. At fleet scale (1k+
  tenants × 2 providers × 5 models × N statuses) it explodes the
  registry. The two production fixes both work behind the same
  metrics shape: drop `tenant_id` from the labels (per-tenant
  breakdowns move to logs / OLAP), or aggressively bucket it
  (top-N tenants get their own series, the rest collapse to
  `tenant_id="other"`). Documented here, not implemented, because
  the assignment scope guarantees a tenant count where neither is
  needed.
- **Breaker state gauge is read at scrape time.** The
  `gateway_provider_circuit_state` gauge is registered with a
  `collect()` callback that snapshots the
  `CircuitBreakerRegistry` when Prometheus scrapes. No background
  poller, no race between writes (state transitions) and reads
  (scrapes), no risk of a stale gauge surviving a state change.
  Trade-off: the gauge value is "what the breaker said the last
  time someone scraped," not "right now" — but Prometheus's data
  model is scrape-based anyway, so this is the correct shape.
- **Admin endpoint protected by a single `ADMIN_TOKEN`, not full
  RBAC.** The assignment scope is "an evaluator answers 'how
  much has tenant_a spent this week?'" and that is exactly what
  `GET /admin/tenants/:tenantId/usage` does. Bearer
  authentication via `ADMIN_TOKEN` env var, no per-operator
  users, no audit log of who hit `/admin`, no rotation flow.
  Production gaps: one shared secret can't be revoked per
  operator; a leaked token plus a tight loop could DoS the
  `usage_ledger` table since `/admin` is not rate-limited; the
  `request_logs` row for an admin call only knows "admin", not
  which human. All of these would be solved together by an OIDC
  layer in front of the gateway.
- **Admin endpoint fails closed when unconfigured.**
  `ADMIN_TOKEN=""` (or unset) means the `/admin/*` plugin is not
  mounted at all. A misconfigured deploy returns 404, never 200,
  to anyone probing the path. The alternative — mounting with a
  blank token and rejecting all requests — leaks the existence of
  the endpoint and risks a future "if (token === '')" bug.
- **Half-open date range on the admin usage query.** `from` and
  `to` are inclusive day labels in the URL but the SQL filter is
  `created_at >= from AND created_at < to+1day`. This means
  `from=2026-05-10&to=2026-05-10` is "all of 2026-05-10 UTC,"
  which is what a human typing it expects. Standard library
  convention; the same shape is used everywhere date-range
  aggregation matters (Datadog, Stripe, etc.).
- **Real adapters fit behind the same `ProviderAdapter` interface
  as the mocks; no caller changes.** `OpenAIProvider` and
  `AnthropicProvider` implement `complete()` / `stream()` /
  `resolveDefaultModel()` exactly as the mocks do. The chat
  handler, the streaming handler, the routing module, the
  resilience wrapper, the cache, the request-log writer, and the
  Prometheus counters are byte-identical between mock and live
  modes. The factory swaps implementations behind a name lookup;
  nothing downstream knows the difference. This is the payoff
  for putting `ProviderAdapter` between the gateway and the
  upstream from Phase 3 — the real-adapter phase touches no
  module other than `providers/` and `app.ts`.
- **Mock mode is the default; live mode is per-provider opt-in
  with mock fallback.** `MOCK_PROVIDERS=true` (the default) wires
  both upstreams as in-process mocks. `MOCK_PROVIDERS=false`
  switches to real adapters per-provider: a missing key for one
  provider falls back to mock with a logged warning, the other
  provider is unaffected. Two consequences this trades for:
  (a) `npm test` cannot ever bill a real account by accident —
  the test suite uses mocks unconditionally and the new
  real-adapter tests inject a fake `fetch`; (b) a developer can
  iterate against one real upstream and one mock upstream
  without flipping a global switch. Cost: a fresh deploy of
  `MOCK_PROVIDERS=false` with both keys missing silently runs
  on mocks; the warnings in startup logs are the only signal,
  which is why we log them at WARN (not INFO) and surface the
  resolved (mock|real) per-provider in the "provider registry
  built" line.
- **Hand-rolled SSE parser, not a dependency.** `parseSseStream`
  is ~70 lines and handles exactly what both real upstreams
  produce: `data:` field, `event:` field, comments (`:` prefix),
  blank-line dispatch, `\r\n` line endings, chunk-boundary
  splitting, and EOF without a trailing blank line. Pulling
  `eventsource-parser` from npm would have added a dependency
  to audit, version-pin, and license-review for behaviour we
  could verify in a single test file. The cost of in-housing it:
  one more file to keep correct; the mitigation: 7 unit tests
  including the chunk-boundary case that would catch the
  classic regression.
- **Single error classifier shared by both real adapters.**
  `mapHttpStatusToProviderError` is the only place that decides
  "is this status retryable?" — used by OpenAI and Anthropic
  both, returns the existing `ProviderError` shape that the
  resilience layer / chat handler / circuit breaker already
  consume from the mocks. The classification matches the
  assignment spec literally: 4xx not retryable except 429 (which
  goes retryable, so the resilient wrapper retries-then-fails-
  over per the "may fallback" wording), 5xx retryable, transport
  failures and AbortError retryable. New providers added later
  reuse this classifier instead of inventing their own.
- **Token usage prefers upstream figures, falls back to the
  estimator.** OpenAI's `usage.prompt_tokens`/`completion_tokens`
  and Anthropic's `usage.input_tokens`/`output_tokens` (from
  `message_start` for input, `message_delta` for output) are
  used verbatim when present. When absent (rare, but possible
  during streaming if `stream_options.include_usage` is dropped
  by a proxy), we fall back to the existing chars/4 heuristic
  the rest of the gateway already uses. The fallback path is
  not a guess masquerading as truth — it's the same
  approximation the cost-routing math uses pre-call, so worst-
  case the billed cost matches what the router thought the
  request would cost.
- **Eval-only admin helpers are explicitly second-class.** Phase 11
  adds `POST /admin/mock-providers/:provider/failure-mode`,
  `POST /admin/tenants/:id/reset-usage`, and
  `POST /admin/tenants/:id/set-budget`. These exist because the
  evaluator's job is "spin it up locally, simulate provider
  failures, exhaust budget, watch it recover" — and the alternative
  (re-attaching `x-skyclad-fail` headers to every request, dropping
  into psql to wipe `usage_ledger`, waiting for monthly budget
  rollover) is friction that hides the architecture behind tooling
  the assignment isn't testing. They share the existing
  `ADMIN_TOKEN` Bearer hook, every response carries
  `x-skyclad-eval-only: true`, and the failure store is process-
  local memory that clears on restart by design — we never want a
  debug knob persisting through a deploy. None of this is
  production-shaped: real billing-affecting endpoints need
  per-operator identity (not a shared secret), an audit-log row per
  call, an approval workflow on `set-budget`, rate-limit on the
  admin surface itself, and almost always a separate segregated
  admin service. We make none of those investments here. The same
  failure-mode surface in production would instead be a
  feature-flag system — Statsig, LaunchDarkly, or a homebrew table
  — that drives a percentage rollout and emits an audit event per
  toggle.
- **Per-request `x-skyclad-fail` header still wins over the
  persistent store.** `MockProviderBase.resolveFailure` reads the
  header first and only falls back to the store if absent. This
  preserves the surgical, single-request failure injection the
  existing test suite relies on while the store handles the
  scenario walkthrough. They cost nothing to support together — one
  is "this single call fails", the other is "every call until I
  clear it" — and conflating them would have broken the existing
  failover tests which rely on `x-skyclad-fail-provider: openai`
  while leaving anthropic alone.
- **Admin plugin is wrapped in `app.register(...)` — encapsulation
  matters.** The Phase-9 code added the admin Bearer-token
  `onRequest` hook to the app instance directly. That happened to
  work because no test exercised both `/admin/*` and
  `/v1/chat/completions` in the same process. The Phase-11 tests
  do, and the hook would have rejected normal tenant chat traffic
  with 401. The fix is one line: wrap `registerAdminRoutes` in a
  `app.register(async (scope) => { ... })` so Fastify creates a
  child encapsulation context and the hook only runs on routes
  registered inside it. This is the pattern every Fastify plugin
  should use; this code base now does.

- **Streaming opts in to upstream usage, on purpose.** OpenAI
  doesn't include a usage block in streamed responses unless
  the request body sets `stream_options.include_usage: true`.
  Anthropic always includes it (in `message_start` /
  `message_delta`). We always opt in for OpenAI, because the
  alternative is estimating output tokens from the deltas we
  forwarded — which would re-open the abuse vector Phase 8's
  "bill what we sent" rule was designed to close, just from a
  slightly different angle. The cost is one extra field in the
  request body that adds nothing to the response from upstream's
  perspective.

## 4. Failure modes

_To be written._ Honest enumeration: provider slow-but-not-failing, DB
partitioned from app, oversized prompt, cache key race, partial stream
disconnect, breaker thrash. Each gets a paragraph on what actually happens.

## 5. What was not built

_To be written._ Distributed rate limiting, secrets manager integration,
per-key rotation UI, function calling / tool use, embeddings, image inputs,
multi-region, SLO/error-budget plumbing.

## 6. Production gap analysis

_To be written._ Top 5 gaps with rough cost estimates: secret management,
hardened auth (JWKS / mTLS option), deployment + rollout strategy, on-call
runbook + alerting, load testing.

## 7. Scaling story

_To be written._ Walk through 10 / 1k / 100k RPS. What breaks first
(in-memory token bucket → distributed limiter, sync request logs → buffered
batch insert / Kafka, single Postgres → read replicas / partitioning of
`request_logs`, GC pressure → worker threads or rewrite the hot path).
