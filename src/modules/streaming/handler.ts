import type { FastifyReply, FastifyRequest } from "fastify";

import type { UsageLedgerRepository } from "../budget/repository.js";
import type { GatewayMetrics } from "../observability/gateway-metrics.js";
import { recordRequestOutcome } from "../observability/outcome.js";
import type {
  RequestLogRepository,
  RequestLogStatus,
} from "../persistence/request-logs-repo.js";
import { ProviderError } from "../providers/errors.js";
import { parseFailureInjection } from "../providers/failure-injection.js";
import { calculateCost, type PricingRepository } from "../providers/pricing.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { estimateMessagesTokens, estimateTextTokens } from "../providers/tokens.js";
import type {
  ChatMessage,
  ModelClass,
  ProviderChatRequest,
} from "../providers/types.js";
import type { RouteCandidate } from "../routing/types.js";
import { formatSSEEvent } from "./sse.js";

export interface StreamHandlerDeps {
  providers: ProviderRegistry;
  pricing: PricingRepository;
  usageLedger: UsageLedgerRepository;
  requestLogs: RequestLogRepository;
  metrics: GatewayMetrics;
}

export interface StreamHandlerInput {
  tenantId: string;
  modelClass: ModelClass;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  routePolicyName: string;
  candidatesConsidered: number;
  /** Failover-ordered candidates: [selected, ...fallbacks]. */
  order: RouteCandidate[];
}

/**
 * Streaming chat completion over SSE.
 *
 * Failover model:
 *   - Before any byte is on the wire: we may try the next candidate on a
 *     retryable upstream error. This is safe because the client has not
 *     yet observed any partial state.
 *   - After the first delta has been written to the socket: NEVER retry
 *     and NEVER fall over. Emit a single "error" event with
 *     partial:true, end the stream cleanly, write what we know to
 *     usage_ledger and request_logs.
 *
 * Cache: streaming requests bypass the cache entirely. The cache stores
 * a fully assembled response and would need to be re-chunked + re-emitted
 * with synthetic "done"; not in scope and not interesting.
 *
 * Retry note: ResilientAdapter.stream does NOT retry inside one stream
 * attempt either (Phase 6 contract). So a single iteration of this loop
 * makes exactly one upstream attempt against one (provider, model);
 * failover across providers is this function's job.
 */
export async function streamChatCompletion(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: StreamHandlerDeps,
  input: StreamHandlerInput,
): Promise<void> {
  // Hijack the reply early. Fastify will not try to send anything else
  // on this socket; we own writes to reply.raw from here on.
  reply.hijack();
  reply.raw.statusCode = 200;
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  // Disable proxy buffering (nginx, etc.). Without this an upstream
  // proxy may hold every event until it has "enough" bytes to flush,
  // which defeats the latency reason for streaming in the first place.
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.setHeader("x-request-id", req.id);
  reply.raw.flushHeaders();

  const failure = parseFailureInjection(req.headers);
  const start = Date.now();
  // Estimate input tokens once up front; mock providers report the same
  // estimate at "done", so we replace it then if available.
  let inputTokens = estimateMessagesTokens(input.messages);
  let outputTokens = 0;
  let firstByteSent = false;
  let chosenProvider: string | null = null;
  let chosenModel: string | null = null;
  const errors: { provider: string; status: number; message: string }[] = [];

  for (let attempt = 0; attempt < input.order.length; attempt++) {
    const candidate = input.order[attempt]!;
    const adapter = deps.providers.get(candidate.provider);
    if (!adapter) {
      // Defensive — the policy already filters this; the override path
      // is the only realistic source of a missing adapter and override
      // never streams (we don't expose a streaming-with-override flow).
      errors.push({
        provider: candidate.provider,
        status: 500,
        message: "no_adapter_registered",
      });
      continue;
    }

    const providerReq: ProviderChatRequest = {
      model: candidate.model,
      messages: input.messages,
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      ...(failure ? { failure } : {}),
    };

    try {
      // Iterate the upstream stream. The breaker accounting and the
      // (per-stream) lack of retries are owned by ResilientAdapter.
      for await (const chunk of adapter.stream(providerReq)) {
        if (chunk.type === "delta") {
          if (!firstByteSent) {
            firstByteSent = true;
            chosenProvider = adapter.name;
            chosenModel = candidate.model;
          }
          outputTokens += estimateTextTokens(chunk.content);
          reply.raw.write(formatSSEEvent({ type: "token", content: chunk.content }));
          continue;
        }
        // chunk.type === "done"
        if (!firstByteSent) {
          // Provider produced zero deltas then a clean done. Treat as a
          // committed (but empty) success.
          chosenProvider = adapter.name;
          chosenModel = candidate.model;
          firstByteSent = true;
        }
        // Replace our running estimate with the upstream-reported figures.
        inputTokens = chunk.usage.input_tokens;
        outputTokens = chunk.usage.output_tokens;

        reply.raw.write(formatSSEEvent({ type: "done" }));
        await terminate(reply, {
          req,
          deps,
          input,
          status: "success",
          provider: adapter.name,
          model: candidate.model,
          routingReason: candidate.reason,
          inputTokens,
          outputTokens,
          startedAt: start,
          attempts: attempt + 1,
          fallbackUsed: attempt > 0,
        });
        return;
      }

      // Iterable ended without yielding "done". Treat as a clean end —
      // we've got whatever output_tokens we accumulated, no error.
      reply.raw.write(formatSSEEvent({ type: "done" }));
      await terminate(reply, {
        req,
        deps,
        input,
        status: "success",
        provider: adapter.name,
        model: candidate.model,
        routingReason: candidate.reason,
        inputTokens,
        outputTokens,
        startedAt: start,
        attempts: attempt + 1,
        fallbackUsed: attempt > 0,
      });
      return;
    } catch (err) {
      const providerErr = err instanceof ProviderError ? err : null;
      const statusCode = providerErr?.statusCode ?? 500;
      const message = providerErr?.message ?? (err instanceof Error ? err.message : String(err));

      errors.push({ provider: adapter.name, status: statusCode, message });

      // Critical fork: did any byte already reach the client?
      if (firstByteSent) {
        // YES — we are committed to this provider. Send the partial
        // error event, end the stream cleanly, write whatever usage
        // we have. NEVER retry, NEVER fall over.
        req.log.warn(
          {
            tenant_id: input.tenantId,
            provider: adapter.name,
            model: candidate.model,
            output_tokens: outputTokens,
            status_code: statusCode,
            err: message,
          },
          "stream dropped after partial response; emitting partial error event",
        );
        reply.raw.write(
          formatSSEEvent({
            type: "error",
            message: "upstream connection dropped after partial response",
            partial: true,
          }),
        );
        await terminate(reply, {
          req,
          deps,
          input,
          status: "partial_failed",
          provider: adapter.name,
          model: candidate.model,
          routingReason: candidate.reason,
          inputTokens,
          outputTokens,
          startedAt: start,
          attempts: attempt + 1,
          fallbackUsed: attempt > 0,
          errorType: providerErr?.message ?? "stream_dropped",
        });
        return;
      }

      // No byte sent yet. We may roll over to the next candidate IF the
      // error is retryable AND the candidate exists.
      if (providerErr && !providerErr.retryable) {
        req.log.warn(
          {
            tenant_id: input.tenantId,
            provider: adapter.name,
            model: candidate.model,
            status_code: statusCode,
          },
          "stream non-retryable upstream error before first byte, no failover",
        );
        reply.raw.write(
          formatSSEEvent({
            type: "error",
            message,
            partial: false,
          }),
        );
        await terminate(reply, {
          req,
          deps,
          input,
          status: "upstream_failed",
          provider: adapter.name,
          model: candidate.model,
          routingReason: candidate.reason,
          inputTokens,
          outputTokens: 0,
          startedAt: start,
          attempts: attempt + 1,
          fallbackUsed: attempt > 0,
          errorType: providerErr.message,
        });
        return;
      }

      if (attempt < input.order.length - 1) {
        req.log.warn(
          {
            tenant_id: input.tenantId,
            provider: adapter.name,
            model: candidate.model,
            attempt: attempt + 1,
            next_provider: input.order[attempt + 1]?.provider,
            status_code: statusCode,
          },
          "stream upstream failed before first byte, attempting failover",
        );
        continue;
      }
      // Fall through: last candidate failed before any byte.
    }
  }

  // Walked the whole list, every candidate failed before first byte.
  req.log.error(
    {
      tenant_id: input.tenantId,
      attempts: input.order.length,
      errors,
    },
    "stream: all providers failed before first byte",
  );
  reply.raw.write(
    formatSSEEvent({
      type: "error",
      message: `All ${input.order.length} eligible provider(s) failed before any token was sent.`,
      partial: false,
    }),
  );
  await terminate(reply, {
    req,
    deps,
    input,
    status: "all_providers_failed",
    provider: null,
    model: null,
    routingReason: null,
    inputTokens,
    outputTokens: 0,
    startedAt: start,
    attempts: input.order.length,
    fallbackUsed: input.order.length > 1,
    errorType: "all_providers_failed",
  });
}

// ---------------------------------------------------------------------------
// terminate(): write usage_ledger + request_logs + the structured success/
// failure log line, THEN close the socket. Called from every terminal
// branch above so the bookkeeping is identical regardless of which path
// got us here.
//
// Ordering is load-bearing: we must finish all DB writes BEFORE
// reply.raw.end(), because Fastify's inject() resolves on socket close
// (we hijacked the response, so the route handler's return is not what
// unblocks the test). End-then-write would race the test.
// ---------------------------------------------------------------------------
interface TerminateInput {
  req: FastifyRequest;
  deps: StreamHandlerDeps;
  input: StreamHandlerInput;
  status: RequestLogStatus;
  provider: string | null;
  model: string | null;
  /** RouteCandidate.reason for the candidate that was tried last. */
  routingReason: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  attempts: number;
  fallbackUsed: boolean;
  errorType?: string;
}

/**
 * One terminal point per stream. Writes (in order):
 *   1. usage_ledger row when we actually billed the tenant,
 *   2. request_logs row + Prometheus counters + structured log line
 *      (all via recordRequestOutcome so streaming and non-streaming
 *      stay symmetric),
 *   3. reply.raw.end() to release the socket.
 *
 * Ordering is load-bearing: Fastify's inject() resolves on socket close,
 * so the writes have to be awaited BEFORE end(), or the test sees the
 * response before request_logs is durable.
 */
async function terminate(reply: FastifyReply, args: TerminateInput): Promise<void> {
  const latencyMs = Date.now() - args.startedAt;
  let costUsd = 0;

  // Cost is only meaningful when a provider/model is identified AND we
  // have output_tokens to charge for. all_providers_failed leaves both
  // null, so cost stays 0.
  if (args.provider && args.model && (args.inputTokens > 0 || args.outputTokens > 0)) {
    const price = await args.deps.pricing.getPrice(args.provider, args.model);
    if (price) {
      costUsd = calculateCost(price, {
        input_tokens: args.inputTokens,
        output_tokens: args.outputTokens,
      });
    }
  }

  // Ledger write: success AND partial both bill the tenant. Spec says
  // partial responses still record whatever usage is known; the
  // assignment treats this as honest accounting (the upstream did real
  // work that the gateway has to pay for). upstream_failed and
  // all_providers_failed (no byte sent) skip the ledger entirely.
  if (
    args.provider &&
    args.model &&
    (args.status === "success" || args.status === "partial_failed")
  ) {
    try {
      await args.deps.usageLedger.recordUsage({
        tenantId: args.input.tenantId,
        provider: args.provider,
        model: args.model,
        requestId: args.req.id,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        costUsd,
      });
    } catch (err) {
      args.req.log.error(
        { err, tenant_id: args.input.tenantId, request_id: args.req.id },
        "stream: usage_ledger write failed",
      );
    }
  }

  await recordRequestOutcome(
    {
      requestLogs: args.deps.requestLogs,
      metrics: args.deps.metrics,
      log: args.req.log,
    },
    {
      requestId: args.req.id,
      tenantId: args.input.tenantId,
      provider: args.provider,
      model: args.model,
      modelClass: args.input.modelClass,
      routePolicy: args.input.routePolicyName,
      routingReason: args.routingReason,
      cacheHit: false,
      streaming: true,
      latencyMs,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      costUsd: args.provider ? costUsd : null,
      status: args.status,
      errorType: args.errorType ?? null,
    },
  );

  // Close the socket only AFTER the bookkeeping is durable. See note above.
  reply.raw.end();
}
