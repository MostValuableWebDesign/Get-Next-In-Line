import { pgTable, serial, text, integer, timestamp, unique, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable, modulesTable } from "./agency";

/**
 * Per-tenant partner connection state for Partner-Direct Integration modules.
 *
 * One row per (tenant, module). tenantId NULL follows the platform's legacy
 * convention: rows without a tenant belong to the agency-level (default)
 * workspace — the same strict NULL-vs-tenant matching used by SOS tables.
 *
 * Credential tokens are stored ENCRYPTED at rest (AES-256-GCM, key derived
 * server-side) and must NEVER be returned by any API response.
 */
export const partnerConnectionsTable = pgTable(
  "partner_connections",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").references(() => tenantsTable.id, { onDelete: "cascade" }),
    moduleId: integer("module_id")
      .notNull()
      .references(() => modulesTable.id, { onDelete: "cascade" }),
    // not_connected | pending | active | error
    status: text("status").notNull().default("not_connected"),
    // One-time OAuth handshake state token; set while status is pending,
    // cleared on callback completion.
    oauthState: text("oauth_state"),
    // ── Encrypted credentials — server-side only, never exposed to clients ──
    accessTokenEncrypted: text("access_token_encrypted"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    // Webhook signing secret (HMAC-SHA256 over the raw request body), issued
    // at authorization time. Encrypted at rest; NEVER returned by any API
    // response — the sandbox gateway hands it to the partner out-of-band.
    webhookSecretEncrypted: text("webhook_secret_encrypted"),
    lastSyncAt: timestamp("last_sync_at"),
    connectedAt: timestamp("connected_at"),
    // Human-readable reason when status is "error".
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT so the agency-level (tenant_id NULL) workspace also
    // gets at most one connection row per module.
    unique("partner_connections_tenant_module_unique").on(t.tenantId, t.moduleId).nullsNotDistinct(),
  ]
);

export const insertPartnerConnectionSchema = createInsertSchema(partnerConnectionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPartnerConnection = z.infer<typeof insertPartnerConnectionSchema>;
export type PartnerConnection = typeof partnerConnectionsTable.$inferSelect;

/**
 * Audit log of partner connection lifecycle events (initiated, authorized,
 * webhook received, disconnected, errors). Append-only.
 */
export const partnerConnectionEventsTable = pgTable(
  "partner_connection_events",
  {
    id: serial("id").primaryKey(),
    connectionId: integer("connection_id")
      .notNull()
      .references(() => partnerConnectionsTable.id, { onDelete: "cascade" }),
    // e.g. connection_initiated | connection_authorized | connection_error |
    //      webhook_received | disconnected
    eventType: text("event_type").notNull(),
    details: text("details"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("partner_connection_events_connection_created_idx").on(
      t.connectionId,
      t.createdAt.desc(),
      t.id.desc()
    ),
  ]
);

export const insertPartnerConnectionEventSchema = createInsertSchema(
  partnerConnectionEventsTable
).omit({ id: true, createdAt: true });
export type InsertPartnerConnectionEvent = z.infer<typeof insertPartnerConnectionEventSchema>;
export type PartnerConnectionEvent = typeof partnerConnectionEventsTable.$inferSelect;
