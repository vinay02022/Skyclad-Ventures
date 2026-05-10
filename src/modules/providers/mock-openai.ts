import { MockProviderBase } from "./mock-base.js";
import type { MockFailureStore } from "./mock-failure-store.js";

export class MockOpenAIProvider extends MockProviderBase {
  // Registered under the canonical provider name so the chat handler and the
  // (future) router don't need to know mock vs live. Phase X swaps in a real
  // OpenAI adapter under the same name with no API change.
  readonly name = "openai";

  // Optional shared failure store wired by the factory in app.ts; the
  // base class's resolveFailure() consults it when no per-request
  // header injection is set.
  constructor(failureStore?: MockFailureStore) {
    super(failureStore);
  }

  protected defaultModelByClass(): Record<string, string | null> {
    return {
      cheap: "gpt-4o-mini",
      balanced: "gpt-4o",
      // OpenAI doesn't have a "premium" tier in our seeded price table;
      // returning null lets routing fall through to another provider.
      premium: null,
    };
  }

  protected replyTag(): string {
    return "[mock-openai]";
  }
}
