import type { ParsedChatRequest } from "../chat/validation.js";

/**
 * The "is this request safe to cache?" predicate. Two rules, both
 * non-negotiable for correctness:
 *
 *   1. No streaming. Cache stores a fully-assembled response; replaying
 *      it as SSE is a separate piece of work and not in scope.
 *   2. Only deterministic generations. temperature > 0 means the model
 *      is allowed to sample; replaying a single past sample as if it
 *      were "the" answer would silently destroy the variation the
 *      caller asked for.
 *
 * The Zod schema defaults temperature to 0, so a caller who omits the
 * field implicitly opts in. A caller who sets temperature: 0.7 opts out.
 */
export function isCacheable(body: ParsedChatRequest): boolean {
  if (body.stream) return false;
  if (body.temperature !== 0) return false;
  return true;
}
