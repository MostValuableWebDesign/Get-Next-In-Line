import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./agency";

// ── Co-Op Emergency & Safety Alert Network ──────────────────────────────────
// Tenant-scoped safety incidents broadcast to a merchant's accepted, active
// co-op partner tenants. Sensitive free text (incident descriptions and
// status-update bodies) is encrypted at rest by the API layer using the same
// AES-256-GCM approach as partner credential tokens — the columns store the
// `v1:<iv>:<tag>:<ciphertext>` envelope, never plaintext.

export const safetyIncidentsTable = pgTable(
  "safety_incidents",
  {
    id: serial("id").primaryKey(),
    // The originating (raising) tenant. Always required — safety alerts are a
    // tenant-scoped co-op feature with no legacy NULL-tenant mode.
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // silent_panic | suspicious_activity | safety_hazard | medical_emergency | severe_weather
    incidentType: text("incident_type").notNull(),
    // Encrypted at rest (AES-256-GCM envelope written by the API layer).
    description: text("description").notNull(),
    // Optional human-entered location pin / address (not sensitive: it is the
    // business's own broadcast location, shown verbatim to partners).
    location: text("location"),
    // active | resolved
    status: text("status").notNull().default("active"),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("safety_incidents_tenant_idx").on(t.tenantId, t.createdAt.desc())]
);

// One row per partner tenant an incident was broadcast to; acknowledgment is
// recorded here (and mirrored into the timeline events table).
export const safetyIncidentRecipientsTable = pgTable(
  "safety_incident_recipients",
  {
    id: serial("id").primaryKey(),
    incidentId: integer("incident_id")
      .notNull()
      .references(() => safetyIncidentsTable.id, { onDelete: "cascade" }),
    recipientTenantId: integer("recipient_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    acknowledgedAt: timestamp("acknowledged_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("safety_incident_recipients_unique").on(t.incidentId, t.recipientTenantId),
    index("safety_incident_recipients_tenant_idx").on(t.recipientTenantId, t.createdAt.desc()),
  ]
);

// Append-only incident timeline: broadcast, status updates, acknowledgments,
// and the resolution. `body` (free text) is encrypted at rest like the
// incident description; structural events carry a NULL body.
export const safetyIncidentEventsTable = pgTable(
  "safety_incident_events",
  {
    id: serial("id").primaryKey(),
    incidentId: integer("incident_id")
      .notNull()
      .references(() => safetyIncidentsTable.id, { onDelete: "cascade" }),
    // Tenant that produced the event (originator for broadcast/update/resolve,
    // the acknowledging partner for acknowledgments).
    actorTenantId: integer("actor_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // broadcast | update | acknowledgment | resolution
    kind: text("kind").notNull(),
    // Encrypted at rest when present.
    body: text("body"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("safety_incident_events_incident_idx").on(t.incidentId, t.createdAt)]
);

// Per-tenant emergency contacts panel (one-touch tel: dialing in the UI).
export const safetyEmergencyContactsTable = pgTable(
  "safety_emergency_contacts",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    phone: text("phone").notNull(),
    // law_enforcement | medical | property_management | other
    category: text("category").notNull().default("other"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("safety_emergency_contacts_tenant_idx").on(t.tenantId)]
);

// Editable pre-configured broadcast templates used to pre-fill the alert
// composer. Template bodies are boilerplate (not incident-specific), so they
// are stored in plaintext.
export const safetyBroadcastTemplatesTable = pgTable(
  "safety_broadcast_templates",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    incidentType: text("incident_type").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("safety_broadcast_templates_tenant_idx").on(t.tenantId)]
);

// Marker: whether default contacts/templates were seeded for a tenant. Kept
// separate from the rows themselves so a merchant who deletes every default
// doesn't get them re-seeded on the next visit.
export const safetyDefaultsSeededTable = pgTable("safety_defaults_seeded", {
  tenantId: integer("tenant_id")
    .primaryKey()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  seededAt: timestamp("seeded_at").notNull().defaultNow(),
});

export const insertSafetyIncidentSchema = createInsertSchema(safetyIncidentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSafetyIncident = z.infer<typeof insertSafetyIncidentSchema>;
export type SafetyIncident = typeof safetyIncidentsTable.$inferSelect;
export type SafetyIncidentRecipient = typeof safetyIncidentRecipientsTable.$inferSelect;
export type SafetyIncidentEvent = typeof safetyIncidentEventsTable.$inferSelect;
export type SafetyEmergencyContact = typeof safetyEmergencyContactsTable.$inferSelect;
export type SafetyBroadcastTemplate = typeof safetyBroadcastTemplatesTable.$inferSelect;
