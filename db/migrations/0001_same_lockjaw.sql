CREATE TABLE IF NOT EXISTS "cache_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cache_key" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"response_json" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cache_entries" ADD CONSTRAINT "cache_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cache_entries_tenant_key_idx" ON "cache_entries" USING btree ("tenant_id","cache_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cache_entries_expires_idx" ON "cache_entries" USING btree ("expires_at");