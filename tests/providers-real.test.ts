import { describe, expect, it, vi } from "vitest";

import { AnthropicProvider, hoistSystemMessages } from "../src/modules/providers/anthropic-real.js";
import { ProviderError } from "../src/modules/providers/errors.js";
import {
  mapHttpStatusToProviderError,
  mapTransportErrorToProviderError,
} from "../src/modules/providers/http-errors.js";
import { OpenAIProvider } from "../src/modules/providers/openai-real.js";
import { parseSseStream } from "../src/modules/providers/sse-parser.js";
import type { ProviderChatRequest } from "../src/modules/providers/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
//
// All tests in this file build their own ReadableStream<Uint8Array> and
// inject it via a fake `fetch` implementation. No real network call is made,
// no API key is needed, and the suite stays runnable with zero credits.
//
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(...chunks: string[]): Response {
  return new Response(streamOf(...chunks), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const baseReq: ProviderChatRequest = {
  model: "ignored-overridden-per-test",
  messages: [{ role: "user", content: "hello" }],
  temperature: 0,
  max_tokens: 64,
};

// ===========================================================================
// SSE parser
// ===========================================================================
describe("parseSseStream", () => {
  it("yields one event per blank-line-separated block", async () => {
    const stream = streamOf("data: hello\n\n", "data: world\n\n");
    const events = [];
    for await (const e of parseSseStream(stream)) events.push(e);
    expect(events).toEqual([{ data: "hello" }, { data: "world" }]);
  });

  it("captures the event name when set", async () => {
    const stream = streamOf("event: message_delta\ndata: {}\n\n");
    const events = [];
    for await (const e of parseSseStream(stream)) events.push(e);
    expect(events[0]).toEqual({ event: "message_delta", data: "{}" });
  });

  it("joins multiple data: lines with newlines (per SSE spec)", async () => {
    const stream = streamOf("data: line1\ndata: line2\n\n");
    const events = [];
    for await (const e of parseSseStream(stream)) events.push(e);
    expect(events[0]?.data).toBe("line1\nline2");
  });

  it("ignores comment lines (`:` prefix) and unknown fields", async () => {
    const stream = streamOf(": keepalive\nid: 1\ndata: payload\n\n");
    const events = [];
    for await (const e of parseSseStream(stream)) events.push(e);
    expect(events).toEqual([{ data: "payload" }]);
  });

  it("handles \\r\\n line endings the same as \\n", async () => {
    const stream = streamOf("data: a\r\n\r\ndata: b\r\n\r\n");
    const events = [];
    for await (const e of parseSseStream(stream)) events.push(e);
    expect(events.map((e) => e.data)).toEqual(["a", "b"]);
  });

  it("handles a chunk boundary mid-line (decoder + buffer correctness)", async () => {
    // Splits "data: hello\n\n" across two chunks at the `l|lo` boundary.
    const stream = streamOf("data: hel", "lo\n\n");
    const events = [];
    for await (const e of parseSseStream(stream)) events.push(e);
    expect(events).toEqual([{ data: "hello" }]);
  });

  it("flushes a pending event at EOF if upstream omits the trailing blank line", async () => {
    const stream = streamOf("data: tail-event");
    const events = [];
    for await (const e of parseSseStream(stream)) events.push(e);
    expect(events).toEqual([{ data: "tail-event" }]);
  });
});

// ===========================================================================
// Error mapping
// ===========================================================================
describe("mapHttpStatusToProviderError", () => {
  it("maps 400 to non-retryable client error", () => {
    const err = mapHttpStatusToProviderError(400, "openai", "bad model");
    expect(err.statusCode).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.providerName).toBe("openai");
  });

  it("maps 401/403/404 to non-retryable", () => {
    for (const s of [401, 403, 404, 422]) {
      const err = mapHttpStatusToProviderError(s, "openai", "x");
      expect(err.retryable).toBe(false);
      expect(err.statusCode).toBe(s);
    }
  });

  it("maps 429 to retryable (so failover gets a chance after retries)", () => {
    const err = mapHttpStatusToProviderError(429, "anthropic", "rate");
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
  });

  it("maps 5xx to retryable", () => {
    for (const s of [500, 502, 503, 504, 599]) {
      const err = mapHttpStatusToProviderError(s, "openai", "boom");
      expect(err.retryable).toBe(true);
      expect(err.statusCode).toBe(s);
    }
  });
});

describe("mapTransportErrorToProviderError", () => {
  it("maps an AbortError to a retryable 504", () => {
    const ae = new Error("The operation was aborted");
    ae.name = "AbortError";
    const err = mapTransportErrorToProviderError(ae, "openai");
    expect(err.statusCode).toBe(504);
    expect(err.retryable).toBe(true);
  });

  it("maps a generic transport failure to a retryable 503", () => {
    const err = mapTransportErrorToProviderError(new Error("ECONNRESET"), "anthropic");
    expect(err.statusCode).toBe(503);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("ECONNRESET");
  });
});

// ===========================================================================
// OpenAI adapter
// ===========================================================================
describe("OpenAIProvider", () => {
  it("rejects construction without an API key", () => {
    expect(() => new OpenAIProvider({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("resolveDefaultModel matches the seeded provider_configs rows", () => {
    const p = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: vi.fn() });
    expect(p.resolveDefaultModel("cheap")).toBe("gpt-4o-mini");
    expect(p.resolveDefaultModel("balanced")).toBe("gpt-4o");
    // OpenAI deliberately has no premium row.
    expect(p.resolveDefaultModel("premium")).toBeNull();
  });

  it("complete() sends the right URL/headers/body and parses the response", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: "gpt-4o-mini-2024-07-18",
        choices: [{ message: { role: "assistant", content: "hi from openai" } }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }),
    );
    const p = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: fetchSpy });
    const res = await p.complete({ ...baseReq, model: "gpt-4o-mini" });

    // Outbound request
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(64);
    expect(body.stream).toBeUndefined();

    // Normalized response
    expect(res.message).toEqual({ role: "assistant", content: "hi from openai" });
    expect(res.usage.input_tokens).toBe(5);
    expect(res.usage.output_tokens).toBe(4);
    expect(res.model).toBe("gpt-4o-mini-2024-07-18");
  });

  it("complete() falls back to the chars/4 estimator when usage is missing", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: "gpt-4o-mini",
        choices: [{ message: { role: "assistant", content: "abcd" } }],
        // no usage field
      }),
    );
    const p = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: fetchSpy });
    const res = await p.complete({ ...baseReq, model: "gpt-4o-mini" });
    expect(res.usage.output_tokens).toBeGreaterThan(0);
  });

  it("complete() maps a 429 response to a retryable ProviderError", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(429, { error: { message: "rate limited", type: "rate_limit_error" } }),
    );
    const p = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: fetchSpy });
    await expect(p.complete({ ...baseReq, model: "gpt-4o-mini" })).rejects.toMatchObject({
      name: "ProviderError",
      statusCode: 429,
      retryable: true,
      providerName: "openai",
    });
  });

  it("complete() maps a 401 response to a non-retryable ProviderError", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: { message: "invalid api key" } }),
    );
    const p = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: fetchSpy });
    await expect(p.complete({ ...baseReq, model: "gpt-4o-mini" })).rejects.toMatchObject({
      statusCode: 401,
      retryable: false,
    });
  });

  it("complete() maps a 500 response to a retryable ProviderError", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(500, { error: { message: "internal" } }),
    );
    const p = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: fetchSpy });
    await expect(p.complete({ ...baseReq, model: "gpt-4o-mini" })).rejects.toMatchObject({
      statusCode: 500,
      retryable: true,
    });
  });

  it("complete() maps a fetch transport throw to a retryable 503", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const p = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: fetchSpy });
    await expect(p.complete({ ...baseReq, model: "gpt-4o-mini" })).rejects.toMatchObject({
      statusCode: 503,
      retryable: true,
    });
  });

  it("stream() opts in to upstream usage and yields delta + done events", async () => {
    // Two delta chunks then a final usage chunk then [DONE].
    const sse =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo!"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
      "data: [DONE]\n\n";
    const fetchSpy = vi.fn().mockResolvedValue(sseResponse(sse));
    const p = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: fetchSpy });

    const events = [];
    for await (const ev of p.stream({ ...baseReq, model: "gpt-4o-mini" })) {
      events.push(ev);
    }

    // Verify the streaming-specific bits of the request body
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });

    // Verify deltas and the final done event
    expect(events[0]).toEqual({ type: "delta", content: "Hel" });
    expect(events[1]).toEqual({ type: "delta", content: "lo!" });
    expect(events[2]).toEqual({
      type: "done",
      usage: { input_tokens: 5, output_tokens: 2 },
    });
  });

  it("stream() throws a retryable error when the upstream returns 5xx before any byte", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(503, { error: { message: "down" } }));
    const p = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: fetchSpy });
    const iter = p.stream({ ...baseReq, model: "gpt-4o-mini" })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toMatchObject({
      statusCode: 503,
      retryable: true,
      providerName: "openai",
    });
  });
});

// ===========================================================================
// Anthropic adapter
// ===========================================================================
describe("AnthropicProvider", () => {
  it("rejects construction without an API key", () => {
    expect(() => new AnthropicProvider({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("resolveDefaultModel matches the seeded provider_configs rows", () => {
    const p = new AnthropicProvider({ apiKey: "k", fetchImpl: vi.fn() });
    expect(p.resolveDefaultModel("cheap")).toBe("claude-3-haiku-20240307");
    expect(p.resolveDefaultModel("balanced")).toBe("claude-3-5-sonnet-20241022");
    expect(p.resolveDefaultModel("premium")).toBe("claude-3-opus-20240229");
  });

  it("hoistSystemMessages extracts system content from the messages list", () => {
    const { systemText, nonSystemMessages } = hoistSystemMessages([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "system", content: "use markdown" },
      { role: "assistant", content: "ok" },
    ]);
    expect(systemText).toBe("be terse\n\nuse markdown");
    expect(nonSystemMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("complete() sends the right URL/headers/body, hoists system, and parses the response", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: "claude-3-haiku-20240307",
        content: [{ type: "text", text: "hello from claude" }],
        usage: { input_tokens: 7, output_tokens: 6 },
      }),
    );
    const p = new AnthropicProvider({ apiKey: "ant-test", fetchImpl: fetchSpy });
    const res = await p.complete({
      ...baseReq,
      model: "claude-3-haiku-20240307",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "say hi" },
      ],
    });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("ant-test");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-3-haiku-20240307");
    expect(body.max_tokens).toBe(64);
    expect(body.system).toBe("be terse");
    // messages[] no longer contains the system message
    expect(body.messages).toEqual([{ role: "user", content: "say hi" }]);

    expect(res.message.content).toBe("hello from claude");
    expect(res.usage).toEqual({ input_tokens: 7, output_tokens: 6 });
  });

  it("complete() concatenates multiple text content blocks", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: "claude-3-haiku-20240307",
        content: [
          { type: "text", text: "Part A. " },
          { type: "text", text: "Part B." },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    );
    const p = new AnthropicProvider({ apiKey: "k", fetchImpl: fetchSpy });
    const res = await p.complete({ ...baseReq, model: "claude-3-haiku-20240307" });
    expect(res.message.content).toBe("Part A. Part B.");
  });

  it("complete() error mapping mirrors OpenAI: 429 retryable, 4xx not, 5xx retryable", async () => {
    const cases = [
      { status: 429, retryable: true },
      { status: 400, retryable: false },
      { status: 401, retryable: false },
      { status: 503, retryable: true },
    ];
    for (const c of cases) {
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse(c.status, { error: { message: "x" } }),
      );
      const p = new AnthropicProvider({ apiKey: "k", fetchImpl: fetchSpy });
      const err = await p
        .complete({ ...baseReq, model: "claude-3-haiku-20240307" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.statusCode).toBe(c.status);
      expect(err.retryable).toBe(c.retryable);
    }
  });

  it("stream() routes by event name and yields deltas + final usage", async () => {
    // Realistic Anthropic SSE shape: message_start (input usage) ->
    // content_block_start -> 2x content_block_delta -> content_block_stop
    // -> message_delta (output usage) -> message_stop.
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":7,"output_tokens":1}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo!"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const fetchSpy = vi.fn().mockResolvedValue(sseResponse(sse));
    const p = new AnthropicProvider({ apiKey: "k", fetchImpl: fetchSpy });

    const events = [];
    for await (const ev of p.stream({ ...baseReq, model: "claude-3-haiku-20240307" })) {
      events.push(ev);
    }

    // Streaming flag is in the body
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.stream).toBe(true);

    // Two content deltas, then a done with the upstream-reported usage
    expect(events.filter((e) => e.type === "delta")).toEqual([
      { type: "delta", content: "Hel" },
      { type: "delta", content: "lo!" },
    ]);
    const done = events.at(-1) as { type: "done"; usage: { input_tokens: number; output_tokens: number } };
    expect(done.type).toBe("done");
    expect(done.usage.input_tokens).toBe(7);
    expect(done.usage.output_tokens).toBe(4);
  });

  it("stream() throws a retryable ProviderError on a pre-stream 5xx", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(503, { error: { message: "down" } }));
    const p = new AnthropicProvider({ apiKey: "k", fetchImpl: fetchSpy });
    const iter = p.stream({ ...baseReq, model: "claude-3-haiku-20240307" })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toMatchObject({
      statusCode: 503,
      retryable: true,
      providerName: "anthropic",
    });
  });

  it("stream() maps a fetch transport throw to a retryable 503", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ENOTFOUND api.anthropic.com"));
    const p = new AnthropicProvider({ apiKey: "k", fetchImpl: fetchSpy });
    const iter = p.stream({ ...baseReq, model: "claude-3-haiku-20240307" })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toMatchObject({
      statusCode: 503,
      retryable: true,
    });
  });
});
