import { describe, expect, it, vi } from "vitest";

import { AnthropicProvider } from "../src/modules/providers/anthropic-real.js";
import {
  buildProviderRegistry,
  type FactoryLogger,
} from "../src/modules/providers/factory.js";
import { MockAnthropicProvider } from "../src/modules/providers/mock-anthropic.js";
import { MockOpenAIProvider } from "../src/modules/providers/mock-openai.js";
import { OpenAIProvider } from "../src/modules/providers/openai-real.js";

function makeLogger(): {
  logger: FactoryLogger;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const info = vi.fn();
  const warn = vi.fn();
  return { logger: { info, warn }, info, warn };
}

describe("buildProviderRegistry", () => {
  it("mock mode wires both mock adapters", () => {
    const { logger, info } = makeLogger();
    const registry = buildProviderRegistry({ mode: "mock", logger });

    expect(registry.get("openai")).toBeInstanceOf(MockOpenAIProvider);
    expect(registry.get("anthropic")).toBeInstanceOf(MockAnthropicProvider);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "mock", openai: "mock", anthropic: "mock" }),
      "provider registry built",
    );
  });

  it("live mode + both keys wires both real adapters", () => {
    const { logger, warn, info } = makeLogger();
    const registry = buildProviderRegistry({
      mode: "live",
      openaiApiKey: "sk-test",
      anthropicApiKey: "ant-test",
      logger,
    });

    expect(registry.get("openai")).toBeInstanceOf(OpenAIProvider);
    expect(registry.get("anthropic")).toBeInstanceOf(AnthropicProvider);
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "live", openai: "real", anthropic: "real" }),
      "provider registry built",
    );
  });

  it("live mode + missing OPENAI_API_KEY falls back to mock for openai only", () => {
    const { logger, warn, info } = makeLogger();
    const registry = buildProviderRegistry({
      mode: "live",
      openaiApiKey: "",
      anthropicApiKey: "ant-test",
      logger,
    });

    expect(registry.get("openai")).toBeInstanceOf(MockOpenAIProvider);
    expect(registry.get("anthropic")).toBeInstanceOf(AnthropicProvider);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { provider: "openai" },
      expect.stringContaining("OPENAI_API_KEY is empty"),
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "live", openai: "mock", anthropic: "real" }),
      "provider registry built",
    );
  });

  it("live mode + missing both keys = degraded mock + two warnings", () => {
    const { logger, warn } = makeLogger();
    const registry = buildProviderRegistry({
      mode: "live",
      openaiApiKey: "",
      anthropicApiKey: "",
      logger,
    });

    expect(registry.get("openai")).toBeInstanceOf(MockOpenAIProvider);
    expect(registry.get("anthropic")).toBeInstanceOf(MockAnthropicProvider);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("threads fetchImpl + baseUrl overrides into the real adapters (network-free testability)", () => {
    const fakeFetch = vi.fn();
    const registry = buildProviderRegistry({
      mode: "live",
      openaiApiKey: "sk-test",
      anthropicApiKey: "ant-test",
      fetchImpl: fakeFetch,
      openaiBaseUrl: "http://127.0.0.1:9999",
      anthropicBaseUrl: "http://127.0.0.1:9998",
    });

    // We can't read the private fields directly, but we can prove the
    // overrides took effect by triggering a complete() and inspecting
    // where it tried to fetch.
    fakeFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "gpt-4o-mini",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    return registry
      .get("openai")!
      .complete({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0,
        max_tokens: 8,
      })
      .then(() => {
        expect(fakeFetch).toHaveBeenCalledWith(
          "http://127.0.0.1:9999/v1/chat/completions",
          expect.any(Object),
        );
      });
  });
});
