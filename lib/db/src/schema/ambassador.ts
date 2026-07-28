import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { tenantsTable, coopPerkRedemptionsTable } from "./agency";
import { passportIdentitiesTable } from "./passport";

// ── Co-Op Referral Loyalty & Tiered Ambassador Program ──────────────────────
// Builds on the Neighborhood Passport's cross-tenant identity (phone-keyed
// passport_identities): customers who redeem co-op perks across multiple
// partner businesses and refer friends advance through network-wide
// ambassador tiers. Opted-in merchants fund a shared reward pool (an internal
// ledger — no real money movement); referral conversions mint network-wide
// rewards for both parties, and reward redemptions debit the pool with the
// acquisition cost attributed to the business that received the referred
// foot traffic.

// Per-merchant program participation + pledge configuration. The pledge is a
// small fixed amount accrued into the shared pool for every co-op perk
// redemption recorded at the merchant's storefront.
export const ambassadorProgramSettingsTable = pgTable(
  "ambassador_program_settings",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .unique()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    optedIn: boolean("opted_in").notNull().default(false),
    // Pledged promotional budget accrued per co-op redemption at this
    // storefront, in dollars.
    pledgePerRedemption: numeric("pledge_per_redemption", { precision: 10, scale: 2 })
      .notNull()
      .default("1.00"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
);

export type AmbassadorProgramSettings = typeof ambassadorProgramSettingsTable.$inferSelect;

// Unified pool ledger. entry_type:
//   contribution     — credit; tenant_id is the contributing merchant.
//   reward_debit     — debit; tenant_id is the merchant the acquisition cost
//                      is attributed to (where the referred foot traffic
//                      converted), NOT necessarily where the reward was
//                      redeemed.
// Pool balance = sum(contributions) − sum(debits). Per-merchant contributed
// vs. benefit received are both derived from this one table.
export const ambassadorPoolEntriesTable = pgTable(
  "ambassador_pool_entries",
  {
    id: serial("id").primaryKey(),
    entryType: text("entry_type").notNull(), // contribution | reward_debit
    // Amounts are stored positive; entry_type carries the sign.
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    tenantId: integer("tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    identityId: integer("identity_id").references(() => passportIdentitiesTable.id, {
      onDelete: "set null",
    }),
    // Contribution idempotency: at most one pledge accrual per redemption.
    redemptionId: integer("redemption_id")
      .unique()
      .references(() => coopPerkRedemptionsTable.id, { onDelete: "set null" }),
    rewardId: integer("reward_id"),
    referralId: integer("referral_id"),
    description: text("description").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ambassador_pool_entries_tenant_idx").on(t.tenantId),
    // Debit idempotency: at most one pool debit per redeemed reward.
    unique("ambassador_pool_entries_reward_uq").on(t.rewardId),
  ],
);

export type AmbassadorPoolEntry = typeof ambassadorPoolEntriesTable.$inferSelect;

// One personal referral code per network identity.
export const ambassadorReferralCodesTable = pgTable(
  "ambassador_referral_codes",
  {
    id: serial("id").primaryKey(),
    identityId: integer("identity_id")
      .notNull()
      .unique()
      .references(() => passportIdentitiesTable.id, { onDelete: "cascade" }),
    code: text("code").notNull().unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
);

export type AmbassadorReferralCode = typeof ambassadorReferralCodesTable.$inferSelect;

// Referral loop: a friend attaches to a referrer's code once (unique
// friend_identity_id — one referral per person, ever), then converts at most
// once when they complete a qualifying visit (perk redemption or booking
// checkout) at a participating business. The pending→converted conditional
// update is the exactly-once conversion lock.
export const ambassadorReferralsTable = pgTable(
  "ambassador_referrals",
  {
    id: serial("id").primaryKey(),
    referrerIdentityId: integer("referrer_identity_id")
      .notNull()
      .references(() => passportIdentitiesTable.id, { onDelete: "cascade" }),
    friendIdentityId: integer("friend_identity_id")
      .notNull()
      .unique()
      .references(() => passportIdentitiesTable.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    status: text("status").notNull().default("pending"), // pending | converted
    // Where the friend's qualifying visit happened — acquisition cost is
    // attributed here when either party's reward is redeemed.
    convertedTenantId: integer("converted_tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    convertedAt: timestamp("converted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ambassador_referrals_referrer_idx").on(t.referrerIdentityId)],
);

export type AmbassadorReferral = typeof ambassadorReferralsTable.$inferSelect;

// Network-wide rewards, redeemable at any opted-in co-op storefront. The
// unique staff-verifiable code + the issued→redeemed conditional update make
// redemption exactly-once.
export const ambassadorRewardsTable = pgTable(
  "ambassador_rewards",
  {
    id: serial("id").primaryKey(),
    identityId: integer("identity_id")
      .notNull()
      .references(() => passportIdentitiesTable.id, { onDelete: "cascade" }),
    code: text("code").notNull().unique(),
    // referral_referrer | referral_friend
    source: text("source").notNull(),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    referralId: integer("referral_id").references(() => ambassadorReferralsTable.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("issued"), // issued | redeemed
    redeemedByTenantId: integer("redeemed_by_tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    redeemedAt: timestamp("redeemed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ambassador_rewards_identity_idx").on(t.identityId)],
);

export type AmbassadorReward = typeof ambassadorRewardsTable.$inferSelect;

// Persisted tier status per identity, upserted on every evaluation so
// merchants can list top ambassadors without recomputing the network.
export const ambassadorStatusTable = pgTable(
  "ambassador_status",
  {
    id: serial("id").primaryKey(),
    identityId: integer("identity_id")
      .notNull()
      .unique()
      .references(() => passportIdentitiesTable.id, { onDelete: "cascade" }),
    tier: text("tier").notNull().default("member"), // member | advocate | ambassador
    distinctPartners: integer("distinct_partners").notNull().default(0),
    convertedReferrals: integer("converted_referrals").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
);

export type AmbassadorStatus = typeof ambassadorStatusTable.$inferSelect;
