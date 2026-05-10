import type { ProviderHealthOracle } from "./types.js";

/**
 * Phase 4 default. Every provider is reported as healthy. Phase 5 will
 * replace this with the per-provider circuit breaker that returns false
 * when the breaker is open. The interface stays the same so nothing in
 * the router or the chat handler needs to change.
 */
export class AlwaysHealthyOracle implements ProviderHealthOracle {
  isHealthy(): boolean {
    return true;
  }
}
