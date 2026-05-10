import type { Database } from "../../../db/client.js";
import { requestLogs } from "../../../db/schema.js";

/**
 * Status enum kept narrow on purpose. Each value is something an
 * on-call engineer can sort on and immediately understand:
 *
 *   - success                 the upstream answered cleanly (or cache hit)
 *   - partial_failed          tokens reached the client, then upstream dropped
 *   - upstream_failed         the chosen provider failed (non-retryable, or
 *                             override path) before any token went out
 *   - all_providers_failed    every candidate failed retryably; failover
 *                             exhausted
 *   - rate_limited            tenant exceeded its per-minute bucket
 *   - budget_exceeded         tenant exceeded its monthly USD budget
 *   - invalid_request         body failed schema validation
 *   - no_provider_available   router found zero eligible candidates
 *                             (allowlist + breaker + enabled)
 *
 * Phase 8 only wrote streaming outcomes. Phase 9 widens this to every
 * terminal in the chat handler so an evaluator can SELECT * FROM
 * request_logs WHERE request_id = '...' and reconstruct what happened.
 */
export type RequestLogStatus =
  | "success"
  | "partial_failed"
  | "upstream_failed"
  | "all_providers_failed"
  | "rate_limited"
  | "budget_exceeded"
  | "invalid_request"
  | "no_provider_available";

export interface RequestLogEntry {
  requestId: string;
  tenantId: string | null;
  provider: string | null;
  model: string | null;
  status: RequestLogStatus;
  errorType?: string | null;
  latencyMs: number;
  cacheHit: boolean;
  streaming: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

/**
 * Owns inserts into request_logs. Reads are deferred to a future
 * GET /v1/usage endpoint; for Phase 8 the table is write-only and
 * is the artefact an evaluator (or an on-call engineer) consults
 * when they want to know "what happened on req-...".
 */
export class RequestLogRepository {
  constructor(private readonly db: Database) {}

  async insert(entry: RequestLogEntry): Promise<void> {
    await this.db.insert(requestLogs).values({
      requestId: entry.requestId,
      tenantId: entry.tenantId,
      provider: entry.provider,
      model: entry.model,
      status: entry.status,
      errorType: entry.errorType ?? null,
      latencyMs: entry.latencyMs,
      cacheHit: entry.cacheHit,
      streaming: entry.streaming,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      // numeric column accepts a string; mirrors UsageLedgerRepository.
      costUsd: entry.costUsd != null ? entry.costUsd.toFixed(6) : null,
    });
  }
}
