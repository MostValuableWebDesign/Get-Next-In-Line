import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { tenantsTable, coopPerkRedemptionsTable } from "./agency";

// ── Co-Op Neighborhood Passport & Achievements ───────────────────────────────
// Gamified consumer passport: every unique partner business where a customer
// redeems a co-op perk earns a stamp. Milestone challenges (N distinct
// businesses within M days) sponsored by merchants issue rewards exactly once
// per customer. Customer records are tenant-scoped, so the passport hangs off
// a cross-tenant identity keyed on normalized phone / lowercased email.

// One cross-tenant consumer identity. Phone (E.164) is the primary key in
// practice — the wallet is phone-keyed — with lowercased email as a fallback
// matcher for POS-sourced customers without a phone.
export const passportIdentitiesTable = pgTable(
  "passport_identities",
  {
    id: serial("id").primaryKey(),
    // Normalized E.164; NULL when only an email is known.
    phone: text("phone").unique(),
    // Lowercased; NULL when only a phone is known.
    email: text("email").unique(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
);

export type PassportIdentity = typeof passportIdentitiesTable.$inferSelect;

// One stamp per (identity, business). The unique pair is the "one stamp per
// unique partner business" rule — re-redemptions at the same business are
// no-ops via onConflictDoNothing.
export const passportStampsTable = pgTable(
  "passport_stamps",
  {
    id: serial("id").primaryKey(),
    identityId: integer("identity_id")
      .notNull()
      .references(() => passportIdentitiesTable.id, { onDelete: "cascade" }),
    // The business where the perk was redeemed (the stamp on the passport).
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // Redemption that earned the stamp (NULL if the ledger row is deleted).
    redemptionId: integer("redemption_id").references(() => coopPerkRedemptionsTable.id, {
      onDelete: "set null",
    }),
    stampedAt: timestamp("stamped_at").notNull().defaultNow(),
  },
  (t) => [
    unique("passport_stamps_identity_tenant_uq").on(t.identityId, t.tenantId),
    index("passport_stamps_identity_idx").on(t.identityId),
  ],
);

export type PassportStamp = typeof passportStampsTable.$inferSelect;

// Merchant-sponsored milestone challenge: redeem perks at N distinct partner
// businesses within a rolling M-day window, during the active date window.
export const passportChallengesTable = pgTable(
  "passport_challenges",
  {
    id: serial("id").primaryKey(),
    sponsorTenantId: integer("sponsor_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    // Milestone: N distinct businesses stamped within the rolling window.
    requiredBusinesses: integer("required_businesses").notNull(),
    windowDays: integer("window_days").notNull(),
    // bonus_perk | sweepstakes_entry | free_upgrade
    rewardType: text("reward_type").notNull(),
    // What the customer gets, in the sponsor's words (shown on the passport
    // and in the reward SMS).
    rewardDescription: text("reward_description").notNull(),
    // Optional active date window; NULL bounds are open-ended.
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("passport_challenges_sponsor_idx").on(t.sponsorTenantId)],
);

export type PassportChallenge = typeof passportChallengesTable.$inferSelect;

// Reward issuance ledger. The unique (challenge, identity) pair is the
// exactly-once lock: re-evaluation after later stamps hits the constraint and
// never issues a duplicate reward.
export const passportRewardIssuancesTable = pgTable(
  "passport_reward_issuances",
  {
    id: serial("id").primaryKey(),
    challengeId: integer("challenge_id")
      .notNull()
      .references(() => passportChallengesTable.id, { onDelete: "cascade" }),
    identityId: integer("identity_id")
      .notNull()
      .references(() => passportIdentitiesTable.id, { onDelete: "cascade" }),
    // Snapshot of the reward at completion time (survives later edits).
    rewardType: text("reward_type").notNull(),
    rewardDescription: text("reward_description").notNull(),
    // Distinct businesses counted inside the window at completion time.
    stampCount: integer("stamp_count").notNull(),
    issuedAt: timestamp("issued_at").notNull().defaultNow(),
  },
  (t) => [
    unique("passport_reward_issuances_challenge_identity_uq").on(t.challengeId, t.identityId),
    index("passport_reward_issuances_identity_idx").on(t.identityId),
  ],
);

export type PassportRewardIssuance = typeof passportRewardIssuancesTable.$inferSelect;
