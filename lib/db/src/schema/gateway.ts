import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./agency";

/**
 * Co-Op API Gateway — tokenized developer access for third-party systems.
 *
 * gateway_api_tokens: bearer tokens that external callers present on the
 * public /v1/gateway/* endpoints. The token value is shown to the merchant
 * exactly once at creation/rotation and is persisted only as a one-way
 * SHA-256 hash (never plaintext, never recoverable — strictly stronger than
 * reversible encryption). Each token is bound to exactly one tenant scope
 * (tenantId NULL = legacy agency-level workspace, matching platform
 * convention), so a token can never read or write another tenant's data.
 *
 * gateway_api_calls: audit log of every authenticated (or auth-rejected)
 * call to the public gateway surface, viewable by the owning merchant.
 */
export const gatewayApiTokensTable = pgTable(
  "gateway_api_tokens",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").references(() => tenantsTable.id, { onDelete: "cascade" }),
    // Merchant-chosen label ("Front desk iPad", "Acme POS bridge", …).
    label: text("label").notNull(),
    // SHA-256 hex digest of the bearer token — the lookup key.
    tokenHash: text("token_hash").notNull().unique(),
    // Non-secret display prefix (e.g. "gwk_test_3fa9…") for the token list.
    tokenPrefix: text("token_prefix").notNull(),
    // Sandbox tokens exercise the same endpoints against isolated test data;
    // they can never touch live perks, rewards, or customer records.
    sandbox: boolean("sandbox").notNull().default(false),
    // active | revoked
    status: text("status").notNull().default("active"),
    lastUsedAt: timestamp("last_used_at"),
    rotatedAt: timestamp("rotated_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("gateway_api_tokens_tenant_idx").on(t.tenantId)]
);

export const insertGatewayApiTokenSchema = createInsertSchema(gatewayApiTokensTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertGatewayApiToken = z.infer<typeof insertGatewayApiTokenSchema>;
export type GatewayApiToken = typeof gatewayApiTokensTable.$inferSelect;

export const gatewayApiCallsTable = pgTable(
  "gateway_api_calls",
  {
    id: serial("id").primaryKey(),
    // Null when the call failed authentication (no token resolved).
    tokenId: integer("token_id").references(() => gatewayApiTokensTable.id, {
      onDelete: "cascade",
    }),
    tenantId: integer("tenant_id").references(() => tenantsTable.id, { onDelete: "cascade" }),
    method: text("method").notNull(),
    path: text("path").notNull(),
    httpStatus: integer("http_status").notNull(),
    // ok | auth_failed | invalid | not_found | rejected | error
    outcome: text("outcome").notNull(),
    // Human-readable result/error detail for the merchant log.
    detail: text("detail"),
    sandbox: boolean("sandbox").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("gateway_api_calls_tenant_created_idx").on(t.tenantId, t.createdAt.desc(), t.id.desc()),
  ]
);

export const insertGatewayApiCallSchema = createInsertSchema(gatewayApiCallsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertGatewayApiCall = z.infer<typeof insertGatewayApiCallSchema>;
export type GatewayApiCall = typeof gatewayApiCallsTable.$inferSelect;
