CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer,
	"customer_id" integer,
	"client_profile_id" integer,
	"rule_id" integer,
	"direction" text DEFAULT 'outbound' NOT NULL,
	"kind" text DEFAULT 'manual' NOT NULL,
	"channel" text DEFAULT 'sms' NOT NULL,
	"to_number" text,
	"body" text DEFAULT '' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_sid" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_customer_id_sos_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."sos_customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_client_profile_id_client_profiles_id_fk" FOREIGN KEY ("client_profile_id") REFERENCES "public"."client_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_rule_id_engagement_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."engagement_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_created_idx" ON "messages" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_customer_created_idx" ON "messages" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_tenant_created_idx" ON "messages" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_client_kind_created_idx" ON "messages" USING btree ("client_profile_id","kind","created_at" DESC NULLS LAST);--> statement-breakpoint
-- Data migration: copy every row from the two legacy tables into the unified
-- "messages" table, ordered by original creation time.
-- sos_messages rows with kind='concierge' are excluded: each of those sends
-- was double-recorded (a richer message_logs row exists for the same send),
-- so keeping both would duplicate concierge history.
INSERT INTO "messages" (
  "tenant_id", "customer_id", "client_profile_id", "rule_id",
  "direction", "kind", "channel", "to_number", "body", "payload",
  "status", "provider_sid", "error_code", "error_message",
  "created_at", "updated_at"
)
SELECT u.* FROM (
  SELECT
    NULL::integer AS tenant_id,
    m."customer_id",
    NULL::integer AS client_profile_id,
    NULL::integer AS rule_id,
    m."direction",
    m."kind",
    'sms' AS channel,
    m."to_number",
    m."body",
    '{}'::jsonb AS payload,
    m."delivery_status" AS status,
    m."provider_sid",
    m."error_code",
    m."error_message",
    m."created_at",
    m."created_at" AS updated_at
  FROM "sos_messages" m
  WHERE m."kind" <> 'concierge'
  UNION ALL
  SELECT
    l."tenant_id",
    NULL::integer AS customer_id,
    l."client_profile_id",
    l."rule_id",
    'outbound' AS direction,
    l."job_type" AS kind,
    l."channel",
    l."to_number",
    COALESCE(l."payload"->>'body', '') AS body,
    l."payload",
    l."status",
    l."provider_message_id" AS provider_sid,
    l."error_code",
    l."error_message",
    l."created_at",
    l."updated_at"
  FROM "message_logs" l
) u
ORDER BY u.created_at, u.tenant_id NULLS FIRST;
