ALTER TABLE "workforce_staff_links" DROP CONSTRAINT "workforce_staff_links_workforce_person_id_workforce_people_id_fk";
--> statement-breakpoint
ALTER TABLE "workforce_staff_links" DROP CONSTRAINT "workforce_staff_links_gnil_staff_id_sos_staff_members_id_fk";
--> statement-breakpoint
ALTER TABLE "workforce_staff_links" DROP CONSTRAINT "workforce_staff_links_gnil_resource_id_sos_resources_id_fk";
--> statement-breakpoint
ALTER TABLE "sos_resources" ADD CONSTRAINT "sos_resources_tenant_id_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "sos_staff_members" ADD CONSTRAINT "sos_staff_members_tenant_id_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "workforce_people" ADD CONSTRAINT "workforce_people_tenant_id_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "workforce_staff_links" ADD CONSTRAINT "workforce_staff_links_person_tenant_fk" FOREIGN KEY ("tenant_id","workforce_person_id") REFERENCES "public"."workforce_people"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_staff_links" ADD CONSTRAINT "workforce_staff_links_staff_tenant_fk" FOREIGN KEY ("tenant_id","gnil_staff_id") REFERENCES "public"."sos_staff_members"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_staff_links" ADD CONSTRAINT "workforce_staff_links_resource_tenant_fk" FOREIGN KEY ("tenant_id","gnil_resource_id") REFERENCES "public"."sos_resources"("tenant_id","id") ON DELETE cascade ON UPDATE no action;