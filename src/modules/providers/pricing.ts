import { and, eq } from "drizzle-orm";

import type { Database } from "../../../db/client.js";
import { providerConfigs } from "../../../db/schema.js";

export interface ModelPrice {
  inputCostPer1k: number;
  outputCostPer1k: number;
}

// All price reads go through here. Keeps the SQL in one place and gives the
// chat handler a tiny in-process cache so a hot path of identical
// (provider, model) requests does not hammer Postgres for static numbers.
export class PricingRepository {
  private readonly cache = new Map<string, ModelPrice>();

  constructor(private readonly db: Database) {}

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

  // Drops the cache. Useful for tests that mutate provider_configs and for
  // a future hot-reload endpoint when prices change.
  clearCache(): void {
    this.cache.clear();
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
