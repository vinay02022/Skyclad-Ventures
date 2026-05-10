import type { ChatMessage, ModelClass } from "../providers/types.js";

/**
 * The exact set of fields that participate in the cache key. Anything that
 * could change the model's output must be in here, or two different
 * requests collapse onto the same cache row.
 *
 * Critically:
 *  - tenant_id is in the key AND in the storage row. The hash gives us
 *    cryptographic isolation; the SQL composite unique on
 *    (tenant_id, cache_key) gives us a defense-in-depth constraint.
 *  - provider + model are in the key because the router can pick a
 *    different upstream for the same logical request (e.g. openai is
 *    OPEN, router falls back to anthropic). Returning openai's old
 *    answer for an anthropic-routed request would be a correctness bug.
 *  - max_tokens is in the key because a smaller cap can produce a
 *    truncated response; replaying that for a larger cap would silently
 *    return the wrong shape.
 */
export interface CacheKeyInput {
  tenantId: string;
  modelClass: ModelClass;
  provider: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
}

/**
 * The subset of UnifiedChatResponse we actually cache. We do NOT cache
 * id, created_at, cached, or routing — those must reflect the CURRENT
 * request, not the original one. On a hit the chat handler rebuilds the
 * full response shape from these fields plus fresh metadata.
 */
export interface CachedResponsePayload {
  model_class: ModelClass;
  provider: string;
  model: string;
  message: ChatMessage;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export interface CacheConfig {
  /** Whether the cache layer is consulted at all. Tests / ops can disable. */
  enabled: boolean;
  /** Time-to-live for new entries, in milliseconds. */
  ttlMs: number;
}
