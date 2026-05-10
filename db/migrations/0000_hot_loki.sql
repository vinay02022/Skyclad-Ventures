CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"model_class" text NOT NULL,
	"input_cost_per_1k_tokens" numeric(10, 6) NOT NULL,
	"output_cost_per_1k_tokens" numeric(10, 6) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "request_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"tenant_id" uuid,
	"provider" text,
	"model" text,
	"status" text NOT NULL,
	"error_type" text,
	"latency_ms" integer,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"streaming" boolean DEFAULT false NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_provider_allowlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"monthly_budget_usd" numeric(12, 4) DEFAULT '0' NOT NULL,
	"rate_limit_per_minute" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"request_id" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_provider_allowlists" ADD CONSTRAINT "tenant_provider_allowlists_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_tenant_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_configs_provider_model_idx" ON "provider_configs" USING btree ("provider","model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_configs_model_class_idx" ON "provider_configs" USING btree ("model_class");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_logs_request_id_idx" ON "request_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_logs_tenant_created_idx" ON "request_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_provider_allowlists_tenant_provider_idx" ON "tenant_provider_allowlists" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_ledger_tenant_created_idx" ON "usage_ledger" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_ledger_request_idx" ON "usage_ledger" USING btree ("request_id");