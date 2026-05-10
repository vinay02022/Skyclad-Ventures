import { AnthropicProvider } from "./anthropic-real.js";
import { MockAnthropicProvider } from "./mock-anthropic.js";
import type { MockFailureStore } from "./mock-failure-store.js";
import { MockOpenAIProvider } from "./mock-openai.js";
import { OpenAIProvider } from "./openai-real.js";
import { ProviderRegistry } from "./registry.js";

export type ProviderMode = "mock" | "live";

/** Minimal logger surface — Pino satisfies it; tests can pass a spy. */
export interface FactoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface BuildProviderRegistryOptions {
  mode: ProviderMode;
  /** Required for live mode, used by the OpenAI adapter. */
  openaiApiKey?: string;
  /** Required for live mode, used by the Anthropic adapter. */
  anthropicApiKey?: string;
  /** Optional; emits one line per provider with the resolved adapter. */
  logger?: FactoryLogger;
  /** Test-only escape hatches to keep real-adapter tests off the network. */
  fetchImpl?: typeof fetch;
  openaiBaseUrl?: string;
  anthropicBaseUrl?: string;
  /**
   * Phase 11: optional shared store for the eval-only admin endpoint
   * `POST /admin/mock-providers/:provider/failure-mode`. Mock adapters
   * consult it after checking per-request header injection. In live
   * mode the real adapters never read it (it's silently unused), so
   * passing the store unconditionally from app.ts is harmless.
   */
  mockFailureStore?: MockFailureStore;
}

/**
 * Single place that decides which adapter implementation goes behind
 * each provider name in the registry. Both adapters (mock and real)
 * implement the same `ProviderAdapter` interface, so the routing
 * layer / chat handler / streaming handler don't need to know which
 * one they're talking to.
 *
 * Mode resolution:
 *
 *   mode === "mock"       Both providers are mocks. Default for tests
 *                         and for any boot where MOCK_PROVIDERS=true.
 *
 *   mode === "live"       Per-provider fallback: if a provider's API
 *                         key is set, the real adapter is wired; if
 *                         it's missing, that one provider falls back
 *                         to mock with a logged warning. The other
 *                         provider is unaffected. This lets a
 *                         developer run with one real upstream and
 *                         one mock upstream while iterating, instead
 *                         of forcing all-or-nothing.
 *
 * The factory deliberately fails CLOSED on missing keys (mock, with
 * a warning) rather than CLOSED on connection errors (real, with
 * 401 noise). The visible warning is the engineer's signal that
 * they're not actually exercising the upstream they think they are.
 */
export function buildProviderRegistry(opts: BuildProviderRegistryOptions): ProviderRegistry {
  const registry = new ProviderRegistry();

  if (opts.mode === "mock") {
    registry.register(new MockOpenAIProvider(opts.mockFailureStore));
    registry.register(new MockAnthropicProvider(opts.mockFailureStore));
    opts.logger?.info(
      { mode: "mock", openai: "mock", anthropic: "mock" },
      "provider registry built",
    );
    return registry;
  }

  // mode === "live"
  let openaiResolution = "mock";
  if (opts.openaiApiKey) {
    registry.register(
      new OpenAIProvider({
        apiKey: opts.openaiApiKey,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.openaiBaseUrl ? { baseUrl: opts.openaiBaseUrl } : {}),
      }),
    );
    openaiResolution = "real";
  } else {
    registry.register(new MockOpenAIProvider(opts.mockFailureStore));
    opts.logger?.warn(
      { provider: "openai" },
      "MOCK_PROVIDERS=false but OPENAI_API_KEY is empty; falling back to MOCK openai adapter",
    );
  }

  let anthropicResolution = "mock";
  if (opts.anthropicApiKey) {
    registry.register(
      new AnthropicProvider({
        apiKey: opts.anthropicApiKey,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.anthropicBaseUrl ? { baseUrl: opts.anthropicBaseUrl } : {}),
      }),
    );
    anthropicResolution = "real";
  } else {
    registry.register(new MockAnthropicProvider(opts.mockFailureStore));
    opts.logger?.warn(
      { provider: "anthropic" },
      "MOCK_PROVIDERS=false but ANTHROPIC_API_KEY is empty; falling back to MOCK anthropic adapter",
    );
  }

  opts.logger?.info(
    { mode: "live", openai: openaiResolution, anthropic: anthropicResolution },
    "provider registry built",
  );
  return registry;
}
