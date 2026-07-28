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
import { sql } from "drizzle-orm";
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
    // True when averageCycleDays was set by hand (API) — the automatic
    // visit-history cadence computation never overwrites overridden values.
    cycleOverride: boolean("cycle_override").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Reminder scans: upcoming appointments per tenant
    index("client_profiles_tenant_next_visit_idx").on(t.tenantId, t.nextVisitAt),
    // Rebooking scans: overdue clients per tenant
    index("client_profiles_tenant_last_visit_idx").on(t.tenantId, t.lastVisitAt),
    // Customer-link phone matching: bounded lookup by the last 10 digits of
    // the stored phone (see api-server lib/customerLink.ts findProfileByPhone).
    index("client_profiles_phone_digits_idx").using(
      "btree",
      sql`right(regexp_replace(${t.phone}, '\\D', '', 'g'), 10)`,
    ),
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
  (t) => [
    index("engagement_rules_tenant_rule_type_idx").on(t.tenantId, t.ruleType),
    // Worker scans: active rules of a type across all tenants (concierge tick).
    index("engagement_rules_rule_type_active_idx").on(t.ruleType, t.isActive),
  ],
);

export const insertEngagementRuleSchema = createInsertSchema(engagementRulesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEngagementRule = z.infer<typeof insertEngagementRuleSchema>;
export type EngagementRule = typeof engagementRulesTable.$inferSelect;

// NOTE: message dispatch history now lives in the unified "messages" table
// (see ./messages.ts); the old message_logs table has been retired.
