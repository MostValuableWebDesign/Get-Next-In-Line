import { pgTable, serial, text, boolean, integer, timestamp, unique, index } from "drizzle-orm/pg-core";
import { tenantsTable } from "./agency";

// ── Users & tenant memberships ───────────────────────────────────────────────
// Authorization model for the operator console: a user is either a platform
// admin (full access to every tenant — agency console, tenant management,
// module provisioning) or a plain member of specific tenants. Tenant-scoped
// API routes verify the session user's membership against every tenant the
// request references (header, URL param, or body) before the handler runs.
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  // Stable machine-friendly identity, e.g. "operator" for the seeded
  // platform operator that password login maps to.
  username: text("username").notNull().unique(),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  // Optional programmatic login credential (random, unguessable). There is
  // no user-management UI yet — memberships and tokens are seeded
  // programmatically (tests, scripts). Null = user cannot log in by token.
  loginToken: text("login_token").unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type User = typeof usersTable.$inferSelect;
export type InsertUser = typeof usersTable.$inferInsert;

export const userTenantMembershipsTable = pgTable(
  "user_tenant_memberships",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("user_tenant_memberships_user_tenant_uq").on(t.userId, t.tenantId),
    index("user_tenant_memberships_user_idx").on(t.userId),
  ],
);

export type UserTenantMembership = typeof userTenantMembershipsTable.$inferSelect;
