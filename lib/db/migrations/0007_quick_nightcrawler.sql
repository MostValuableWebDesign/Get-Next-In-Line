ALTER TABLE "sos_customers" ADD COLUMN "client_profile_id" integer;--> statement-breakpoint
ALTER TABLE "sos_customers" ADD CONSTRAINT "sos_customers_client_profile_id_client_profiles_id_fk" FOREIGN KEY ("client_profile_id") REFERENCES "public"."client_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "sos_customers" sc
SET "client_profile_id" = m.pid
FROM (
  SELECT sc2.id AS cid, MIN(cp.id) AS pid
  FROM "sos_customers" sc2
  JOIN "client_profiles" cp
    ON RIGHT(regexp_replace(cp.phone, '\D', '', 'g'), 10) = RIGHT(regexp_replace(sc2.phone, '\D', '', 'g'), 10)
  WHERE sc2."client_profile_id" IS NULL
    AND cp.phone IS NOT NULL
    AND length(regexp_replace(sc2.phone, '\D', '', 'g')) >= 10
  GROUP BY sc2.id
  HAVING COUNT(DISTINCT cp.id) = 1
) m
WHERE sc.id = m.cid;
