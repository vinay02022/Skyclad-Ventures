import { and, eq } from "drizzle-orm";

import type { Database } from "../../../db/client.js";
import { providerConfigs } from "../../../db/schema.js";

export interface ModelPrice {
  inputCostPer1k: number;
  outputCostPer1k: number;
}

export interface ModelClassRow {
  provider: string;
  model: string;
  inputCostPer1k: number;
  outputCostPer1k: number;
}

// All price reads go through here. Keeps the SQL in one place and gives the
// chat handler a tiny in-process cache so a hot path of identical
// (provider, model) requests does not hammer Postgres for static numbers.
export class PricingRepository {
  private readonly cache = new Map<string, ModelPrice>();
  private readonly classCache = new Map<string, ModelClassRow[]>();

  constructor(private readonly db: Database) {}

  /**
   * List all enabled (provider, model) pairs for a given model_class.
   * The router uses this to enumerate candidates. Results are cached
   * in-process; provider_configs is rarely changed at runtime, and a
   * full reload at deploy time is fine. clearCache() drops everything
   * for tests and hot-reload paths.
   */
  async listEnabledByModelClass(modelClass: string): Promise<ModelClassRow[]> {
    const cached = this.classCache.get(modelClass);
    if (cached) return cached;

    const rows = await this.db
      .select({
        provider: providerConfigs.provider,
        model: providerConfigs.model,
        input: providerConfigs.inputCostPer1kTokens,
        output: providerConfigs.outputCostPer1kTokens,
      })
      .from(providerConfigs)
      .where(and(eq(providerConfigs.modelClass, modelClass), eq(providerConfigs.enabled, true)));

    const out: ModelClassRow[] = rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      inputCostPer1k: Number(r.input),
      outputCostPer1k: Number(r.output),
    }));
    this.classCache.set(modelClass, out);
    return out;
  }

  async getPrice(provider: string, model: string): Promise<ModelPrice | null> {
    const key = `${provider}::${model}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const rows = await this.db
      .select({
        input: providerConfigs.inputCostPer1kTokens,
        output: providerConfigs.outputCostPer1kTokens,
      })
      .from(providerConfigs)
      .where(and(eq(providerConfigs.provider, provider), eq(providerConfigs.model, model)))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const price: ModelPrice = {
      inputCostPer1k: Number(row.input),
      outputCostPer1k: Number(row.output),
    };
    this.cache.set(key, price);
    return price;
  }

  // Drops both caches. Useful for tests that mutate provider_configs and for
  // a future hot-reload endpoint when prices change.
  clearCache(): void {
    this.cache.clear();
    this.classCache.clear();
  }
}

export function calculateCost(
  price: ModelPrice,
  usage: { input_tokens: number; output_tokens: number },
): number {
  const cost =
    (price.inputCostPer1k * usage.input_tokens + price.outputCostPer1k * usage.output_tokens) /
    1000;
  // Round to 6 decimals to match the numeric(12,6) DB precision; avoids
  // pointless float noise leaking into responses.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
