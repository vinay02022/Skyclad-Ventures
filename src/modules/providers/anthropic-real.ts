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
 * Real Anthropic Messages API adapter.
 *
 * Implements the same `ProviderAdapter` contract as the mock and
 * OpenAI adapters. Provider-specific quirks isolated here:
 *
 *   - Auth header: `x-api-key`, NOT `Authorization`.
 *   - Required `anthropic-version` header (we pin to 2023-06-01,
 *     the long-stable line).
 *   - System messages are NOT in `messages[]` — Anthropic takes
 *     them as a top-level `system` string. We extract every system
 *     message from our internal request, concatenate them with
 *     newlines, and hoist them out before serializing.
 *   - `max_tokens` is required (OpenAI treats it as optional).
 *   - SSE wire format uses NAMED events:
 *       message_start          carries input_tokens in usage
 *       content_block_delta    carries `delta.text` deltas
 *       message_delta          carries cumulative output_tokens
 *       message_stop           end of stream
 *     We only care about content_block_delta (for tokens) and
 *     message_delta (for final usage).
 *   - Response shape: `content: [{type:"text", text:"..."}]` array,
 *     not OpenAI's `choices[0].message.content`.
 */
export interface AnthropicProviderOptions {
  apiKey: string;
  /** Override for tests. Defaults to https://api.anthropic.com */
  baseUrl?: string;
  /** Override for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Pin a non-default Anthropic API version. Defaults to 2023-06-01. */
  anthropicVersion?: string;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_VERSION = "2023-06-01";

export class AnthropicProvider implements ProviderAdapter {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly anthropicVersion: string;

  constructor(opts: AnthropicProviderOptions) {
    if (!opts.apiKey) {
      throw new Error("AnthropicProvider requires apiKey");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.anthropicVersion = opts.anthropicVersion ?? DEFAULT_VERSION;
  }

  resolveDefaultModel(modelClass: ModelClass): string | null {
    // Same names as the seeded provider_configs rows.
    switch (modelClass) {
      case "cheap":
        return "claude-3-haiku-20240307";
      case "balanced":
        return "claude-3-5-sonnet-20241022";
      case "premium":
        return "claude-3-opus-20240229";
    }
  }

  async complete(req: ProviderChatRequest): Promise<ProviderChatResponse> {
    const body = this.buildRequestBody(req, false);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
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

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new ProviderError(`${this.name} returned non-JSON success body`, {
        statusCode: 502,
        retryable: true,
        providerName: this.name,
      });
    }

    return parseAnthropicCompletion(parsed, req, this.name);
  }

  async *stream(req: ProviderChatRequest): AsyncIterable<ProviderStreamChunk> {
    const body = this.buildRequestBody(req, true);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
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

    let inputTokens = estimateMessagesTokens(req.messages);
    let outputTokens = 0;

    for await (const event of parseSseStream(res.body)) {
      // Anthropic sends both an event name AND a JSON payload that
      // also carries `type`. We trust the event name for routing
      // since that's the documented contract.
      if (event.event === "message_start") {
        const data = safeParseJSON(event.data) as
          | { message?: { usage?: { input_tokens?: number; output_tokens?: number } } }
          | null;
        const upstream = data?.message?.usage?.input_tokens;
        if (typeof upstream === "number") inputTokens = upstream;
        continue;
      }
      if (event.event === "content_block_delta") {
        const data = safeParseJSON(event.data) as {
          delta?: { type?: string; text?: string };
        } | null;
        const text = data?.delta?.text;
        if (typeof text === "string" && text.length > 0) {
          outputTokens += estimateTextTokens(text);
          yield { type: "delta", content: text };
        }
        continue;
      }
      if (event.event === "message_delta") {
        // Anthropic sends cumulative output_tokens here. Trust the
        // upstream figure over our estimate.
        const data = safeParseJSON(event.data) as
          | { usage?: { output_tokens?: number } }
          | null;
        const upstream = data?.usage?.output_tokens;
        if (typeof upstream === "number") outputTokens = upstream;
        continue;
      }
      if (event.event === "message_stop") break;
      // ping / content_block_start / content_block_stop / unknown:
      // ignored. Anthropic regularly emits "ping" events for
      // keepalive; they carry no chat data.
    }

    yield {
      type: "done",
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }

  estimateTokens(req: ProviderChatRequest): { input_tokens: number } {
    return { input_tokens: estimateMessagesTokens(req.messages) };
  }

  async health(): Promise<ProviderHealth> {
    return { healthy: true };
  }

  private buildHeaders(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": this.anthropicVersion,
      "Content-Type": "application/json",
    };
  }

  private buildRequestBody(req: ProviderChatRequest, stream: boolean): Record<string, unknown> {
    const { systemText, nonSystemMessages } = hoistSystemMessages(req.messages);

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.max_tokens,
      temperature: req.temperature,
      messages: nonSystemMessages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (systemText) body.system = systemText;
    if (stream) body.stream = true;
    return body;
  }
}

/**
 * Anthropic does not accept `role: "system"` messages in the
 * `messages[]` array; the system prompt is a separate top-level
 * field. We support our internal contract (system is a role) by
 * hoisting every system message into one concatenated string. Order
 * preserved; multiple system messages are joined with a blank line so
 * downstream prompt-engineering still works.
 */
export function hoistSystemMessages(messages: ChatMessage[]): {
  systemText: string;
  nonSystemMessages: ChatMessage[];
} {
  const systemParts: string[] = [];
  const nonSystem: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else {
      nonSystem.push(m);
    }
  }
  return {
    systemText: systemParts.join("\n\n"),
    nonSystemMessages: nonSystem,
  };
}

function parseAnthropicCompletion(
  raw: unknown,
  req: ProviderChatRequest,
  providerName: string,
): ProviderChatResponse {
  const r = raw as {
    model?: string;
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  // Anthropic returns a content array; for chat we expect a single
  // text block. If the upstream returns multiple text blocks, we
  // concatenate them (covers the rare wrap-around case); other block
  // types (tool_use, etc.) we don't request and silently ignore.
  const textBlocks = (r.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!);
  if (textBlocks.length === 0) {
    throw new ProviderError(`${providerName} response had no text content blocks`, {
      statusCode: 502,
      retryable: true,
      providerName,
    });
  }
  const content = textBlocks.join("");

  const message: ChatMessage = { role: "assistant", content };
  const usage = {
    input_tokens: r.usage?.input_tokens ?? estimateMessagesTokens(req.messages),
    output_tokens: r.usage?.output_tokens ?? estimateTextTokens(content),
  };
  return {
    model: r.model ?? req.model,
    message,
    usage,
  };
}

function safeParseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
  try {
    // Anthropic errors:
    //   { "type": "error", "error": { "type": "invalid_request_error",
    //     "message": "..." } }
    const parsed = JSON.parse(rawBody) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // not JSON
  }
  return rawBody.slice(0, 500);
}
