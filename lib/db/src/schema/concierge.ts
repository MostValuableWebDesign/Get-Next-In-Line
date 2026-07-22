import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./agency";

// ── AI Concierge & Automation module ─────────────────────────────────────────
// Per-tenant client profiles, configurable engagement rules, and a
// message-dispatch audit log that backs the concierge endpoints and the
// background reminder/rebooking worker.

export const clientProfilesTable = pgTable(
  "client_profiles",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    // sms | email | voice — only SMS is dispatched today; the rest are stored
    // for future channel support.
    preferredChannel: text("preferred_channel").notNull().default("sms"),
    smsOptIn: boolean("sms_opt_in").notNull().default(true),
    lastVisitAt: timestamp("last_visit_at"),
    nextVisitAt: timestamp("next_visit_at"),
    averageCycleDays: integer("average_cycle_days"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Reminder scans: upcoming appointments per tenant
    index("client_profiles_tenant_next_visit_idx").on(t.tenantId, t.nextVisitAt),
    // Rebooking scans: overdue clients per tenant
    index("client_profiles_tenant_last_visit_idx").on(t.tenantId, t.lastVisitAt),
  ],
);

export const insertClientProfileSchema = createInsertSchema(clientProfilesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertClientProfile = z.infer<typeof insertClientProfileSchema>;
export type ClientProfile = typeof clientProfilesTable.$inferSelect;

export const engagementRulesTable = pgTable(
  "engagement_rules",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // reminder | rebooking_nudge | upsell
    ruleType: text("rule_type").notNull(),
    // Rule-type-specific configuration, e.g.
    //   reminder:        { leadHours, template }
    //   rebooking_nudge: { cooldownDays, template }
    //   upsell:          { addOns: [{ name, price?, compatibleServices: [...] }] }
    config: jsonb("config").notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("engagement_rules_tenant_rule_type_idx").on(t.tenantId, t.ruleType)],
);

export const insertEngagementRuleSchema = createInsertSchema(engagementRulesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEngagementRule = z.infer<typeof insertEngagementRuleSchema>;
export type EngagementRule = typeof engagementRulesTable.$inferSelect;

export const messageLogsTable = pgTable(
  "message_logs",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    clientProfileId: integer("client_profile_id").references(
      () => clientProfilesTable.id,
      { onDelete: "set null" },
    ),
    ruleId: integer("rule_id").references(() => engagementRulesTable.id, {
      onDelete: "set null",
    }),
    // manual | send_reminder | rebooking_nudge
    jobType: text("job_type").notNull().default("manual"),
    // sms (only channel dispatched today)
    channel: text("channel").notNull().default("sms"),
    toNumber: text("to_number"),
    // Message body plus any structured context the dispatch was based on.
    payload: jsonb("payload").notNull().default({}),
    // pending | sent | simulated | failed | skipped
    status: text("status").notNull().default("pending"),
    providerMessageId: text("provider_message_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("message_logs_tenant_created_idx").on(t.tenantId, t.createdAt.desc()),
    // Dedupe lookups: latest log per client per job type
    index("message_logs_client_job_created_idx").on(
      t.clientProfileId,
      t.jobType,
      t.createdAt.desc(),
    ),
  ],
);

export const insertMessageLogSchema = createInsertSchema(messageLogsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertMessageLog = z.infer<typeof insertMessageLogSchema>;
export type MessageLog = typeof messageLogsTable.$inferSelect;
