import { MockAnthropicProvider } from "./mock-anthropic.js";
import { MockOpenAIProvider } from "./mock-openai.js";
import { ProviderRegistry } from "./registry.js";

export type ProviderMode = "mock" | "live";

export interface BuildProviderRegistryOptions {
  mode: ProviderMode;
}

// Single place that decides which adapters to wire. For Phase 3 only the
// "mock" mode exists; "live" will throw until the real OpenAI/Anthropic
// adapters land in a later phase. The chat handler doesn't care which mode
// is active — it just looks up adapters by name through the registry.
export function buildProviderRegistry(opts: BuildProviderRegistryOptions): ProviderRegistry {
  const registry = new ProviderRegistry();

  if (opts.mode === "mock") {
    registry.register(new MockOpenAIProvider());
    registry.register(new MockAnthropicProvider());
    return registry;
  }

  throw new Error(
    `Provider mode '${opts.mode}' is not implemented yet. Live OpenAI/Anthropic ` +
      `adapters land in a later phase. Use mode: 'mock' for now.`,
  );
}
