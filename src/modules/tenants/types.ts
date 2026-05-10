// What every authenticated request handler can rely on. Kept narrow on
// purpose: anything more (allowlist, current usage) is loaded by the
// repository on demand so we don't pay for it on every request.
export interface AuthenticatedTenant {
  id: string;
  name: string;
  status: "active" | "disabled" | "over_budget";
  monthlyBudgetUsd: number;
  rateLimitPerMinute: number;
}
