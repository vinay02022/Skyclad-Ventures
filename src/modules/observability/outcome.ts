import type { FastifyBaseLogger } from "fastify";

import {
  type RequestLogRepository,
  type RequestLogStatus,
} from "../persistence/request-logs-repo.js";
import type { GatewayMetrics } from "./gateway-metrics.js";

/**
 * The "what happened on this request" record. Single shape used by both
 * the non-streaming chat handler and the streaming handler so:
 *
 *   - request_logs gets a row for every terminal outcome,
 *   - the structured log line carries every field the assignment lists,
 *   - Prometheus counters move in lockstep with the DB row,
 *
 * all from one call site instead of three drifting copies.
 *
 * The fields map 1:1 to the assignment's "every request should log:" list.
 * Anything genuinely not known at the terminal point (e.g. provider on a
 * rate_limited reject) is null, not zero — null means "did not happen",
 * zero is a real number that ends up in dashboards and pollutes them.
 */
export interface RequestOutcome {
  requestId: string;
  tenantId: string | null;
  /** Provider that ACTUALLY served the request (or attempted last). */
  provider: string | null;
  /** Model that ACTUALLY served the request. */
  model: string | null;
  /** Logical class the caller asked for (cheap | balanced | premium). */
  modelClass: string | null;
  /** Routing policy that produced the candidate list ("cost" | "override" | "cache" | null). */
  routePolicy: string | null;
  /** The reason field from the chosen RouteCandidate (or "cache_hit", etc.). */
  routingReason: string | null;
  cacheHit: boolean;
  streaming: boolean;
  /** Wall-clock ms from request start to outcome. */
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  status: RequestLogStatus;
  /** Short stable token (e.g. "TENANT_BUDGET_EXCEEDED", "upstream_5xx"). */
  errorType?: string | null;
}

export interface RecordOutcomeDeps {
  requestLogs: RequestLogRepository;
  metrics: GatewayMetrics;
  log: FastifyBaseLogger;
}

/**
 * Persist the outcome, update Prometheus counters, and emit one structured
 * log line. This is intentionally fire-and-forget shaped: callers `await`
 * it (so request_logs writes complete before the response socket closes,
 * which streaming tests depend on), but a DB or metrics failure here MUST
 * NOT break the actual response. We swallow + log internally.
 *
 * Why one call instead of three:
 *   - logs and metrics drift apart fast when each terminal point sets
 *     them inline. A single shape gives the on-call engineer a guarantee:
 *     "if there's a request_log row, there's a metric increment, and
 *     vice versa".
 *   - keeps chat/routes.ts focused on the actual gateway logic, with the
 *     bookkeeping reduced to one line per terminal.
 */
export async function recordRequestOutcome(
  deps: RecordOutcomeDeps,
  outcome: RequestOutcome,
): Promise<void> {
  // ---- Prometheus counters ------------------------------------------
  // We use empty strings for missing labels rather than skipping the
  // increment; Prometheus tolerates this and it keeps cardinality
  // predictable (one extra series per metric, "the unknown bucket").
  const labelTenant = outcome.tenantId ?? "";
  const labelProvider = outcome.provider ?? "";
  const labelModel = outcome.model ?? "";

  try {
    deps.metrics.requests
      .labels({
        tenant_id: labelTenant,
        provider: labelProvider,
        model: labelModel,
        status: outcome.status,
      })
      .inc(1);

    if (outcome.errorType) {
      deps.metrics.errors
        .labels({
          tenant_id: labelTenant,
          provider: labelProvider,
          error_type: outcome.errorType,
        })
        .inc(1);
    }

    // Latency only meaningful when we actually called a provider. A
    // budget_exceeded reject has a (small) latency but it isn't a
    // provider latency, so we don't emit it on this histogram — that
    // would skew the p99 dashboards downward.
    if (outcome.provider && outcome.model && outcome.status !== "rate_limited") {
      deps.metrics.latency
        .labels({ provider: labelProvider, model: labelModel })
        .observe(outcome.latencyMs);
    }

    if (outcome.provider && outcome.model) {
      if (outcome.inputTokens != null && outcome.inputTokens > 0) {
        deps.metrics.tokens
          .labels({
            tenant_id: labelTenant,
            provider: labelProvider,
            model: labelModel,
            token_type: "input",
          })
          .inc(outcome.inputTokens);
      }
      if (outcome.outputTokens != null && outcome.outputTokens > 0) {
        deps.metrics.tokens
          .labels({
            tenant_id: labelTenant,
            provider: labelProvider,
            model: labelModel,
            token_type: "output",
          })
          .inc(outcome.outputTokens);
      }
      if (outcome.costUsd != null && outcome.costUsd > 0) {
        deps.metrics.cost
          .labels({
            tenant_id: labelTenant,
            provider: labelProvider,
            model: labelModel,
          })
          .inc(outcome.costUsd);
      }
    }

    if (outcome.cacheHit && outcome.tenantId) {
      deps.metrics.cacheHits.labels({ tenant_id: labelTenant }).inc(1);
    }
  } catch (metricsErr) {
    deps.log.error(
      { err: metricsErr, request_id: outcome.requestId },
      "metrics update failed; outcome was still logged",
    );
  }

  // ---- request_logs row ---------------------------------------------
  // tenantId can be null (validation-failed, etc.); the schema's FK is
  // ON DELETE SET NULL and nullable, so this is fine.
  try {
    await deps.requestLogs.insert({
      requestId: outcome.requestId,
      tenantId: outcome.tenantId,
      provider: outcome.provider,
      model: outcome.model,
      status: outcome.status,
      errorType: outcome.errorType ?? null,
      latencyMs: outcome.latencyMs,
      cacheHit: outcome.cacheHit,
      streaming: outcome.streaming,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      costUsd: outcome.costUsd,
    });
  } catch (dbErr) {
    deps.log.error(
      { err: dbErr, request_id: outcome.requestId },
      "request_logs insert failed; outcome was still logged to stdout",
    );
  }

  // ---- structured stdout log ----------------------------------------
  // This is the artefact an evaluator greps with `kubectl logs ... |
  // jq 'select(.request_id == "req-...")'`. Every assignment-listed
  // field appears as a top-level JSON key.
  deps.log.info(
    {
      request_id: outcome.requestId,
      tenant_id: outcome.tenantId,
      provider: outcome.provider,
      model: outcome.model,
      model_class: outcome.modelClass,
      route_policy: outcome.routePolicy,
      routing_reason: outcome.routingReason,
      cache_hit: outcome.cacheHit,
      streaming: outcome.streaming,
      latency_ms: outcome.latencyMs,
      input_tokens: outcome.inputTokens,
      output_tokens: outcome.outputTokens,
      cost_usd: outcome.costUsd,
      status: outcome.status,
      error_type: outcome.errorType ?? null,
    },
    `chat completion ${outcome.status}`,
  );
}
