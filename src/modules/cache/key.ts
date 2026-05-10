import { createHash } from "node:crypto";

import type { CacheKeyInput } from "./types.js";

/**
 * Build the SHA-256 cache key for a request.
 *
 * The serialized form is a stable JSON object with a fixed key order. Using
 * JSON.stringify with an explicit object literal (rather than spreading the
 * input) guarantees we hash the same shape every time even if the caller
 * mutates field order on `CacheKeyInput`.
 *
 * Messages are normalized to {role, content} only — anything else a caller
 * might attach (ids, timestamps) is ignored, otherwise identical prompts
 * would never collide on the cache.
 *
 * Returns a 64-character lowercase hex string.
 */
export function buildCacheKey(input: CacheKeyInput): string {
  const normalized = {
    tenant_id: input.tenantId,
    model_class: input.modelClass,
    provider: input.provider,
    model: input.model,
    messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: input.temperature,
    max_tokens: input.maxTokens,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
