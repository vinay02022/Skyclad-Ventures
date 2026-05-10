import { ProviderRegistry } from "../providers/registry.js";
import type { CircuitBreakerRegistry } from "./circuit-breaker.js";
import { ResilientAdapter } from "./resilient-adapter.js";
import type { ResilienceConfig, ResilienceLogger } from "./types.js";

/**
 * Wrap every adapter in `inner` with a ResilientAdapter, sharing the
 * supplied breaker registry. Returns a fresh ProviderRegistry the chat
 * handler can use exactly the same way as the unwrapped one.
 */
export function buildResilientRegistry(opts: {
  inner: ProviderRegistry;
  breakers: CircuitBreakerRegistry;
  config: ResilienceConfig;
  logger?: ResilienceLogger;
}): ProviderRegistry {
  const wrapped = new ProviderRegistry();
  for (const name of opts.inner.names()) {
    const adapter = opts.inner.get(name)!;
    const breaker = opts.breakers.for(name);
    wrapped.register(new ResilientAdapter(adapter, breaker, opts.config, opts.logger));
  }
  return wrapped;
}
