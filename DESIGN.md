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

More decisions get added as cache, streaming, and observability land.

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
