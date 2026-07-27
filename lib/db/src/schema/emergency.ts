import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./agency";

// ── Co-Op Emergency & Crisis Network Broadcast ──────────────────────────────
// Critical community alerts (severe weather closures, power outages, safety
// alerts, sudden schedule changes) pushed to a set of target tenants: a
// merchant "local leader" reaches their accepted co-op partner network, a
// platform admin reaches the whole platform or a selected list. Each targeted
// tenant is prompted to check in with a live status (open / temporarily
// closed / safe) that is visible to the network and on the public landing
// page while the broadcast is active.

export const emergencyBroadcastsTable = pgTable(
  "emergency_broadcasts",
  {
    id: serial("id").primaryKey(),
    // NULL = sent by a platform admin (no acting tenant); otherwise the
    // merchant local leader that composed the broadcast.
    senderTenantId: integer("sender_tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    // network (merchant → accepted co-op partners) | platform | selected
    scope: text("scope").notNull(),
    // info | warning | critical
    severity: text("severity").notNull(),
    // weather_closure | power_outage | safety_alert | schedule_change | other
    alertType: text("alert_type").notNull(),
    headline: text("headline").notNull(),
    message: text("message").notNull(),
    // active | resolved
    status: text("status").notNull().default("active"),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("emergency_broadcasts_status_idx").on(t.status, t.createdAt.desc())]
);

// One row per tenant a broadcast targets. `sms_dispatched_at` doubles as the
// fan-out send-once claim: the concierge-worker sweep stamps it conditionally
// before texting that tenant's subscribers, so a concurrent tick can never
// double-blast the same tenant.
export const emergencyBroadcastTargetsTable = pgTable(
  "emergency_broadcast_targets",
  {
    id: serial("id").primaryKey(),
    broadcastId: integer("broadcast_id")
      .notNull()
      .references(() => emergencyBroadcastsTable.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    smsDispatchedAt: timestamp("sms_dispatched_at"),
    smsSentCount: integer("sms_sent_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("emergency_broadcast_targets_unique").on(t.broadcastId, t.tenantId),
    index("emergency_broadcast_targets_tenant_idx").on(t.tenantId, t.createdAt.desc()),
  ]
);

// A targeted tenant's latest status check-in for a broadcast. One row per
// (broadcast, tenant) — re-checking in updates the row in place.
export const emergencyCheckinsTable = pgTable(
  "emergency_checkins",
  {
    id: serial("id").primaryKey(),
    broadcastId: integer("broadcast_id")
      .notNull()
      .references(() => emergencyBroadcastsTable.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // open | temporarily_closed | safe
    status: text("status").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("emergency_checkins_unique").on(t.broadcastId, t.tenantId),
    index("emergency_checkins_tenant_idx").on(t.tenantId),
  ]
);

export type EmergencyBroadcast = typeof emergencyBroadcastsTable.$inferSelect;
export type EmergencyBroadcastTarget = typeof emergencyBroadcastTargetsTable.$inferSelect;
export type EmergencyCheckin = typeof emergencyCheckinsTable.$inferSelect;
