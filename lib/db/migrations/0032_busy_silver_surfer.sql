CREATE TABLE "platform_invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"inviter_tenant_id" integer NOT NULL,
	"invited_business_name" text NOT NULL,
	"invited_contact" text,
	"token" text NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"resulting_tenant_id" integer,
	"expires_at" timestamp NOT NULL,
	"clicked_at" timestamp,
	"registered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "platform_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "platform_invites" ADD CONSTRAINT "platform_invites_inviter_tenant_id_tenants_id_fk" FOREIGN KEY ("inviter_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_invites" ADD CONSTRAINT "platform_invites_resulting_tenant_id_tenants_id_fk" FOREIGN KEY ("resulting_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_invites_inviter_idx" ON "platform_invites" USING btree ("inviter_tenant_id");