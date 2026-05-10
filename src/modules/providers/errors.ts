// Single error type provider adapters throw on upstream failure. Carries
// enough info for the resilience layer (Phase 5) to decide whether to retry
// and for the chat handler to map to an HTTP status.
export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly providerName: string;

  constructor(
    message: string,
    opts: { statusCode: number; retryable: boolean; providerName: string },
  ) {
    super(message);
    this.statusCode = opts.statusCode;
    this.retryable = opts.retryable;
    this.providerName = opts.providerName;
  }
}
