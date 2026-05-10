import { setTimeout as sleep } from "node:timers/promises";

import { ProviderError } from "./errors.js";
import { estimateMessagesTokens, estimateTextTokens } from "./tokens.js";
import type {
  FailureInjection,
  ProviderAdapter,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderHealth,
  ProviderStreamChunk,
} from "./types.js";

// Shared mock behaviour. Both MockOpenAIProvider and MockAnthropicProvider
// inherit it. The only things subclasses customize are the provider name,
// the model-class -> default-model mapping, and the small "vendor flavour"
// the mock prepends to its reply (so tests can prove which mock answered).
export abstract class MockProviderBase implements ProviderAdapter {
  abstract readonly name: string;

  /** Default models per class. Subclasses fill this in. */
  protected abstract defaultModelByClass(): Record<string, string | null>;

  /** A short tag the mock prepends to its reply, e.g. "[mock-openai]". */
  protected abstract replyTag(): string;

  resolveDefaultModel(modelClass: string): string | null {
    return this.defaultModelByClass()[modelClass] ?? null;
  }

  async complete(req: ProviderChatRequest): Promise<ProviderChatResponse> {
    await this.applyPreCallFailure(req.failure);

    const inputTokens = estimateMessagesTokens(req.messages);
    const echoed = req.messages.at(-1)?.content?.slice(0, 80) ?? "";
    const replyText = `${this.replyTag()} ${echoed}`.trim();
    const outputTokens = estimateTextTokens(replyText);

    return {
      model: req.model,
      message: { role: "assistant", content: replyText },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }

  async *stream(req: ProviderChatRequest): AsyncIterable<ProviderStreamChunk> {
    // pre-stream-drop is the "drops before any byte" failure mode. The
    // resilience layer is allowed to retry/failover when this happens.
    if (req.failure?.mode === "pre-stream-drop") {
      if (req.failure.delayMs) await sleep(req.failure.delayMs);
      throw new ProviderError("mock pre-stream drop", {
        statusCode: 503,
        retryable: true,
        providerName: this.name,
      });
    }

    // Non-stream failures (5xx, rate-limit, timeout) still apply before any
    // stream chunk is sent, so they behave like a clean failover.
    await this.applyPreCallFailure(req.failure);

    const inputTokens = estimateMessagesTokens(req.messages);
    const echoed = req.messages.at(-1)?.content?.slice(0, 80) ?? "";
    const fullReply = `${this.replyTag()} ${echoed}`.trim();
    const chunks = chunkText(fullReply, 8);

    let outputTokens = 0;
    for (let i = 0; i < chunks.length; i++) {
      // mid-stream drop: emit afterChunks chunks then fail.
      if (
        req.failure?.mode === "stream-drop" &&
        typeof req.failure.afterChunks === "number" &&
        i >= req.failure.afterChunks
      ) {
        throw new ProviderError("mock stream drop", {
          statusCode: 502,
          retryable: false, // we already sent partial output; do not retry
          providerName: this.name,
        });
      }
      // Tiny inter-chunk delay so a real consumer sees actual streaming.
      await sleep(2);
      const piece = chunks[i] ?? "";
      outputTokens += estimateTextTokens(piece);
      yield { type: "delta", content: piece };
    }

    yield { type: "done", usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
  }

  estimateTokens(req: ProviderChatRequest): { input_tokens: number } {
    return { input_tokens: estimateMessagesTokens(req.messages) };
  }

  async health(): Promise<ProviderHealth> {
    // Mocks are always up. Real adapters can ping the upstream here.
    return { healthy: true };
  }

  // Common pre-call failure handler shared by complete() and stream().
  private async applyPreCallFailure(failure: FailureInjection | undefined): Promise<void> {
    if (!failure) return;
    if (failure.delayMs) await sleep(failure.delayMs);
    switch (failure.mode) {
      case "5xx":
        throw new ProviderError("mock-injected upstream 5xx", {
          statusCode: 500,
          retryable: true,
          providerName: this.name,
        });
      case "rate-limit":
        throw new ProviderError("mock-injected rate limit", {
          statusCode: 429,
          retryable: true,
          providerName: this.name,
        });
      case "timeout":
        // Sleep longer than any sensible per-call timeout. The resilience
        // layer in Phase 5 will race this against an AbortController.
        await sleep(60_000);
        return;
      // stream-drop / pre-stream-drop are handled inside stream(), not here.
      case "stream-drop":
      case "pre-stream-drop":
        return;
    }
  }
}

function chunkText(text: string, size: number): string[] {
  if (size <= 0) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out.length > 0 ? out : [""];
}
