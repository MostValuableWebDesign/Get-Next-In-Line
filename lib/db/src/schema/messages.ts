import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./agency";
import { sosCustomersTable } from "./sos";
import { clientProfilesTable, engagementRulesTable } from "./concierge";

// ── Unified messaging table ──────────────────────────────────────────────────
// Single source of truth for every inbound and outbound message across the
// platform: SOS operational texts (waitlist fills, "you're next", AI
// receptionist follow-ups, manual sends, inbound replies) and concierge
// automation sends (reminders, rebooking nudges, manual dispatches).
// Replaces the retired sos_messages and message_logs tables.

export const messagesTable = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    // Tenant scope. Null for legacy single-tenant SOS operational messages.
    tenantId: integer("tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    // Operational (SOS) customer the message belongs to, when known.
    customerId: integer("customer_id").references(() => sosCustomersTable.id, {
      onDelete: "set null",
    }),
    // Marketing (concierge) client profile the message belongs to, when known.
    clientProfileId: integer("client_profile_id").references(
      () => clientProfilesTable.id,
      { onDelete: "set null" },
    ),
    // Engagement rule that triggered an automated send, when applicable.
    ruleId: integer("rule_id").references(() => engagementRulesTable.id, {
      onDelete: "set null",
    }),
    // What surface the message belongs to:
    //   operational — SOS operational texts (queue, waitlist, receptionist,
    //     manual sends, inbound replies)
    //   concierge   — concierge automation sends (reminders, nudges)
    // Classification lives here so tenant_id can be stamped on operational
    // sends too (it used to be NULL as the operational marker).
    origin: text("origin").notNull().default("operational"),
    // outbound | inbound
    direction: text("direction").notNull().default("outbound"),
    // What produced the message:
    //   you_are_next | slot_open | ai_followup | manual | claim_confirmation |
    //   inbound | send_reminder | rebooking_nudge
    kind: text("kind").notNull().default("manual"),
    // sms (only channel dispatched today) | email | voice (stored, not sent)
    channel: text("channel").notNull().default("sms"),
    // Counterparty number: recipient for outbound, sender for inbound.
    toNumber: text("to_number"),
    body: text("body").notNull().default(""),
    // Structured context the dispatch was based on (templates, rule inputs…).
    payload: jsonb("payload").notNull().default({}),
    // pending | sent | delivered | failed | simulated | skipped | received
    status: text("status").notNull().default("pending"),
    providerSid: text("provider_sid"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("messages_created_idx").on(t.createdAt.desc()),
    index("messages_customer_created_idx").on(t.customerId, t.createdAt.desc()),
    index("messages_tenant_created_idx").on(t.tenantId, t.createdAt.desc()),
    // Dedupe lookups: latest message per client per kind (worker cooldowns)
    index("messages_client_kind_created_idx").on(
      t.clientProfileId,
      t.kind,
      t.createdAt.desc(),
    ),
  ],
);

export const insertMessageSchema = createInsertSchema(messagesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messagesTable.$inferSelect;
