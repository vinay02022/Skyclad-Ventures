import { ProviderError } from "./errors.js";

/**
 * Single source of truth for "this HTTP status from an upstream provider
 * means {retryable | not retryable, so map it to ProviderError(...)}".
 *
 * The classification matches the assignment spec literally:
 *
 *   - 4xx (auth, bad request, model not found, content filter, etc.)
 *     are NOT retryable and NOT a candidate for failover. The upstream
 *     told us the request itself is wrong; rolling over to a different
 *     provider would just multiply the user's bill on a guaranteed-fail
 *     request.
 *
 *   - 429 (rate-limited) is the one 4xx exception. Per spec: "may
 *     fallback". We mark it `retryable: true` so:
 *       (a) the resilient adapter's retry policy gets one or two
 *           backed-off retries against the same upstream, AND
 *       (b) if those exhaust, the chat handler's failover loop tries
 *           the next provider candidate.
 *     The product of those two is the "may fallback" the spec
 *     describes — without giving up local recovery first.
 *
 *   - 5xx (server error, gateway timeout, etc.) is retryable. The
 *     upstream is sick; either it'll come back, or another upstream
 *     will pick up the slack via failover.
 *
 *   - Anything else (we don't expect to see it, but we have to handle
 *     it): treat as not retryable. Better to fail loudly than silently
 *     paper over a contract change.
 *
 * The mapped ProviderError feeds straight into the existing chat
 * handler / streaming handler / circuit breaker plumbing. No code
 * downstream of this function knows the difference between a real
 * upstream error and a mock one.
 */
export function mapHttpStatusToProviderError(
  status: number,
  providerName: string,
  message: string,
): ProviderError {
  if (status === 429) {
    return new ProviderError(`${providerName} 429 rate limited: ${message}`, {
      statusCode: 429,
      retryable: true,
      providerName,
    });
  }
  if (status >= 500 && status <= 599) {
    return new ProviderError(`${providerName} ${status} upstream error: ${message}`, {
      statusCode: status,
      retryable: true,
      providerName,
    });
  }
  if (status >= 400 && status <= 499) {
    return new ProviderError(`${providerName} ${status} client error: ${message}`, {
      statusCode: status,
      retryable: false,
      providerName,
    });
  }
  // Anything else (1xx, 3xx that wasn't followed, future statuses).
  return new ProviderError(`${providerName} ${status} unexpected: ${message}`, {
    statusCode: status,
    retryable: false,
    providerName,
  });
}

/**
 * Classify a transport-layer failure (DNS, TCP reset, TLS handshake
 * failure, AbortError before the response started, etc.) as a
 * retryable 503. From the gateway's perspective these are all "the
 * upstream is unreachable right now" — the same operational class as
 * a 5xx response, so they get the same retry+failover treatment.
 *
 * AbortError specifically: the resilient adapter wraps every call in
 * `withTimeout`, which aborts the fetch on timeout. We map that to a
 * retryable 504. Without this mapping the fetch's TypeError leaks out
 * unannotated and the breaker can't account for it as a clean
 * "upstream too slow".
 */
export function mapTransportErrorToProviderError(
  err: unknown,
  providerName: string,
): ProviderError {
  const isAbort =
    err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
  if (isAbort) {
    return new ProviderError(`${providerName} request aborted (likely timeout)`, {
      statusCode: 504,
      retryable: true,
      providerName,
    });
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new ProviderError(`${providerName} transport error: ${detail}`, {
    statusCode: 503,
    retryable: true,
    providerName,
  });
}
