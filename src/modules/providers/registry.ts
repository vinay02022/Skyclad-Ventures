import type { ProviderAdapter } from "./types.js";

// In-memory map of provider-name -> adapter instance. Built once at boot and
// passed into the chat handler. The router (Phase 4) and the resilience
// layer (Phase 5) will iterate this same registry. Keeping it as a tiny
// class instead of a global module export means tests can construct
// alternative registries (e.g. always-failing mocks) without monkey-patching.
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): ProviderAdapter | undefined {
    return this.adapters.get(name);
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  list(): ProviderAdapter[] {
    return Array.from(this.adapters.values());
  }

  names(): string[] {
    return Array.from(this.adapters.keys());
  }
}
