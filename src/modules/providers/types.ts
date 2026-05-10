// ----------------------------------------------------------------------------
// The "client-facing" types. These are what the gateway accepts and returns.
// They are deliberately provider-agnostic so adding a new upstream provider
// later (Google, Mistral, an open-weights endpoint) does not change the API
// the client speaks.
// ----------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type ModelClass = "cheap" | "balanced" | "premium";

export interface UnifiedChatRequest {
  model_class: ModelClass;
  messages: ChatMessage[];
  stream: boolean;
  temperature: number;
  max_tokens: number;
  /** Optional. Forces a specific provider for testing/debugging. */
  provider?: string;
  /** Optional. Forces a specific model. Otherwise the adapter picks based on model_class. */
  model?: string;
}

export interface UnifiedChatResponse {
  id: string;
  model_class: ModelClass;
  provider: string;
  model: string;
  message: ChatMessage;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  cost_usd: number;
  cached: boolean;
  created_at: string;
}

// ----------------------------------------------------------------------------
// The "internal" types — what an adapter sees and returns. Lives between the
// gateway and one specific upstream provider. Failure injection is on the
// request object because the mock adapters need it; real adapters ignore it.
// ----------------------------------------------------------------------------

export type FailureMode =
  | "5xx"
  | "rate-limit"
  | "timeout"
  | "stream-drop"
  | "pre-stream-drop";

export interface FailureInjection {
  mode: FailureMode;
  /** For stream-drop: emit this many chunks then throw. */
  afterChunks?: number;
  /** Optional artificial latency before doing the real (or failing) work. */
  delayMs?: number;
}

export interface ProviderChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  /** Mock-only knob; honored by mock adapters, ignored by real ones. */
  failure?: FailureInjection;
}

export interface ProviderChatResponse {
  model: string;
  message: ChatMessage;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export type ProviderStreamChunk =
  | { type: "delta"; content: string }
  | {
      type: "done";
      usage: { input_tokens: number; output_tokens: number };
    };

export interface ProviderHealth {
  healthy: boolean;
  reason?: string;
}

// ----------------------------------------------------------------------------
// The interface every adapter implements. Routing/resilience code in later
// phases only ever touches this interface, never a concrete provider.
// ----------------------------------------------------------------------------
export interface ProviderAdapter {
  readonly name: string;
  /** Pick a default model when the caller only specified a model_class. */
  resolveDefaultModel(modelClass: ModelClass): string | null;
  complete(request: ProviderChatRequest): Promise<ProviderChatResponse>;
  stream(request: ProviderChatRequest): AsyncIterable<ProviderStreamChunk>;
  estimateTokens(request: ProviderChatRequest): { input_tokens: number };
  health?(): Promise<ProviderHealth>;
}
