import type { ModelClassRow } from "../providers/pricing.js";
import type { ModelClass } from "../providers/types.js";

/**
 * One provider/model option the router considered. The chat handler walks
 * an ordered list of these (selected first, then fallbacks in cost order)
 * and stops at the first one that returns a clean response.
 */
export interface RouteCandidate {
  provider: string;
  model: string;
  model_class: string;
  estimated_cost_usd: number;
  /** Why this candidate is in the picked/fallback list, e.g. "cheapest_eligible". */
  reason: string;
}

/** A candidate the policy looked at and chose to drop, with a short reason. */
export interface FilteredOutCandidate {
  provider: string;
  model: string;
  reason: string;
}

/**
 * Full routing decision. Logged on every request, returned (in summary form)
 * on the response, and used by the chat handler to drive the failover loop.
 */
export interface RoutingDecision {
  policy: string;
  selected: RouteCandidate;
  fallback_candidates: RouteCandidate[];
  candidates_considered: number;
  filtered_out: FilteredOutCandidate[];
}

/**
 * Per-provider health view the router uses to skip dead providers.
 *
 * Phase 4 ships an AlwaysHealthyOracle. Phase 5 will replace it with the
 * real circuit breaker (open breaker -> isHealthy returns false), without
 * the router code needing to change.
 */
export interface ProviderHealthOracle {
  isHealthy(providerName: string): boolean;
}

/**
 * Subset of PricingRepository the router needs. Declared as an interface
 * so unit tests can pass a tiny in-memory fake without touching Postgres.
 */
export interface RoutingPricingReader {
  listEnabledByModelClass(modelClass: string): Promise<ModelClassRow[]>;
}

/**
 * Subset of ProviderRegistry the router needs (just "is there an adapter
 * for this provider name?"). Same testability motivation as above.
 */
export interface RoutingRegistry {
  has(providerName: string): boolean;
}

/** Inputs the chat handler hands to the policy on every request. */
export interface RoutingContext {
  modelClass: ModelClass;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  /** Provider names this tenant is allowed to use (from tenant_provider_allowlists). */
  allowlist: string[];
  health: ProviderHealthOracle;
  registry: RoutingRegistry;
  pricing: RoutingPricingReader;
}

/**
 * The single seam the routing module exposes. Swap a different
 * implementation in (latency-aware, weighted random, etc.) without
 * touching the chat handler.
 */
export interface RoutingPolicy {
  readonly name: string;
  pick(ctx: RoutingContext): Promise<RoutingDecision | null>;
}
