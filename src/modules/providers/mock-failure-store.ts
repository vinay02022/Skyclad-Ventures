import type { FailureInjection } from "./types.js";

/**
 * Process-local store of "what should this mock provider do on its
 * next call?".
 *
 * Set by the eval-only `POST /admin/mock-providers/:provider/failure-mode`
 * endpoint; consulted by `MockProviderBase` on every call. Per-request
 * header injection (`x-skyclad-fail`) still takes precedence — the
 * store is the *fallback* for "I want this provider to keep failing
 * for the next several requests without re-typing the header each
 * time."
 *
 * Why this exists at all: the assignment evaluator should be able to
 * trigger "OpenAI is broken" with one curl, then run a normal-looking
 * request from a separate terminal and watch the failover happen.
 * Header injection works for one-off tests; this store works for
 * scenario-driven walkthroughs.
 *
 * Why it's process-local memory rather than persisted in Postgres:
 *   - Failure modes are a debug knob, not durable business state. A
 *     restart that clears them is the right behavior — production
 *     should never come up with "openai is broken" stuck in the DB.
 *   - Single-node only is fine for the same reason rate-limit
 *     counters are: this is a local-evaluation feature, not a fleet
 *     primitive.
 */
export class MockFailureStore {
  private readonly byProvider = new Map<string, FailureInjection | null>();

  /**
   * Set or clear the persistent failure mode for one provider name.
   * Pass `null` to return that provider to normal behavior.
   */
  set(providerName: string, failure: FailureInjection | null): void {
    if (failure === null) {
      this.byProvider.delete(providerName);
      return;
    }
    this.byProvider.set(providerName, failure);
  }

  get(providerName: string): FailureInjection | null {
    return this.byProvider.get(providerName) ?? null;
  }

  /** Test-only: wipe everything. */
  reset(): void {
    this.byProvider.clear();
  }

  /**
   * Snapshot of the current state. Used by the admin endpoint's
   * response so the operator can see exactly what was set.
   */
  snapshot(): Record<string, FailureInjection | null> {
    const out: Record<string, FailureInjection | null> = {};
    for (const [k, v] of this.byProvider) out[k] = v;
    return out;
  }
}
