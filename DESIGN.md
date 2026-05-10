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

More decisions get added as adapters, routing, cache, and streaming land.

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
