CREATE TABLE "gateway_api_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_id" integer,
	"tenant_id" integer,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"http_status" integer NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"sandbox" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_api_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"sandbox" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp,
	"rotated_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "gateway_api_calls" ADD CONSTRAINT "gateway_api_calls_token_id_gateway_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."gateway_api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_api_calls" ADD CONSTRAINT "gateway_api_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_api_tokens" ADD CONSTRAINT "gateway_api_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gateway_api_calls_tenant_created_idx" ON "gateway_api_calls" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gateway_api_tokens_tenant_idx" ON "gateway_api_tokens" USING btree ("tenant_id");