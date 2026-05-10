import type { ChatMessage } from "./types.js";

// Cheap heuristic: ~4 chars per token for English text. Real adapters
// replace this with the provider's reported token count from the response.
// Used only for pre-flight estimates (cache key, budget reservation in a
// later phase) where exactness is not required.
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  // 4-token-per-message overhead approximates the chat-completion framing
  // (role markers, separators) most providers add.
  let total = 0;
  for (const m of messages) {
    total += estimateTextTokens(m.content) + 4;
  }
  return total;
}
