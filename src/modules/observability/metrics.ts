import { Registry, collectDefaultMetrics } from "prom-client";

// Single shared registry. Feature modules register their own counters/histograms
// against this in later phases (request count, token usage, breaker state, etc.).
export const registry = new Registry();
registry.setDefaultLabels({ service: "skyclad-gateway" });

collectDefaultMetrics({ register: registry });
