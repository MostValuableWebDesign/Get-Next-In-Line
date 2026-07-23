ALTER TABLE "messages" ADD COLUMN "origin" text DEFAULT 'operational' NOT NULL;
--> statement-breakpoint
UPDATE "messages" SET "origin" = 'concierge' WHERE "tenant_id" IS NOT NULL;--> statement-breakpoint
UPDATE "messages" SET "tenant_id" = c."tenant_id" FROM "sos_customers" c WHERE "messages"."origin" = 'operational' AND "messages"."customer_id" = c."id" AND c."tenant_id" IS NOT NULL;
