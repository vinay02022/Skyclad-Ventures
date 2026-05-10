// Single source of truth for the values used by both the seed script and
// the test suite. Keeping these here means tests can assert against the
// exact same data the evaluator sees after `npm run db:seed`.

export const TENANT_A_ID = "00000000-0000-0000-0000-00000000000a";
export const TENANT_B_ID = "00000000-0000-0000-0000-00000000000b";

// Demo keys. Stored hashed in the DB. These are the only API keys printed in
// plaintext in this repo — production keys must never be committed and would
// be issued via a one-time response from a future POST /admin/api-keys
// endpoint (out of scope for this assignment).
export const TENANT_A_API_KEY = "sk_test_tenanta_demo_key_DO_NOT_USE_IN_PROD";
export const TENANT_B_API_KEY = "sk_test_tenantb_demo_key_DO_NOT_USE_IN_PROD";

export interface SeedTenantSpec {
  id: string;
  name: string;
  monthlyBudgetUsd: string;
  rateLimitPerMinute: number;
  apiKey: string;
  apiKeyName: string;
  allowlist: string[];
}

export const SEED_TENANTS: SeedTenantSpec[] = [
  {
    id: TENANT_A_ID,
    name: "tenant_a",
    monthlyBudgetUsd: "10.0000",
    rateLimitPerMinute: 60,
    apiKey: TENANT_A_API_KEY,
    apiKeyName: "tenant_a_default",
    // Both providers allowed — exercises cost-based routing across providers.
    allowlist: ["openai", "anthropic"],
  },
  {
    id: TENANT_B_ID,
    name: "tenant_b",
    monthlyBudgetUsd: "2.0000",
    rateLimitPerMinute: 10,
    apiKey: TENANT_B_API_KEY,
    apiKeyName: "tenant_b_default",
    // Restricted to OpenAI — exercises allowlist filtering and proves
    // tenant isolation is more than just budget separation.
    allowlist: ["openai"],
  },
];

export interface SeedProviderSpec {
  provider: string;
  model: string;
  modelClass: "cheap" | "balanced" | "premium";
  inputCostPer1kTokens: string;
  outputCostPer1kTokens: string;
}

// Prices reflect roughly-current public pricing (as of early 2026). They
// live in Postgres, not in code, so the evaluator can edit them live.
export const SEED_PROVIDERS: SeedProviderSpec[] = [
  {
    provider: "openai",
    model: "gpt-4o-mini",
    modelClass: "cheap",
    inputCostPer1kTokens: "0.000150",
    outputCostPer1kTokens: "0.000600",
  },
  {
    provider: "openai",
    model: "gpt-4o",
    modelClass: "balanced",
    inputCostPer1kTokens: "0.002500",
    outputCostPer1kTokens: "0.010000",
  },
  {
    provider: "anthropic",
    model: "claude-3-haiku-20240307",
    modelClass: "cheap",
    inputCostPer1kTokens: "0.000250",
    outputCostPer1kTokens: "0.001250",
  },
  {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    modelClass: "balanced",
    inputCostPer1kTokens: "0.003000",
    outputCostPer1kTokens: "0.015000",
  },
  {
    provider: "anthropic",
    model: "claude-3-opus-20240229",
    modelClass: "premium",
    inputCostPer1kTokens: "0.015000",
    outputCostPer1kTokens: "0.075000",
  },
];
