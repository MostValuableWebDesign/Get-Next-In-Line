import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { tenantsTable, merchantCoopPartnershipsTable } from "./agency";

// ── Customer Loyalty & Cross-Perk Wallet ─────────────────────────────────────
// Consumer-facing "Local Perks" wallet: customers are identified by phone
// number (E.164) — no staff-side account. Perk passes are auto-deposited when
// a visit checks out at a business with accepted+active co-op partnerships,
// and redeemed once at the partner storefront via an unguessable token.

// One perk pass owned by a customer phone for one partnership. The token is
// the QR payload staff scan at the partner storefront; single-use redemption
// is enforced by the conditional `redeemed_at IS NULL` update in the
// redemption route, not by application-level checks.
export const perkPassesTable = pgTable(
  "perk_passes",
  {
    id: serial("id").primaryKey(),
    partnershipId: integer("partnership_id")
      .notNull()
      .references(() => merchantCoopPartnershipsTable.id, { onDelete: "cascade" }),
    // Wallet owner — always stored normalized (E.164) so lookups by login
    // phone match grants made from checkout records.
    customerPhone: text("customer_phone").notNull(),
    customerName: text("customer_name"),
    // Tenant whose checkout deposited the pass (NULL if tenant deleted).
    grantedByTenantId: integer("granted_by_tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    // Unguessable redemption token (prefixed "WPASS-"), encoded in the QR.
    token: text("token").notNull().unique(),
    grantedAt: timestamp("granted_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    redeemedAt: timestamp("redeemed_at"),
    redeemedByTenantId: integer("redeemed_by_tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    // Stamped when the one-and-only expiry reminder SMS was claimed/sent.
    reminderSentAt: timestamp("reminder_sent_at"),
  },
  (t) => [
    index("perk_passes_phone_idx").on(t.customerPhone),
    index("perk_passes_partnership_phone_idx").on(t.partnershipId, t.customerPhone),
    // Supports the expiry-reminder sweep (unreminded, unredeemed, expiring soon).
    index("perk_passes_expires_idx").on(t.expiresAt),
  ]
);

export type PerkPass = typeof perkPassesTable.$inferSelect;
export type InsertPerkPass = typeof perkPassesTable.$inferInsert;

// One SMS login code request for the wallet. Codes are short-lived, capped on
// verify attempts, and single-use (consumed_at).
export const walletLoginCodesTable = pgTable(
  "wallet_login_codes",
  {
    id: serial("id").primaryKey(),
    phone: text("phone").notNull(),
    code: text("code").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("wallet_login_codes_phone_idx").on(t.phone, t.createdAt.desc())]
);

export type WalletLoginCode = typeof walletLoginCodesTable.$inferSelect;

// A verified wallet session: bearer token handed to the customer's browser
// after SMS verification. Long-lived but expiring; token is unguessable.
export const walletSessionsTable = pgTable(
  "wallet_sessions",
  {
    id: serial("id").primaryKey(),
    token: text("token").notNull().unique(),
    phone: text("phone").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("wallet_sessions_phone_idx").on(t.phone)]
);

export type WalletSession = typeof walletSessionsTable.$inferSelect;
