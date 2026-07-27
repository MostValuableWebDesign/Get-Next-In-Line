import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./agency";
import { sosVisitsTable, sosCustomersTable } from "./sos";

/**
 * External POS webhook connectors (Square, Clover, Boulevard, Vagaro).
 *
 * One integration row per (tenant, vendor). tenantId NULL follows the
 * platform's legacy convention (agency-level workspace, strict NULL-vs-tenant
 * matching, same as SOS tables).
 *
 * The webhook signing secret is stored ENCRYPTED at rest (AES-256-GCM via
 * partnerCrypto) and is only ever returned to the authenticated merchant who
 * owns the integration — never on webhook or public surfaces.
 */
export const posIntegrationsTable = pgTable(
  "pos_integrations",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").references(() => tenantsTable.id, { onDelete: "cascade" }),
    // square | clover | boulevard | vagaro
    vendor: text("vendor").notNull(),
    // active | disabled
    status: text("status").notNull().default("active"),
    // Unguessable URL token identifying this integration on its webhook
    // endpoint path — it resolves tenant scope without any header.
    webhookToken: text("webhook_token").notNull().unique(),
    // Vendor webhook signing secret, encrypted at rest.
    signingSecretEncrypted: text("signing_secret_encrypted").notNull(),
    lastEventAt: timestamp("last_event_at"),
    // Human-readable reason for the most recent processing failure, if any.
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT so the agency-level (tenant_id NULL) workspace also
    // gets at most one integration per vendor.
    unique("pos_integrations_tenant_vendor_unique").on(t.tenantId, t.vendor).nullsNotDistinct(),
  ]
);

export const insertPosIntegrationSchema = createInsertSchema(posIntegrationsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPosIntegration = z.infer<typeof insertPosIntegrationSchema>;
export type PosIntegration = typeof posIntegrationsTable.$inferSelect;

/**
 * Inspectable inbound POS event log. Every webhook delivery that passes
 * signature verification lands here — including unrecognized or malformed
 * events (status "unrecognized"/"invalid"/"error") — nothing is silently
 * dropped. The unique (integration, external event id) pair is the
 * idempotency lock under vendor retries.
 */
export const posInboundEventsTable = pgTable(
  "pos_inbound_events",
  {
    id: serial("id").primaryKey(),
    integrationId: integer("integration_id")
      .notNull()
      .references(() => posIntegrationsTable.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id").references(() => tenantsTable.id, { onDelete: "cascade" }),
    // square | clover | boulevard | vagaro
    vendor: text("vendor").notNull(),
    // Vendor-supplied event id used for idempotent processing under retries.
    externalEventId: text("external_event_id").notNull(),
    // Normalized platform event kind:
    // check_in | service_completed | perk_redeemed | unknown
    eventKind: text("event_kind").notNull(),
    // processed | ignored | unrecognized | invalid | error
    status: text("status").notNull(),
    // Raw vendor payload (JSON string) for inspection/debugging.
    payload: text("payload").notNull(),
    // Human-readable processing outcome/error detail.
    detail: text("detail"),
    // Platform effects, when the event produced/advanced them.
    customerId: integer("customer_id").references(() => sosCustomersTable.id, {
      onDelete: "set null",
    }),
    visitId: integer("visit_id").references(() => sosVisitsTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("pos_inbound_events_integration_external_unique").on(t.integrationId, t.externalEventId),
    index("pos_inbound_events_integration_created_idx").on(
      t.integrationId,
      t.createdAt.desc(),
      t.id.desc()
    ),
  ]
);

export const insertPosInboundEventSchema = createInsertSchema(posInboundEventsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPosInboundEvent = z.infer<typeof insertPosInboundEventSchema>;
export type PosInboundEvent = typeof posInboundEventsTable.$inferSelect;
