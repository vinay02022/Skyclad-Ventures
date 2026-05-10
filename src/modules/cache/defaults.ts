import type { CacheConfig } from "./types.js";

/**
 * Default cache config. 5-minute TTL is the assignment-allowed lower bound
 * and a sane default for an LLM gateway: long enough that a developer
 * iterating on the same prompt sees real savings, short enough that a
 * model swap or upstream change isn't reflected for hours.
 *
 * Production would expose this via env (CACHE_TTL_MS) and possibly per-
 * tenant overrides; for assignment scope a single constant is enough and
 * the value lives here so changing it is one focused diff.
 */
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  enabled: true,
  ttlMs: 5 * 60 * 1_000,
};
