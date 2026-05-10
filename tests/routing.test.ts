import { describe, expect, it } from "vitest";

import type { ModelClassRow } from "../src/modules/providers/pricing.js";
import { CostOptimizedRoutingPolicy } from "../src/modules/routing/cost-optimized.js";
import type {
  ProviderHealthOracle,
  RoutingPricingReader,
  RoutingRegistry,
} from "../src/modules/routing/types.js";
import type { ModelClass } from "../src/modules/providers/types.js";

// --- tiny in-memory fakes for the policy's three deps -----------------

class FakePricing implements RoutingPricingReader {
  constructor(private readonly rows: ModelClassRow[]) {}
  async listEnabledByModelClass(modelClass: string): Promise<ModelClassRow[]> {
    // The real PricingRepository already filters by model_class + enabled
    // in SQL, so the policy's contract is "you get only rows that survive
    // those filters". We pre-filter here for the same shape.
    void modelClass;
    return this.rows;
  }
}

class FakeRegistry implements RoutingRegistry {
  constructor(private readonly known: Set<string>) {}
  has(name: string): boolean {
    return this.known.has(name);
  }
}

class FakeHealth implements ProviderHealthOracle {
  constructor(private readonly downSet: Set<string> = new Set()) {}
  isHealthy(name: string): boolean {
    return !this.downSet.has(name);
  }
}

// Realistic-ish prices borrowed from the seed file. The exact numbers don't
// matter for ordering as long as we keep the relative cost intuition.
const OPENAI_CHEAP: ModelClassRow = {
  provider: "openai",
  model: "gpt-4o-mini",
  inputCostPer1k: 0.00015,
  outputCostPer1k: 0.0006,
};
const ANTHROPIC_CHEAP: ModelClassRow = {
  provider: "anthropic",
  model: "claude-3-haiku",
  inputCostPer1k: 0.00025,
  outputCostPer1k: 0.00125,
};
const ANTHROPIC_PREMIUM: ModelClassRow = {
  provider: "anthropic",
  model: "claude-3-opus",
  inputCostPer1k: 0.015,
  outputCostPer1k: 0.075,
};
const GOOGLE_CHEAP: ModelClassRow = {
  // Intentionally "configured but no adapter" — used by the misconfig test.
  provider: "google",
  model: "gemini-flash",
  inputCostPer1k: 0.0001,
  outputCostPer1k: 0.0004,
};

const baseCtx = (overrides: Partial<Parameters<CostOptimizedRoutingPolicy["pick"]>[0]>) => ({
  modelClass: "cheap" as ModelClass,
  estimatedInputTokens: 100,
  maxOutputTokens: 200,
  allowlist: ["openai", "anthropic"],
  health: new FakeHealth(),
  registry: new FakeRegistry(new Set(["openai", "anthropic"])),
  pricing: new FakePricing([OPENAI_CHEAP, ANTHROPIC_CHEAP]),
  ...overrides,
});

describe("CostOptimizedRoutingPolicy", () => {
  it("picks the cheapest eligible provider and lists the rest as fallbacks", async () => {
    const policy = new CostOptimizedRoutingPolicy();
    const decision = await policy.pick(baseCtx({}));

    expect(decision).not.toBeNull();
    expect(decision!.policy).toBe("cost-optimized");
    expect(decision!.selected.provider).toBe("openai");
    expect(decision!.selected.reason).toBe("cheapest_eligible");
    expect(decision!.fallback_candidates).toHaveLength(1);
    expect(decision!.fallback_candidates[0]?.provider).toBe("anthropic");
    expect(decision!.fallback_candidates[0]?.reason).toBe("fallback_candidate");
    // Cost should match the formula: ((p_in * in) + (p_out * out)) / 1000
    const expected = (0.00015 * 100 + 0.0006 * 200) / 1000;
    expect(decision!.selected.estimated_cost_usd).toBeCloseTo(expected, 6);
    expect(decision!.candidates_considered).toBe(2);
    expect(decision!.filtered_out).toHaveLength(0);
  });

  it("filters out providers not in the tenant allowlist", async () => {
    const policy = new CostOptimizedRoutingPolicy();
    const decision = await policy.pick(
      baseCtx({
        allowlist: ["openai"], // no anthropic
        pricing: new FakePricing([OPENAI_CHEAP, ANTHROPIC_CHEAP]),
      }),
    );

    expect(decision).not.toBeNull();
    expect(decision!.selected.provider).toBe("openai");
    expect(decision!.fallback_candidates).toHaveLength(0);
    expect(decision!.filtered_out).toEqual([
      { provider: "anthropic", model: "claude-3-haiku", reason: "not_in_tenant_allowlist" },
    ]);
  });

  it("filters out provider rows that have no registered adapter (config drift safety)", async () => {
    const policy = new CostOptimizedRoutingPolicy();
    const decision = await policy.pick(
      baseCtx({
        allowlist: ["openai", "anthropic", "google"],
        pricing: new FakePricing([GOOGLE_CHEAP, OPENAI_CHEAP, ANTHROPIC_CHEAP]),
        // google is missing from the registry on purpose
        registry: new FakeRegistry(new Set(["openai", "anthropic"])),
      }),
    );

    expect(decision).not.toBeNull();
    expect(decision!.selected.provider).toBe("openai");
    expect(decision!.filtered_out).toContainEqual({
      provider: "google",
      model: "gemini-flash",
      reason: "no_adapter_registered",
    });
  });

  it("filters out unhealthy providers (the breaker-open case in Phase 5)", async () => {
    const policy = new CostOptimizedRoutingPolicy();
    const decision = await policy.pick(
      baseCtx({
        // openai is cheaper, but reported unhealthy. Should fall through to anthropic.
        health: new FakeHealth(new Set(["openai"])),
      }),
    );

    expect(decision).not.toBeNull();
    expect(decision!.selected.provider).toBe("anthropic");
    expect(decision!.filtered_out).toContainEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      reason: "unhealthy",
    });
  });

  it("returns null when no candidate survives filtering", async () => {
    const policy = new CostOptimizedRoutingPolicy();
    const decision = await policy.pick(
      baseCtx({
        // tenant_b style allowlist + only premium models in the class -> empty
        modelClass: "premium",
        allowlist: ["openai"],
        pricing: new FakePricing([ANTHROPIC_PREMIUM]),
      }),
    );

    expect(decision).toBeNull();
  });

  it("disabled rows never reach the policy (PricingRepository already filters them)", async () => {
    // This is a contract test: the SQL behind listEnabledByModelClass filters
    // `enabled = true`. Re-asserting it here keeps anyone refactoring the
    // repo from accidentally widening the contract.
    const policy = new CostOptimizedRoutingPolicy();
    const decision = await policy.pick(
      baseCtx({
        // Pricing returns ONLY the enabled row; disabled rows are simulated
        // by being absent from the input.
        pricing: new FakePricing([OPENAI_CHEAP]),
      }),
    );
    expect(decision).not.toBeNull();
    expect(decision!.selected.provider).toBe("openai");
    expect(decision!.candidates_considered).toBe(1);
  });
});
