import { describe, expect, it } from "vitest";

import { ProviderError } from "../src/modules/providers/errors.js";
import { MockAnthropicProvider } from "../src/modules/providers/mock-anthropic.js";
import { MockOpenAIProvider } from "../src/modules/providers/mock-openai.js";
import type {
  ProviderChatRequest,
  ProviderStreamChunk,
} from "../src/modules/providers/types.js";

// These are pure unit tests against the adapter contract. They do NOT touch
// Postgres, Fastify, or HTTP — that's the whole point of the abstraction:
// each adapter can be reasoned about in complete isolation.
describe("MockOpenAIProvider", () => {
  const provider = new MockOpenAIProvider();

  it("registers under the canonical 'openai' name", () => {
    expect(provider.name).toBe("openai");
  });

  it("resolves cheap and balanced model classes; returns null for premium", () => {
    expect(provider.resolveDefaultModel("cheap")).toBe("gpt-4o-mini");
    expect(provider.resolveDefaultModel("balanced")).toBe("gpt-4o");
    expect(provider.resolveDefaultModel("premium")).toBeNull();
  });

  it("complete() returns a normalized response with assistant role and token usage", async () => {
    const req: ProviderChatRequest = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello there" }],
      temperature: 0,
      max_tokens: 64,
    };
    const res = await provider.complete(req);
    expect(res.model).toBe("gpt-4o-mini");
    expect(res.message.role).toBe("assistant");
    expect(res.message.content).toContain("[mock-openai]");
    expect(res.usage.input_tokens).toBeGreaterThan(0);
    expect(res.usage.output_tokens).toBeGreaterThan(0);
  });

  it("complete() throws ProviderError(500, retryable) when failure mode is '5xx'", async () => {
    const req: ProviderChatRequest = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      max_tokens: 32,
      failure: { mode: "5xx" },
    };
    await expect(provider.complete(req)).rejects.toMatchObject({
      name: "ProviderError",
      statusCode: 500,
      retryable: true,
      providerName: "openai",
    });
  });

  it("complete() throws ProviderError(429, retryable) when failure mode is 'rate-limit'", async () => {
    const req: ProviderChatRequest = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      max_tokens: 32,
      failure: { mode: "rate-limit" },
    };
    await expect(provider.complete(req)).rejects.toMatchObject({
      statusCode: 429,
      retryable: true,
    });
  });

  it("stream() yields delta chunks then a done chunk under happy path", async () => {
    const req: ProviderChatRequest = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "stream me" }],
      temperature: 0,
      max_tokens: 64,
    };
    const chunks: ProviderStreamChunk[] = [];
    for await (const c of provider.stream(req)) chunks.push(c);

    const last = chunks.at(-1)!;
    expect(last.type).toBe("done");
    expect(chunks.length).toBeGreaterThan(1); // at least one delta + done
    const deltas = chunks.filter((c) => c.type === "delta") as Array<
      Extract<ProviderStreamChunk, { type: "delta" }>
    >;
    const reassembled = deltas.map((d) => d.content).join("");
    expect(reassembled).toContain("[mock-openai]");
  });

  it("stream() drops mid-stream after N chunks when failure mode is 'stream-drop'", async () => {
    const req: ProviderChatRequest = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "this is a longer prompt that produces several chunks" }],
      temperature: 0,
      max_tokens: 64,
      failure: { mode: "stream-drop", afterChunks: 2 },
    };
    const collected: ProviderStreamChunk[] = [];
    let caught: unknown;
    try {
      for await (const c of provider.stream(req)) collected.push(c);
    } catch (e) {
      caught = e;
    }
    expect(collected).toHaveLength(2);
    expect(collected.every((c) => c.type === "delta")).toBe(true);
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(false); // partial output already sent
  });

  it("stream() throws BEFORE any chunk when failure mode is 'pre-stream-drop'", async () => {
    const req: ProviderChatRequest = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      max_tokens: 32,
      failure: { mode: "pre-stream-drop" },
    };
    const collected: ProviderStreamChunk[] = [];
    let caught: unknown;
    try {
      for await (const c of provider.stream(req)) collected.push(c);
    } catch (e) {
      caught = e;
    }
    expect(collected).toHaveLength(0);
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(true); // safe to failover
  });

  it("estimateTokens() returns input_tokens > 0 for any non-empty message", () => {
    const out = provider.estimateTokens({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0,
      max_tokens: 32,
    });
    expect(out.input_tokens).toBeGreaterThan(0);
  });

  it("health() reports healthy for the mock", async () => {
    const h = await provider.health!();
    expect(h.healthy).toBe(true);
  });
});

describe("MockAnthropicProvider", () => {
  const provider = new MockAnthropicProvider();

  it("registers under the canonical 'anthropic' name", () => {
    expect(provider.name).toBe("anthropic");
  });

  it("resolves all three model classes including premium", () => {
    expect(provider.resolveDefaultModel("cheap")).toBe("claude-3-haiku-20240307");
    expect(provider.resolveDefaultModel("balanced")).toBe("claude-3-5-sonnet-20241022");
    expect(provider.resolveDefaultModel("premium")).toBe("claude-3-opus-20240229");
  });

  it("complete() returns the anthropic mock tag (proves which adapter answered)", async () => {
    const res = await provider.complete({
      model: "claude-3-haiku-20240307",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0,
      max_tokens: 32,
    });
    expect(res.message.content).toContain("[mock-anthropic]");
  });
});
