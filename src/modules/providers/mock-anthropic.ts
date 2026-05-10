import { MockProviderBase } from "./mock-base.js";
import type { MockFailureStore } from "./mock-failure-store.js";

export class MockAnthropicProvider extends MockProviderBase {
  readonly name = "anthropic";

  constructor(failureStore?: MockFailureStore) {
    super(failureStore);
  }

  protected defaultModelByClass(): Record<string, string | null> {
    return {
      cheap: "claude-3-haiku-20240307",
      balanced: "claude-3-5-sonnet-20241022",
      premium: "claude-3-opus-20240229",
    };
  }

  protected replyTag(): string {
    return "[mock-anthropic]";
  }
}
