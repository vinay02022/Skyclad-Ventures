import { ProviderError } from "./errors.js";
import {
  mapHttpStatusToProviderError,
  mapTransportErrorToProviderError,
} from "./http-errors.js";
import { parseSseStream } from "./sse-parser.js";
import { estimateMessagesTokens, estimateTextTokens } from "./tokens.js";
import type {
  ChatMessage,
  ModelClass,
  ProviderAdapter,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderHealth,
  ProviderStreamChunk,
} from "./types.js";

/**
 * Real OpenAI Chat Completions adapter.
 *
 * Stays inside the same `ProviderAdapter` contract as the mock — the
 * routing layer, resilience wrapper, cache, streaming handler, and
 * chat route handler don't know (and shouldn't know) that an HTTPS
 * request is happening behind this object. The only difference between
 * mock and live is the body of `complete()` / `stream()`.
 *
 * Provider-specific complexity isolated here:
 *   - Endpoint URL + auth header shape (Bearer token).
 *   - Request body shape (chat/completions schema).
 *   - Streaming option signaling: `stream: true` plus the
 *     `stream_options: { include_usage: true }` flag that asks OpenAI
 *     to send a final usage chunk (otherwise we'd have to estimate).
 *   - SSE wire format: one `data: {...}` JSON object per event,
 *     terminated by `data: [DONE]`. Parsed via the shared
 *     `parseSseStream` helper.
 *   - Error mapping: HTTP status -> ProviderError via the shared
 *     `mapHttpStatusToProviderError` (4xx not retryable except 429,
 *     5xx + transport retryable).
 *   - `failure` field on ProviderChatRequest is silently ignored —
 *     it's a mock-only knob.
 */
export interface OpenAIProviderOptions {
  apiKey: string;
  /** Override for tests. Defaults to https://api.openai.com */
  baseUrl?: string;
  /** Override for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.openai.com";

export class OpenAIProvider implements ProviderAdapter {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIProviderOptions) {
    if (!opts.apiKey) {
      // Constructor-level guard: the factory should never wire this
      // adapter without a key, but a misconfigured manual setup would
      // otherwise produce a confusing 401 from the upstream instead of
      // a clear startup error.
      throw new Error("OpenAIProvider requires apiKey");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  resolveDefaultModel(modelClass: ModelClass): string | null {
    // Same defaults as the mock so the router's model_class -> model
    // resolution is identical regardless of mode. Keeping these in sync
    // with the seeded provider_configs is a manual responsibility (one
    // canonical model per class per provider).
    switch (modelClass) {
      case "cheap":
        return "gpt-4o-mini";
      case "balanced":
        return "gpt-4o";
      // We don't seed an OpenAI premium row; null lets the router pick
      // anthropic's premium model instead of trying a non-existent one.
      case "premium":
        return null;
    }
  }

  async complete(req: ProviderChatRequest): Promise<ProviderChatResponse> {
    const body = this.buildRequestBody(req, false);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw mapTransportErrorToProviderError(err, this.name);
    }

    if (!res.ok) {
      // Read the error body best-effort. OpenAI returns a JSON
      // {"error":{"message":"...","type":"...","code":"..."}} envelope
      // on failures; a plain text fallback is still informative.
      const text = await safeReadText(res);
      throw mapHttpStatusToProviderError(res.status, this.name, extractErrorMessage(text));
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new ProviderError(`${this.name} returned non-JSON success body`, {
        statusCode: 502,
        retryable: true,
        providerName: this.name,
      });
    }

    return parseOpenAICompletion(parsed, req, this.name);
  }

  async *stream(req: ProviderChatRequest): AsyncIterable<ProviderStreamChunk> {
    const body = this.buildRequestBody(req, true);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw mapTransportErrorToProviderError(err, this.name);
    }

    if (!res.ok) {
      const text = await safeReadText(res);
      throw mapHttpStatusToProviderError(res.status, this.name, extractErrorMessage(text));
    }
    if (!res.body) {
      throw new ProviderError(`${this.name} streaming response had no body`, {
        statusCode: 502,
        retryable: true,
        providerName: this.name,
      });
    }

    let outputTokensEstimate = 0;
    let upstreamUsage: { input_tokens: number; output_tokens: number } | null = null;

    for await (const event of parseSseStream(res.body)) {
      if (event.data === "[DONE]") break;
      let chunk: unknown;
      try {
        chunk = JSON.parse(event.data);
      } catch {
        // Malformed line in the middle of a stream — skip rather than
        // tear down the whole response. The upstream is occasionally
        // chatty with keepalive comments that aren't strict JSON.
        continue;
      }
      const c = chunk as {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = c.choices?.[0]?.delta?.content;
      if (typeof content === "string" && content.length > 0) {
        outputTokensEstimate += estimateTextTokens(content);
        yield { type: "delta", content };
      }
      // Final usage chunk arrives because we set
      // stream_options.include_usage=true. It carries a `usage`
      // object and an empty choices array. We capture it but don't
      // emit `done` until the [DONE] sentinel (or stream end).
      if (c.usage) {
        upstreamUsage = {
          input_tokens: c.usage.prompt_tokens ?? 0,
          output_tokens: c.usage.completion_tokens ?? 0,
        };
      }
    }

    yield {
      type: "done",
      usage:
        upstreamUsage ?? {
          input_tokens: estimateMessagesTokens(req.messages),
          output_tokens: outputTokensEstimate,
        },
    };
  }

  estimateTokens(req: ProviderChatRequest): { input_tokens: number } {
    // The router needs a synchronous estimate (no network call) for
    // cost-based ranking. We use the same chars/4 heuristic as the
    // mock; the real usage figure replaces it after the call resolves.
    return { input_tokens: estimateMessagesTokens(req.messages) };
  }

  async health(): Promise<ProviderHealth> {
    // Cheap liveness signal: the router doesn't actually call this
    // (the circuit breaker is the authoritative health source), so
    // we deliberately don't burn an API quota probe here.
    return { healthy: true };
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private buildRequestBody(req: ProviderChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: req.temperature,
      max_tokens: req.max_tokens,
    };
    if (stream) {
      body.stream = true;
      // Without this, the streamed response carries no usage data and
      // we'd have to estimate output tokens for billing — which would
      // reopen the abuse vector that Phase 8's "bill what we sent"
      // rule was designed to close. include_usage is opt-in upstream;
      // we always opt in.
      body.stream_options = { include_usage: true };
    }
    return body;
  }
}

/**
 * Map an OpenAI chat/completions response (non-streaming) into our
 * normalized ProviderChatResponse. Defensive about missing fields:
 * OpenAI is unlikely to break the contract, but a partial response
 * from a proxy in the middle would otherwise crash with a confusing
 * "cannot read property of undefined" error. Mapping problems become
 * a single ProviderError that the chat handler already knows how to
 * surface.
 */
function parseOpenAICompletion(
  raw: unknown,
  req: ProviderChatRequest,
  providerName: string,
): ProviderChatResponse {
  const r = raw as {
    model?: string;
    choices?: Array<{ message?: { role?: string; content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = r.choices?.[0]?.message;
  const content = choice?.content;
  if (typeof content !== "string") {
    throw new ProviderError(`${providerName} response missing choices[0].message.content`, {
      statusCode: 502,
      retryable: true,
      providerName,
    });
  }
  const message: ChatMessage = {
    // Force "assistant" — OpenAI may return tool/system-shaped
    // messages in other modes that we don't support; for chat we
    // contractually return assistant.
    role: "assistant",
    content,
  };

  const usage = {
    input_tokens: r.usage?.prompt_tokens ?? estimateMessagesTokens(req.messages),
    output_tokens: r.usage?.completion_tokens ?? estimateTextTokens(content),
  };

  return {
    model: r.model ?? req.model,
    message,
    usage,
  };
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function extractErrorMessage(rawBody: string): string {
  if (!rawBody) return "<empty body>";
  // Best-effort: OpenAI errors are JSON-wrapped, but a 502 from a
  // proxy in front might be HTML. Try JSON, fall back to raw.
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // not JSON
  }
  // Cap the inline payload so an HTML error page doesn't blow up the
  // log line. The full body is still in upstream logs if needed.
  return rawBody.slice(0, 500);
}
