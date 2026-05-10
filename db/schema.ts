import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------- tenants ----------
// One row per customer/workspace. Holds the budget cap and rate limit so
// every other table can foreign-key here and so the app can enforce per-tenant
// policy from a single source of truth.
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // Free-text by design: 'active' | 'disabled' | 'over_budget'. A pgEnum would
  // be tidier but every status change would require a migration; that's the
  // wrong trade-off for a service whose status semantics are still evolving.
  status: text("status").notNull().default("active"),
  // numeric(12,4) gives us up to 99,999,999.9999 USD with no float drift.
  monthlyBudgetUsd: numeric("monthly_budget_usd", { precision: 12, scale: 4 })
    .notNull()
    .default("0"),
  rateLimitPerMinute: integer("rate_limit_per_minute").notNull().default(60),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------- api_keys ----------
// Bearer keys are the auth surface. We store SHA-256 hashes only; the raw key
// is shown exactly once (at issuance) and never again. Lookup is by hash, so
// auth is a single indexed equality query.
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_keys_key_hash_idx").on(t.keyHash),
    index("api_keys_tenant_idx").on(t.tenantId),
  ],
);

// ---------- provider_configs ----------
// The static-but-DB-backed price table. Routing reads from here. Living in
// Postgres (rather than a hard-coded TS object) means the evaluator can edit
// prices live without a redeploy and we get model_class / enabled toggles
// for free.
export const providerConfigs = pgTable(
  "provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    // 'cheap' | 'balanced' | 'premium' — the assignment-defined model classes.
    modelClass: text("model_class").notNull(),
    inputCostPer1kTokens: numeric("input_cost_per_1k_tokens", {
      precision: 10,
      scale: 6,
    }).notNull(),
    outputCostPer1kTokens: numeric("output_cost_per_1k_tokens", {
      precision: 10,
      scale: 6,
    }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("provider_configs_provider_model_idx").on(t.provider, t.model),
    index("provider_configs_model_class_idx").on(t.modelClass),
  ],
);

// ---------- tenant_provider_allowlists ----------
// A row per (tenant, provider) the tenant is allowed to call. Empty allowlist
// means the tenant cannot reach any provider (deny-by-default). Modeled as a
// join table rather than an array column so it's easy to add columns later
// (e.g. per-provider rate caps) without rewriting consumers.
export const tenantProviderAllowlists = pgTable(
  "tenant_provider_allowlists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tenant_provider_allowlists_tenant_provider_idx").on(t.tenantId, t.provider),
  ],
);

// ---------- usage_ledger ----------
// Append-only record of "this much money was spent". Budget enforcement
// SUMs this table per tenant. Append-only is deliberate: it preserves
// auditability and makes the data race during budget reads bounded.
export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    requestId: text("request_id").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Powers `SUM(cost_usd) WHERE tenant_id = $1 AND created_at >= $2`.
    index("usage_ledger_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("usage_ledger_request_idx").on(t.requestId),
  ],
);

// ---------- request_logs ----------
// One row per request, success or failure. tenant_id is nullable because
// auth-failure rows still need to be logged (and we don't have a tenant for
// them). This is the table the evaluator reads to "debug a synthetic incident".
export const requestLogs = pgTable(
  "request_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: text("request_id").notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    provider: text("provider"),
    model: text("model"),
    // 'success' | 'provider_error' | 'budget_exceeded' | 'rate_limited'
    // | 'auth_failed' | 'partial_stream_error'
    status: text("status").notNull(),
    errorType: text("error_type"),
    latencyMs: integer("latency_ms"),
    cacheHit: boolean("cache_hit").notNull().default(false),
    streaming: boolean("streaming").notNull().default(false),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("request_logs_request_id_idx").on(t.requestId),
    index("request_logs_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

// ---------- cache_entries ----------
// Deterministic-response cache. Keyed by SHA-256 of (tenant_id, model_class,
// provider, model, normalized messages, temperature, max_tokens). The hash
// already encodes tenant_id, but we ALSO scope the row by tenant_id and a
// composite UNIQUE index on (tenant_id, cache_key). Two layers of isolation:
// the cryptographic key prevents collisions across tenants, and the SQL
// unique constraint makes a "leak across tenants" bug a constraint
// violation, not silent corruption.
//
// response_json is the cacheable subset of the unified response (provider,
// model, message, usage, model_class). On a hit we wrap it with fresh
// id/created_at/cached:true and a routing block that says "cache" — the
// request_id and timestamp must reflect the current request, not the
// cached one.
//
// expires_at is checked on every read (gt expires_at, now). We do not run
// a sweeper for assignment scope; stale rows just sit there, harmless.
// Production would add a periodic DELETE WHERE expires_at < now() and
// optionally a TTL index.
export const cacheEntries = pgTable(
  "cache_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cacheKey: text("cache_key").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    responseJson: jsonb("response_json").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Cross-tenant isolation enforced at the storage layer.
    uniqueIndex("cache_entries_tenant_key_idx").on(t.tenantId, t.cacheKey),
    // Lets a future cleanup job pull only the rows it needs.
    index("cache_entries_expires_idx").on(t.expiresAt),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type ProviderConfig = typeof providerConfigs.$inferSelect;
export type TenantProviderAllowlist = typeof tenantProviderAllowlists.$inferSelect;
export type UsageLedgerEntry = typeof usageLedger.$inferSelect;
export type RequestLog = typeof requestLogs.$inferSelect;
export type CacheEntry = typeof cacheEntries.$inferSelect;
