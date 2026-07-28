import { Router, type Request, type IRouter } from "express";
import { randomBytes } from "crypto";
import {
  db,
  tenantsTable,
  modulesTable,
  tenantModulesTable,
  merchantCoopPartnershipsTable,
  coopPerkRedemptionsTable,
  coopDisputesTable,
  coopAttributionEventsTable,
  coopPlazaConflictsTable,
  coopTierEventsTable,
  sosSettingsTable,
  type MerchantCoopPartnership,
  type CoopDispute,
  type CoopPlazaConflict,
} from "@workspace/db";
import { perkPassesTable } from "@workspace/db";
import { samePlaza, type PlazaAddress } from "../lib/plaza";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, gte, inArray, isNull, ne, or } from "drizzle-orm";
import { isWalletPassToken, findWalletPass, type WalletPassRow } from "../lib/perkPasses";
import { sendMessageSafe } from "../lib/messaging";
import { recordPerkRedemptionComplianceSafe } from "../lib/coopCompliance";
import { sessionIsPlatformAdmin } from "../middlewares/tenantAccess";
import {
  generateTrackingCode,
  type CoopDirection,
} from "../lib/coopTracking";
import {
  COOP_PERK_DISCLAIMER,
  perkWindowOpen,
  perkWindowState,
  validatePerkWindow,
} from "../lib/coopPerks";
import {
  recordPassportStampSafe,
  personFromClassicPassCode,
  challengeCompletionCounts,
  PASSPORT_REWARD_TYPES,
} from "../lib/passport";
import {
  passportChallengesTable,
} from "@workspace/db";
import { effectiveCoopRadiusMiles } from "../lib/geoDensity";
import { cachedCapacityStatusesFor } from "../lib/capacityStatus";
import { liveSurgeBoostsByPartnership } from "../lib/surgeEngine";
import {
  recordCoopEventsSafe,
  recordPerkImpressionsSafe,
  partnerPerformanceForTenant,
} from "../lib/coopEvents";
import { coopMonthlyReportsTable } from "@workspace/db";
import { activeBoostsForSurface, applyRedemptionSplitSafe } from "../lib/coopSponsorship";
import {
  ListCoopPartnershipsResponse,
  CreateCoopPartnershipBody,
  CreateCoopPartnershipResponse,
  UpdateCoopPartnershipBody,
  UpdateCoopPartnershipResponse,
  ReactivateCoopPartnershipResponse,
  ValidateCoopRedemptionCodeResponse,
  ListCoopDirectoryResponse,
  CreateCoopInviteBody,
  CreateCoopInviteResponse,
  RespondToCoopInviteBody,
  RespondToCoopInviteResponse,
  ListCoopActivePerksResponse,
  RedeemCoopPerkBody,
  RedeemCoopPerkResponse,
  CreatePlatformInviteBody,
  CreatePlatformInviteResponse,
  ListPlatformInvitesResponse,
  GetCoopTaxonomyResponse,
  ListCoopPartnerPerformanceResponse,
  ListCoopMonthlyReportsResponse,
  ListCoopDisputesResponse,
  CreateCoopDisputeBody,
  CreateCoopDisputeResponse,
  WithdrawCoopDisputeResponse,
  ListCoopSuggestionsResponse,
  DismissCoopSuggestionResponse,
  ListCoopCampaignTemplatesResponse,
  ListCoopCampaignsResponse,
  CreateCoopCampaignBody,
  CreateCoopCampaignResponse,
  RespondToCoopCampaignBody,
  RespondToCoopCampaignResponse,
  TriggerCoopCampaignBlastResponse,
  ListCoopEventsResponse,
  CreateCoopEventBody,
  CreateCoopEventResponse,
  GetCoopEventResponse,
  RespondToCoopEventBody,
  RespondToCoopEventResponse,
  CreateCoopEventExpenseBody,
  CreateCoopEventExpenseResponse,
  UpdateCoopEventParticipantBody,
  UpdateCoopEventParticipantResponse,
  TriggerCoopEventBroadcastResponse,
  CheckInCoopEventBody,
  CheckInCoopEventResponse,
  GetCoopStatsResponse,
  ListCoopPlazaNotificationsResponse,
  ListCoopPlazaConflictsResponse,
  ReleaseCoopPlazaConflictResponse,
  GetCoopLedgerResponse,
  ProposeCoopRenegotiationBody,
  ProposeCoopRenegotiationResponse,
  RespondToCoopRenegotiationBody,
  RespondToCoopRenegotiationResponse,
  PauseCoopPartnershipResponse,
  ResumeCoopPartnershipResponse,
  ListPassportChallengesResponse,
  CreatePassportChallengeBody,
  CreatePassportChallengeResponse,
  UpdatePassportChallengeBody,
  UpdatePassportChallengeResponse,
} from "@workspace/api-zod";
import {
  disparityPercent,
  getTrafficByPartnership,
  recordCoopTrafficEvent,
} from "../lib/coopTraffic";
import { resolveSettings } from "../lib/settings";
import {
  coopCampaignsTable,
  coopCampaignParticipantsTable,
  coopCommunityEventsTable,
  coopCommunityEventParticipantsTable,
  coopCommunityEventExpensesTable,
  coopCommunityEventCheckinsTable,
} from "@workspace/db";
import {
  eventPhase,
  loadEventRows,
  serializeEvent,
  serializeEventDetail,
  newUnifiedEventCode,
  newStorefrontCode,
  runEventBroadcast,
} from "../lib/coopCommunityEvents";
import {
  CAMPAIGN_TEMPLATES,
  CAMPAIGN_TEMPLATE_SLUGS,
  campaignPhase,
  loadCampaignRows,
  serializeCampaign,
  flashPerksForTenant,
  runCampaignBlast,
} from "../lib/coopCampaigns";
import {
  SubmitCoopPartnerRatingBody,
  SubmitCoopPartnerRatingResponse,
  GetCoopReputationOverviewResponse,
} from "@workspace/api-zod";
import {
  coopPartnerRatingsTable,
  coopReputationStatesTable,
  type CoopPartnerRating,
} from "@workspace/db";
import {
  RATING_PERIOD_DAYS,
  REPUTATION_MIN_RATERS,
  REPUTATION_FLAG_THRESHOLD,
  computeReputations,
  decoupledTenantIdSet,
} from "../lib/coopReputation";
import { coopSuggestionsTable, coopSuggestionDismissalsTable } from "@workspace/db";
import {
  computeSuggestions,
  refreshCoopSuggestionsSafe,
  proposalForPair,
  dismissedTenantIds,
  MAX_SUGGESTIONS,
} from "../lib/coopMatchmaking";
import { platformInvitesTable } from "@workspace/db";
import {
  generateInviteToken,
  inviteExpiryDate,
  buildInviteUrl,
  buildInviteMessage,
  effectiveInviteStatus,
} from "../lib/platformInvites";
import {
  COOP_TAXONOMY,
  taxonomyEntry,
  toCoopProfile,
  loadCoopProfiles,
  isolationPartnersOf,
  isBlockedPair,
  sameSubCategory,
  sameIndustryL1,
  distanceBetween,
  withinDiscoveryRange,
  filterPartnershipsForConsumerSurface,
} from "../lib/coopFirewall";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Merchant co-op partnerships — /api/coop
//
// Cross-promotion pacts between two businesses on the platform: a host tenant
// offers a perk (with a redemption code) to customers referred from a partner
// tenant. The "industry barrier" blocks pairing two tenants that share a
// module category (they'd be boosting a direct competitor) unless the admin
// explicitly overrides it. All routes sit behind the shared session auth.
// ---------------------------------------------------------------------------

// Created lazily (not at module scope) so importing the route registry never
// touches drizzle table internals — some unit tests mock @workspace/db with
// bare stub tables.
function tenantAliases() {
  return {
    hostTenant: alias(tenantsTable, "coop_host_tenant"),
    partnerTenant: alias(tenantsTable, "coop_partner_tenant"),
  };
}

function serialize(
  p: MerchantCoopPartnership,
  hostTenantName: string,
  partnerTenantName: string
) {
  return {
    id: p.id,
    hostTenantId: p.hostTenantId,
    hostTenantName,
    partnerTenantId: p.partnerTenantId,
    partnerTenantName,
    perkTitle: p.perkTitle,
    perkDescription: p.perkDescription,
    redemptionCode: p.redemptionCode,
    industryBarrierOverridden: p.industryBarrierOverridden,
    status: p.status,
    requestedByTenantId: p.requestedByTenantId,
    mutualRewardTerms: p.mutualRewardTerms,
    perkValueAmount: p.perkValueAmount != null ? parseFloat(p.perkValueAmount) : null,
    perkStartsAt: p.perkStartsAt ? p.perkStartsAt.toISOString() : null,
    perkEndsAt: p.perkEndsAt ? p.perkEndsAt.toISOString() : null,
    disputeSuspended: p.disputeSuspended,
    bannedAt: p.bannedAt ? p.bannedAt.toISOString() : null,
    hostTrackingCode: p.hostTrackingCode,
    partnerTrackingCode: p.partnerTrackingCode,
    tier: p.tier,
    hostReciprocityThreshold: p.hostReciprocityThreshold,
    partnerReciprocityThreshold: p.partnerReciprocityThreshold,
    performancePausedAt: p.performancePausedAt ? p.performancePausedAt.toISOString() : null,
    reactivationRequestedByTenantId: p.reactivationRequestedByTenantId,
    proposedPerkTitle: p.proposedPerkTitle,
    proposedPerkDescription: p.proposedPerkDescription,
    proposedMutualRewardTerms: p.proposedMutualRewardTerms,
    renegotiationRequestedByTenantId: p.renegotiationRequestedByTenantId,
    isActive: p.isActive,
    revenueShareKind: p.revenueShareKind ?? null,
    revenueShareValue: p.revenueShareValue != null ? parseFloat(p.revenueShareValue) : null,
    revenueShareBaseAmount:
      p.revenueShareBaseAmount != null ? parseFloat(p.revenueShareBaseAmount) : null,
    createdAt: p.createdAt.toISOString(),
  };
}

/** Serialize a dispute row joined with both party names + the perk title. */
export function serializeDispute(
  d: CoopDispute,
  reportingTenantName: string,
  reportedTenantName: string,
  perkTitle: string
) {
  return {
    id: d.id,
    partnershipId: d.partnershipId,
    perkTitle,
    reportingTenantId: d.reportingTenantId,
    reportingTenantName,
    reportedTenantId: d.reportedTenantId,
    reportedTenantName,
    category: d.category,
    details: d.details,
    status: d.status,
    graceDeadlineAt: d.graceDeadlineAt.toISOString(),
    escalatedAt: d.escalatedAt ? d.escalatedAt.toISOString() : null,
    resolvedAt: d.resolvedAt ? d.resolvedAt.toISOString() : null,
    withdrawnAt: d.withdrawnAt ? d.withdrawnAt.toISOString() : null,
    mediationNotes: d.mediationNotes,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/** Shared join for dispute reads: dispute + both party names + perk title. */
export function disputeRows() {
  const reportingTenant = alias(tenantsTable, "dispute_reporting_tenant");
  const reportedTenant = alias(tenantsTable, "dispute_reported_tenant");
  return db
    .select({
      dispute: coopDisputesTable,
      reportingTenantName: reportingTenant.brandName,
      reportedTenantName: reportedTenant.brandName,
      perkTitle: merchantCoopPartnershipsTable.perkTitle,
    })
    .from(coopDisputesTable)
    .innerJoin(reportingTenant, eq(coopDisputesTable.reportingTenantId, reportingTenant.id))
    .innerJoin(reportedTenant, eq(coopDisputesTable.reportedTenantId, reportedTenant.id))
    .innerJoin(
      merchantCoopPartnershipsTable,
      eq(coopDisputesTable.partnershipId, merchantCoopPartnershipsTable.id)
    );
}

/**
 * `deadline = now + N business days` (Mon–Fri; weekends don't count toward
 * the resolution window). Same time of day, N business days later.
 */
export function addBusinessDays(from: Date, businessDays: number): Date {
  const d = new Date(from.getTime());
  let remaining = businessDays;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) remaining--;
  }
  return d;
}

export const DISPUTE_GRACE_BUSINESS_DAYS = 7;

export const COOP_DISPUTE_CATEGORIES = [
  "Partner refusing valid digital perk",
  "Inappropriate business conduct",
  "Closed storefront/unresponsive",
] as const;

/** Tenant scope from the x-tenant-id header (same convention as /api/sos). */
function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Exact tenant-facing copy the UI shows when the guardrail blocks a pairing.
const SAME_INDUSTRY_MESSAGE = "Same-industry pairings are restricted by platform guidelines.";

// Exact tenant-facing copy for the plaza exclusivity rule.
const PLAZA_EXCLUSIVITY_MESSAGE =
  "Plaza exclusivity: this business category is already represented by an active partnership in your commercial complex. Only one partner per category within the same plaza.";

/**
 * A tenant's industry category for the merchant-facing guardrail: the
 * business's own SOS profile (businessCategory when set, else industryType).
 * NULL when the tenant has no SOS settings row yet.
 */
function industryOf(
  s: { businessCategory: string; industryType: string } | null | undefined
): string | null {
  if (!s) return null;
  const cat = s.businessCategory.trim() || s.industryType.trim();
  return cat ? cat.toLowerCase() : null;
}

function partnershipRows() {
  const { hostTenant, partnerTenant } = tenantAliases();
  return db
    .select({
      partnership: merchantCoopPartnershipsTable,
      hostTenantName: hostTenant.brandName,
      partnerTenantName: partnerTenant.brandName,
    })
    .from(merchantCoopPartnershipsTable)
    .innerJoin(hostTenant, eq(merchantCoopPartnershipsTable.hostTenantId, hostTenant.id))
    .innerJoin(partnerTenant, eq(merchantCoopPartnershipsTable.partnerTenantId, partnerTenant.id));
}

/** Distinct module categories a tenant has provisioned. */
async function tenantCategories(tenantId: number): Promise<Set<string>> {
  const rows = await db
    .select({ categorySlug: modulesTable.categorySlug, category: modulesTable.category })
    .from(tenantModulesTable)
    .innerJoin(modulesTable, eq(tenantModulesTable.moduleId, modulesTable.id))
    .where(eq(tenantModulesTable.tenantId, tenantId));
  return new Set(rows.map((r) => `${r.categorySlug}\u0000${r.category}`));
}

// ── Plaza exclusivity helpers ───────────────────────────────────────────────

type PlazaSettingsRow = {
  tenantId: number | null;
  businessCategory: string;
  industryType: string;
  streetAddress: string;
  postalCode: string;
  latitude: string;
  longitude: string;
};

/** Address + category profile rows for a set of tenants. */
async function plazaSettingsFor(tenantIds: number[]): Promise<PlazaSettingsRow[]> {
  if (tenantIds.length === 0) return [];
  return db
    .select({
      tenantId: sosSettingsTable.tenantId,
      businessCategory: sosSettingsTable.businessCategory,
      industryType: sosSettingsTable.industryType,
      streetAddress: sosSettingsTable.streetAddress,
      postalCode: sosSettingsTable.postalCode,
      latitude: sosSettingsTable.latitude,
      longitude: sosSettingsTable.longitude,
    })
    .from(sosSettingsTable)
    .where(inArray(sosSettingsTable.tenantId, tenantIds));
}

type CategoryHold = { partnershipId: number; partnerTenantId: number; partnerName: string };

/**
 * Categories already "held" by a tenant's active (accepted + isActive)
 * partnerships with businesses in the same plaza as that tenant. Keyed by
 * the partner's normalized industry category.
 */
async function samePlazaCategoryHolds(
  tenantId: number,
  myAddress: PlazaAddress
): Promise<Map<string, CategoryHold>> {
  const rows = await db
    .select({
      id: merchantCoopPartnershipsTable.id,
      hostTenantId: merchantCoopPartnershipsTable.hostTenantId,
      partnerTenantId: merchantCoopPartnershipsTable.partnerTenantId,
    })
    .from(merchantCoopPartnershipsTable)
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        eq(merchantCoopPartnershipsTable.isActive, true),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
        )
      )
    );
  const holds = new Map<string, CategoryHold>();
  if (rows.length === 0) return holds;
  const otherIds = [
    ...new Set(rows.map((r) => (r.hostTenantId === tenantId ? r.partnerTenantId : r.hostTenantId))),
  ];
  const [settings, names] = await Promise.all([
    plazaSettingsFor(otherIds),
    db
      .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
      .from(tenantsTable)
      .where(inArray(tenantsTable.id, otherIds)),
  ]);
  const settingsById = new Map(settings.map((s) => [s.tenantId, s]));
  const namesById = new Map(names.map((n) => [n.id, n.brandName]));
  for (const r of rows) {
    const otherId = r.hostTenantId === tenantId ? r.partnerTenantId : r.hostTenantId;
    const s = settingsById.get(otherId);
    const category = industryOf(s);
    if (!s || category == null) continue;
    if (!samePlaza(myAddress, s)) continue;
    if (!holds.has(category)) {
      holds.set(category, {
        partnershipId: r.id,
        partnerTenantId: otherId,
        partnerName: namesById.get(otherId) ?? "another business",
      });
    }
  }
  return holds;
}

/** True when the admin has released the exclusivity for this exact pairing. */
async function plazaConflictReleased(
  requesterTenantId: number,
  blockedPartnerTenantId: number,
  category: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: coopPlazaConflictsTable.id })
    .from(coopPlazaConflictsTable)
    .where(
      and(
        eq(coopPlazaConflictsTable.requesterTenantId, requesterTenantId),
        eq(coopPlazaConflictsTable.blockedPartnerTenantId, blockedPartnerTenantId),
        eq(coopPlazaConflictsTable.category, category),
        eq(coopPlazaConflictsTable.status, "released")
      )
    )
    .limit(1);
  return row != null;
}

/**
 * Record (or refresh) a plaza exclusivity conflict. One row per (requester,
 * blocked partner, category) trio — this row *is* the in-app notification
 * both businesses see. Never resurrects a released conflict.
 */
async function recordPlazaConflict(
  requesterTenantId: number,
  blockedPartnerTenantId: number,
  category: string,
  existingPartnershipId: number
): Promise<void> {
  await db
    .insert(coopPlazaConflictsTable)
    .values({ requesterTenantId, blockedPartnerTenantId, category, existingPartnershipId })
    .onConflictDoUpdate({
      target: [
        coopPlazaConflictsTable.requesterTenantId,
        coopPlazaConflictsTable.blockedPartnerTenantId,
        coopPlazaConflictsTable.category,
      ],
      set: { updatedAt: new Date(), existingPartnershipId },
    });
}

function plazaNotificationMessage(
  role: "requester" | "blocked",
  otherName: string,
  category: string,
  status: string
): string {
  const rule =
    "Only one partner per business category is allowed within the same commercial complex (plaza exclusivity).";
  const base =
    role === "requester"
      ? `Your partnership invite to ${otherName} was blocked: the "${category}" category is already held by one of your active partnerships in your plaza. ${rule}`
      : `${otherName} tried to invite your business, but the pairing was blocked: the "${category}" category is already held by an active partnership in your shared plaza. ${rule}`;
  return status === "released"
    ? `${base} An admin has since released this exclusivity — the pairing may be retried.`
    : base;
}

/** Random, human-readable redemption code, e.g. "COOP-7F3K9Q2M". */
function generateCode(): string {
  // Unambiguous alphabet (no 0/O/1/I/L).
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `COOP-${out}`;
}

/**
 * Shared validity check for a wallet pass: unknown token, inactive
 * partnership, expired pass, and already-redeemed pass all fail with a clear
 * reason. `reason == null` means the pass is redeemable right now.
 */
function walletPassState(row: WalletPassRow | null): { reason: string | null } {
  if (!row) return { reason: "Unknown pass" };
  if (!row.partnership.isActive || row.partnership.status !== "accepted") {
    return { reason: "This partnership is no longer active" };
  }
  // NOTE: performance-paused partnerships intentionally still redeem — a
  // pause hides the perk from new customers, but honoring already-issued
  // passes/codes is exactly how traffic resumes and auto-reactivates the pact.
  if (row.pass.redeemedAt != null) return { reason: "This pass was already redeemed" };
  if (row.pass.expiresAt <= new Date()) return { reason: "This pass has expired" };
  return { reason: null };
}

/**
 * A presented code may be the legacy shared redemption code or either
 * direction-aware tracking code — all three validate and redeem.
 */
function matchesAnyCode(code: string) {
  return or(
    eq(merchantCoopPartnershipsTable.redemptionCode, code),
    eq(merchantCoopPartnershipsTable.hostTrackingCode, code),
    eq(merchantCoopPartnershipsTable.partnerTrackingCode, code)
  );
}

function pgUniqueViolation(err: unknown): boolean {
  const pgCode =
    (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
  return pgCode === "23505";
}

// ── GET /coop/partnerships — list the scoped tenant's partnerships ──────────
// Tenant context is REQUIRED (x-tenant-id header, tenantId query fallback) and
// the response only ever contains partnerships where that tenant is the host
// or the partner — no caller can enumerate other merchants' pacts. When both
// header and query are supplied they must agree.
router.get("/coop/partnerships", async (req, res): Promise<void> => {
  const headerTenantId = tenantIdFrom(req);
  const rawQuery = req.query.tenantId;
  const parsedQuery = rawQuery != null ? Number(rawQuery) : null;
  const queryTenantId =
    parsedQuery != null && Number.isInteger(parsedQuery) && parsedQuery > 0 ? parsedQuery : null;
  if (headerTenantId != null && queryTenantId != null && headerTenantId !== queryTenantId) {
    res.status(403).json({ message: "Cannot list another business's partnerships" });
    return;
  }
  const tenantId = headerTenantId ?? queryTenantId;
  if (tenantId == null && !sessionIsPlatformAdmin(req)) {
    res
      .status(400)
      .json({ message: "Tenant context is required (x-tenant-id header or tenantId query)" });
    return;
  }
  // Platform admins with no tenant context see the unscoped admin-console
  // list; the tenantAccess middleware already 403s non-admins on that path.
  const base = partnershipRows();
  const rows = await (tenantId == null
    ? base
    : base.where(
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
        )
      )
  ).orderBy(desc(merchantCoopPartnershipsTable.createdAt), desc(merchantCoopPartnershipsTable.id));
  res.json(
    ListCoopPartnershipsResponse.parse(
      rows.map((r) => serialize(r.partnership, r.hostTenantName, r.partnerTenantName))
    )
  );
});

// ── POST /coop/partnerships — create with industry-barrier validation ───────
router.post("/coop/partnerships", async (req, res): Promise<void> => {
  const parsed = CreateCoopPartnershipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const { hostTenantId, partnerTenantId, perkTitle } = parsed.data;
  if (hostTenantId === partnerTenantId) {
    res.status(400).json({ message: "A business cannot partner with itself" });
    return;
  }
  const windowError = validatePerkWindow(parsed.data.perkStartsAt, parsed.data.perkEndsAt);
  if (windowError) {
    res.status(400).json({ message: windowError });
    return;
  }

  const tenants = await db
    .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(inArray(tenantsTable.id, [hostTenantId, partnerTenantId]));
  const host = tenants.find((t) => t.id === hostTenantId);
  const partner = tenants.find((t) => t.id === partnerTenantId);
  if (!host || !partner) {
    res.status(404).json({ message: "Host or partner tenant not found" });
    return;
  }

  // Industry barrier: block pairing two businesses that share a module
  // category (direct competitors) unless explicitly overridden.
  const override = parsed.data.overrideIndustryBarrier === true;
  if (!override) {
    const [hostCats, partnerCats] = await Promise.all([
      tenantCategories(hostTenantId),
      tenantCategories(partnerTenantId),
    ]);
    const shared = [...hostCats]
      .filter((c) => partnerCats.has(c))
      .map((c) => c.split("\u0000")[1])
      .sort();
    if (shared.length > 0) {
      res.status(409).json({
        message: `Industry barrier: ${host.brandName} and ${partner.brandName} operate in the same category (${shared.join(", ")}). Cross-promoting a direct competitor is blocked — override the barrier to proceed anyway.`,
        sharedCategories: shared,
      });
      return;
    }
  }

  const explicitCode = parsed.data.redemptionCode?.trim() || null;
  // Bounded retry: auto-generated codes are random, collisions are rare.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = explicitCode ?? generateCode();
    try {
      const [created] = await db
        .insert(merchantCoopPartnershipsTable)
        .values({
          hostTenantId,
          partnerTenantId,
          perkTitle,
          perkDescription: parsed.data.perkDescription ?? null,
          redemptionCode: code,
          industryBarrierOverridden: override,
          perkValueAmount:
            parsed.data.perkValueAmount != null ? parsed.data.perkValueAmount.toFixed(2) : null,
          perkStartsAt: parsed.data.perkStartsAt ? new Date(parsed.data.perkStartsAt) : null,
          perkEndsAt: parsed.data.perkEndsAt ? new Date(parsed.data.perkEndsAt) : null,
          hostTrackingCode: generateTrackingCode(),
          partnerTrackingCode: generateTrackingCode(),
        })
        .returning();
      res
        .status(201)
        .json(CreateCoopPartnershipResponse.parse(serialize(created, host.brandName, partner.brandName)));
      return;
    } catch (err) {
      if (pgUniqueViolation(err)) {
        if (explicitCode) {
          res.status(400).json({ message: "Redemption code already in use" });
          return;
        }
        continue; // regenerate and retry
      }
      throw err;
    }
  }
  res.status(500).json({ message: "Could not generate a unique redemption code" });
});

// ── PATCH /coop/partnerships/:id — edit perk / activate / deactivate ────────
// Tenant context is REQUIRED (x-tenant-id header) and only the two
// participants (host or partner) may mutate the partnership.
router.patch("/coop/partnerships/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = UpdateCoopPartnershipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const updates: Partial<typeof merchantCoopPartnershipsTable.$inferInsert> = {};
  if (parsed.data.perkTitle !== undefined) updates.perkTitle = parsed.data.perkTitle;
  if (parsed.data.perkDescription !== undefined) updates.perkDescription = parsed.data.perkDescription;
  if (parsed.data.redemptionCode !== undefined) updates.redemptionCode = parsed.data.redemptionCode;
  if (parsed.data.isActive !== undefined) updates.isActive = parsed.data.isActive;
  if (parsed.data.perkValueAmount !== undefined)
    updates.perkValueAmount =
      parsed.data.perkValueAmount != null ? parsed.data.perkValueAmount.toFixed(2) : null;
  if (parsed.data.perkStartsAt !== undefined)
    updates.perkStartsAt = parsed.data.perkStartsAt ? new Date(parsed.data.perkStartsAt) : null;
  if (parsed.data.perkEndsAt !== undefined)
    updates.perkEndsAt = parsed.data.perkEndsAt ? new Date(parsed.data.perkEndsAt) : null;
  if (parsed.data.hostReciprocityThreshold !== undefined)
    updates.hostReciprocityThreshold = parsed.data.hostReciprocityThreshold;
  if (parsed.data.partnerReciprocityThreshold !== undefined)
    updates.partnerReciprocityThreshold = parsed.data.partnerReciprocityThreshold;
  // Optional revenue-share terms (Sponsorship Hub): bounty = flat dollars per
  // redemption; percent = % of the agreed base amount. Setting kind to null
  // clears the terms.
  if (parsed.data.revenueShareKind !== undefined) {
    if (parsed.data.revenueShareKind === null) {
      updates.revenueShareKind = null;
      updates.revenueShareValue = null;
      updates.revenueShareBaseAmount = null;
    } else {
      const value =
        parsed.data.revenueShareValue !== undefined ? parsed.data.revenueShareValue : null;
      if (value == null || !(value > 0)) {
        res.status(400).json({ message: "revenueShareValue must be a positive number" });
        return;
      }
      if (parsed.data.revenueShareKind === "percent") {
        const base =
          parsed.data.revenueShareBaseAmount !== undefined
            ? parsed.data.revenueShareBaseAmount
            : null;
        if (value > 100) {
          res.status(400).json({ message: "A percentage split cannot exceed 100%" });
          return;
        }
        if (base == null || !(base > 0)) {
          res.status(400).json({
            message: "revenueShareBaseAmount is required for a percentage split",
          });
          return;
        }
        updates.revenueShareBaseAmount = base.toFixed(2);
      } else {
        updates.revenueShareBaseAmount = null;
      }
      updates.revenueShareKind = parsed.data.revenueShareKind;
      updates.revenueShareValue = value.toFixed(2);
    }
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ message: "No fields to update" });
    return;
  }
  const [existing] = await db
    .select({
      hostTenantId: merchantCoopPartnershipsTable.hostTenantId,
      partnerTenantId: merchantCoopPartnershipsTable.partnerTenantId,
      status: merchantCoopPartnershipsTable.status,
      perkStartsAt: merchantCoopPartnershipsTable.perkStartsAt,
      perkEndsAt: merchantCoopPartnershipsTable.perkEndsAt,
    })
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.id, id));
  if (!existing) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  // Participant enforcement: only the host or the partner may mutate.
  if (existing.hostTenantId !== tenantId && existing.partnerTenantId !== tenantId) {
    res.status(403).json({ message: "Only a participant business can modify this partnership" });
    return;
  }
  // Reciprocity rules are each side's OWN demand of the other's traffic: the
  // host edits hostReciprocityThreshold, the partner edits its mirror.
  if (
    parsed.data.hostReciprocityThreshold !== undefined &&
    existing.hostTenantId !== tenantId
  ) {
    res.status(403).json({ message: "Only the host business can set its reciprocity threshold" });
    return;
  }
  if (
    parsed.data.partnerReciprocityThreshold !== undefined &&
    existing.partnerTenantId !== tenantId
  ) {
    res
      .status(403)
      .json({ message: "Only the partner business can set its reciprocity threshold" });
    return;
  }
  const touchesWindow =
    parsed.data.perkStartsAt !== undefined || parsed.data.perkEndsAt !== undefined;
  if (updates.isActive === true || touchesWindow) {
    // A perk can only be (re)activated on an accepted partnership — pending
    // and declined invites must never surface anywhere.
    if (updates.isActive === true && existing.status !== "accepted") {
      res.status(409).json({
        message: "Only accepted partnerships can be activated",
      });
      return;
    }
    if (touchesWindow) {
      const mergedStart =
        parsed.data.perkStartsAt !== undefined
          ? parsed.data.perkStartsAt
          : existing.perkStartsAt?.toISOString();
      const mergedEnd =
        parsed.data.perkEndsAt !== undefined
          ? parsed.data.perkEndsAt
          : existing.perkEndsAt?.toISOString();
      const windowError = validatePerkWindow(mergedStart, mergedEnd);
      if (windowError) {
        res.status(400).json({ message: windowError });
        return;
      }
    }
  }
  updates.updatedAt = new Date();

  try {
    const [updated] = await db
      .update(merchantCoopPartnershipsTable)
      .set(updates)
      .where(eq(merchantCoopPartnershipsTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    const [row] = await partnershipRows().where(eq(merchantCoopPartnershipsTable.id, id));
    res.json(
      UpdateCoopPartnershipResponse.parse(
        serialize(row.partnership, row.hostTenantName, row.partnerTenantName)
      )
    );
  } catch (err) {
    if (pgUniqueViolation(err)) {
      res.status(400).json({ message: "Redemption code already in use" });
      return;
    }
    throw err;
  }
});

// ── POST /coop/partnerships/:id/reactivate — mutual re-accept of a pause ────
// A performance-paused partnership reactivates when BOTH parties agree: the
// first participant's call records the request, the second (from the other
// side) clears the pause. Traffic resuming also auto-reactivates via the
// scheduled evaluator — this is the manual mutual-agreement path.
router.post("/coop/partnerships/:id/reactivate", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const [partnership] = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.id, id));
  if (!partnership) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (partnership.hostTenantId !== tenantId && partnership.partnerTenantId !== tenantId) {
    res.status(403).json({ message: "Only a participant business can reactivate this partnership" });
    return;
  }
  if (partnership.performancePausedAt == null) {
    res.status(409).json({ message: "This partnership is not performance-paused" });
    return;
  }
  if (partnership.bannedAt != null) {
    res.status(409).json({ message: "This partnership is banned and cannot be reactivated" });
    return;
  }
  const now = new Date();
  const alreadyRequestedBy = partnership.reactivationRequestedByTenantId;
  if (alreadyRequestedBy != null && alreadyRequestedBy !== tenantId) {
    // Mutual agreement reached — clear the pause. Conditional on the pause
    // timestamp so a concurrent evaluator reactivation can't double-apply.
    const [claimed] = await db
      .update(merchantCoopPartnershipsTable)
      .set({
        performancePausedAt: null,
        reactivationRequestedByTenantId: null,
        tier: "standard",
        updatedAt: now,
      })
      .where(
        and(
          eq(merchantCoopPartnershipsTable.id, id),
          eq(merchantCoopPartnershipsTable.performancePausedAt, partnership.performancePausedAt)
        )
      )
      .returning({ id: merchantCoopPartnershipsTable.id });
    if (claimed) {
      const [names] = await partnershipRows().where(eq(merchantCoopPartnershipsTable.id, id));
      await db.insert(coopTierEventsTable).values({
        partnershipId: id,
        previousState: "paused",
        newState: "standard",
        reason: "reactivated by mutual agreement of both businesses.",
        hostToPartnerCount: 0,
        partnerToHostCount: 0,
        createdAt: now,
      });
      for (const partyId of [partnership.hostTenantId, partnership.partnerTenantId]) {
        const [settings] = await db
          .select({ publicPhone: sosSettingsTable.publicPhone })
          .from(sosSettingsTable)
          .where(eq(sosSettingsTable.tenantId, partyId));
        const otherName =
          partyId === partnership.hostTenantId ? names.partnerTenantName : names.hostTenantName;
        await sendMessageSafe({
          tenantId: partyId,
          origin: "operational",
          kind: "coop_tier_change",
          toNumber: settings?.publicPhone?.trim() || null,
          body: `Co-Op update: your "${partnership.perkTitle}" partnership with ${otherName} — reactivated by mutual agreement. The perk is live again at Standard tier.`,
          context: { partnershipId: id },
        });
      }
    }
  } else if (alreadyRequestedBy == null) {
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ reactivationRequestedByTenantId: tenantId, updatedAt: now })
      .where(
        and(
          eq(merchantCoopPartnershipsTable.id, id),
          isNull(merchantCoopPartnershipsTable.reactivationRequestedByTenantId)
        )
      );
  }
  // else: same side re-requesting is a no-op.
  const [row] = await partnershipRows().where(eq(merchantCoopPartnershipsTable.id, id));
  res.json(
    ReactivateCoopPartnershipResponse.parse(
      serialize(row.partnership, row.hostTenantName, row.partnerTenantName)
    )
  );
});

// ---------------------------------------------------------------------------
// Merchant-facing Local Co-Op Network — tenant scope via x-tenant-id header
// (same convention as /api/sos/*).
// ---------------------------------------------------------------------------

// ── GET /coop/taxonomy — curated Industry → Sub-Category taxonomy ───────────
router.get("/coop/taxonomy", async (_req, res): Promise<void> => {
  res.json(
    GetCoopTaxonomyResponse.parse(
      COOP_TAXONOMY.map((i) => ({
        slug: i.slug,
        label: i.label,
        subCategories: i.subCategories.map((s) => ({ slug: s.slug, label: s.label })),
      }))
    )
  );
});

// ── GET /coop/directory — other businesses on the platform ──────────────────
// Safe, public-ish profile only (name, category, city); never contacts, MRR,
// or module details. The category firewall is enforced at discovery: direct
// competitors (same Level 2 sub-category) and isolation-paired businesses are
// excluded from the listing entirely — not just flagged. Local scope: within
// the viewer's co-op radius when both sides have coordinates, city-match
// fallback otherwise.
router.get("/coop/directory", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const [meRow] = await db
    .select()
    .from(sosSettingsTable)
    .where(eq(sosSettingsTable.tenantId, tenantId));
  const me = toCoopProfile(meRow ?? null);
  // Effective co-op radius: merchant override wins, else the density-derived
  // auto default. Feed it into the discovery profile so proximity scoping and
  // the explicit distance filter below share one radius.
  const radiusMiles = meRow != null ? effectiveCoopRadiusMiles(meRow) : null;
  if (radiusMiles != null) me.radiusMiles = radiusMiles;
  const isolated = await isolationPartnersOf(tenantId);
  // Reputation Shield: decoupled businesses are hidden from discovery.
  const decoupled = await decoupledTenantIdSet();
  const [myPlazaRow] = await plazaSettingsFor([tenantId]);
  const myPlaza = myPlazaRow ?? null;
  const myIndustry = industryOf(myPlaza);
  // Sponsorship Hub: businesses holding an active paid "Featured Spot" boost
  // for the discovery surface render highlighted above organic matches. The
  // firewall and proximity filters below still apply unchanged — a boost
  // never bypasses them.
  const discoveryBoosts = await activeBoostsForSurface("discovery");
  const featuredTenantIds = new Set(discoveryBoosts.map((b) => b.tenantId));

  const rows = await db
    .select({
      id: tenantsTable.id,
      name: tenantsTable.brandName,
      businessCategory: sosSettingsTable.businessCategory,
      industryType: sosSettingsTable.industryType,
      coopSubCategory: sosSettingsTable.coopSubCategory,
      coopRadiusMiles: sosSettingsTable.coopRadiusMiles,
      latitude: sosSettingsTable.latitude,
      longitude: sosSettingsTable.longitude,
      city: sosSettingsTable.addressLocality,
      streetAddress: sosSettingsTable.streetAddress,
      postalCode: sosSettingsTable.postalCode,
    })
    .from(tenantsTable)
    .leftJoin(sosSettingsTable, eq(sosSettingsTable.tenantId, tenantsTable.id))
    .where(and(ne(tenantsTable.id, tenantId), eq(tenantsTable.status, "active")))
    .orderBy(tenantsTable.brandName);

  // Plaza exclusivity pre-flags: which categories my active same-plaza
  // partnerships already hold, which pairings an admin has released, and —
  // for the reverse direction — each listed business's own active same-plaza
  // partners' categories.
  const myHolds = myPlaza
    ? await samePlazaCategoryHolds(tenantId, myPlaza)
    : new Map<string, CategoryHold>();
  const releasedRows = await db
    .select({
      blockedPartnerTenantId: coopPlazaConflictsTable.blockedPartnerTenantId,
      category: coopPlazaConflictsTable.category,
    })
    .from(coopPlazaConflictsTable)
    .where(
      and(
        eq(coopPlazaConflictsTable.requesterTenantId, tenantId),
        eq(coopPlazaConflictsTable.status, "released")
      )
    );
  const releasedPairs = new Set(releasedRows.map((r) => `${r.blockedPartnerTenantId}|${r.category}`));

  const activePartnerships = await db
    .select({
      hostTenantId: merchantCoopPartnershipsTable.hostTenantId,
      partnerTenantId: merchantCoopPartnershipsTable.partnerTenantId,
    })
    .from(merchantCoopPartnershipsTable)
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        eq(merchantCoopPartnershipsTable.isActive, true)
      )
    );
  const entryIds = new Set(rows.map((r) => r.id));
  const counterpartIds = [
    ...new Set(
      activePartnerships
        .filter((p) => entryIds.has(p.hostTenantId) || entryIds.has(p.partnerTenantId))
        .flatMap((p) => [p.hostTenantId, p.partnerTenantId])
    ),
  ];
  const counterpartSettings = new Map(
    (await plazaSettingsFor(counterpartIds)).map((s) => [s.tenantId, s])
  );

  const search = String(req.query.search ?? "").trim().toLowerCase();
  const cityFilter = String(req.query.city ?? "").trim().toLowerCase();
  const categoryFilter = String(req.query.category ?? "").trim().toLowerCase();

  const entries = rows
    .map((r) => {
      const theirs = toCoopProfile(
        r.businessCategory != null
          ? {
              coopSubCategory: r.coopSubCategory ?? "",
              businessCategory: r.businessCategory,
              industryType: r.industryType ?? "",
              coopRadiusMiles: r.coopRadiusMiles ?? 4,
              latitude: r.latitude ?? "",
              longitude: r.longitude ?? "",
              addressLocality: r.city ?? "",
            }
          : null
      );
      // Display casing: prefer the raw profile values over the lowercased key.
      const category = (r.businessCategory?.trim() || r.industryType?.trim()) ?? null;
      const distance = distanceBetween(me, theirs);
      const sub = theirs.subCategory != null ? taxonomyEntry(theirs.subCategory) : null;
      const industry = category ? category.toLowerCase() : null;

      const inMyPlaza = myPlaza != null && samePlaza(myPlaza, r);
      let plazaConflict = false;
      if (inMyPlaza) {
        // Requester direction: I already hold this business's category via an
        // active same-plaza partnership with someone else.
        if (industry != null) {
          const hold = myHolds.get(industry);
          if (hold && hold.partnerTenantId !== r.id) plazaConflict = true;
        }
        // Reverse direction: this business already holds *my* category via an
        // active same-plaza partnership of its own.
        if (!plazaConflict && myIndustry != null) {
          for (const p of activePartnerships) {
            if (p.hostTenantId !== r.id && p.partnerTenantId !== r.id) continue;
            const otherId = p.hostTenantId === r.id ? p.partnerTenantId : p.hostTenantId;
            if (otherId === tenantId) continue;
            const other = counterpartSettings.get(otherId);
            if (!other) continue;
            if (industryOf(other) === myIndustry && samePlaza(r, other)) {
              plazaConflict = true;
              break;
            }
          }
        }
        // An admin release lifts the flag for this exact pairing.
        if (
          plazaConflict &&
          industry != null &&
          releasedPairs.has(`${r.id}|${industry}`)
        ) {
          plazaConflict = false;
        }
        if (plazaConflict && myIndustry != null && releasedPairs.has(`${r.id}|${myIndustry}`)) {
          plazaConflict = false;
        }
      }

      return {
        profile: theirs,
        entry: {
          id: r.id,
          name: r.name,
          category: category || null,
          subCategory: sub ? sub.sub.label : null,
          industry: sub ? sub.industry.label : null,
          distanceMiles: distance == null ? null : Math.round(distance * 10) / 10,
          city: r.city?.trim() || null,
          sameIndustry: sameIndustryL1(me, theirs),
          samePlaza: inMyPlaza,
          plazaConflict,
          featured: featuredTenantIds.has(r.id),
        },
      };
    })
    // Discovery-level firewall: same L2 sub-category or isolation-paired
    // businesses never appear — the block happens here, not at invite time.
    .filter(({ entry }) => !decoupled.has(entry.id))
    .filter(({ profile, entry }) => !isBlockedPair(me, profile, isolated.has(entry.id)))
    // Proximity scope: viewer's radius (coords), city fallback otherwise.
    .filter(({ profile }) => withinDiscoveryRange(me, profile))
    .map(({ entry }) => entry)
    .filter((e) => !search || e.name.toLowerCase().includes(search))
    .filter((e) => !cityFilter || (e.city ?? "").toLowerCase() === cityFilter)
    .filter((e) => !categoryFilter || (e.category ?? "").toLowerCase() === categoryFilter)
    // Effective co-op radius: exclude businesses with known coordinates that
    // fall outside it; coordinate-less entries are kept (city filter still
    // applies to those).
    .filter(
      (e) => e.distanceMiles == null || radiusMiles == null || e.distanceMiles <= radiusMiles
    )
    // Nearest first; coordinate-less entries after, alphabetically.
    .sort((a, b) => {
      if (a.distanceMiles != null && b.distanceMiles != null)
        return a.distanceMiles - b.distanceMiles || a.name.localeCompare(b.name);
      if (a.distanceMiles != null) return -1;
      if (b.distanceMiles != null) return 1;
      return a.name.localeCompare(b.name);
    })
    // Featured slots sort above organic matches (stable sort keeps the
    // distance ordering intact within each group).
    .sort((a, b) => Number(b.featured) - Number(a.featured));

  // Live capacity status per listed business (busy / moderate / available),
  // served from a short in-process cache so directory reads stay cheap.
  const capacityStatuses = await cachedCapacityStatusesFor(entries.map((e) => e.id));
  const withStatus = entries.map((e) => ({
    ...e,
    capacityStatus: capacityStatuses.get(e.id)?.status ?? null,
  }));

  res.json(ListCoopDirectoryResponse.parse(withStatus));
});

// ── GET /coop/suggestions — ranked Suggested Partners feed ──────────────────
// Matchmaking engine output: complementary-fit score from category pairings,
// proximity (coords with city fallback), and activity signals. Exclusions
// (competitors, existing/pending partners, dismissals) are applied live on
// every read so a stale stored row can never surface. Each entry carries an
// auto-generated proposal draft the merchant can edit before sending.
router.get("/coop/suggestions", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const [me] = await db
    .select({ brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  if (!me) {
    res.status(404).json({ message: "Business not found" });
    return;
  }
  const [rawSuggestions, myProfiles, stored, decoupledSet] = await Promise.all([
    computeSuggestions(tenantId),
    loadCoopProfiles([tenantId]),
    db
      .select({ id: coopSuggestionsTable.id })
      .from(coopSuggestionsTable)
      .where(eq(coopSuggestionsTable.tenantId, tenantId))
      .limit(1),
    // Reputation Shield: decoupled businesses never surface in discovery.
    decoupledTenantIdSet(),
  ]);
  const suggestions = rawSuggestions.filter((s) => !decoupledSet.has(s.tenantId));
  // Lazy backfill: a business created before the matchmaking engine existed
  // gets its feed persisted on first view with zero manual steps.
  if (stored.length === 0 && suggestions.length > 0) {
    await refreshCoopSuggestionsSafe(tenantId);
  }
  const mySubCategory = myProfiles.get(tenantId)!.subCategory;
  res.json(
    ListCoopSuggestionsResponse.parse(
      suggestions.slice(0, MAX_SUGGESTIONS).map((s) => ({
        tenantId: s.tenantId,
        name: s.name,
        category: s.category,
        city: s.city,
        distanceMiles: s.distanceMiles,
        score: s.score,
        reasons: s.reasons,
        proposal: proposalForPair(me.brandName, mySubCategory, s.name, s.subCategory),
      }))
    )
  );
});

// ── POST /coop/suggestions/:tenantId/dismiss — hide a suggestion for good ───
router.post("/coop/suggestions/:tenantId/dismiss", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const targetId = Number(req.params.tenantId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    res.status(404).json({ message: "Business not found" });
    return;
  }
  const [target] = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, targetId));
  if (!target) {
    res.status(404).json({ message: "Business not found" });
    return;
  }
  await db
    .insert(coopSuggestionDismissalsTable)
    .values({ tenantId, dismissedTenantId: targetId })
    .onConflictDoNothing();
  // Drop the persisted feed row too so the stored feed mirrors the dismissal.
  await db
    .delete(coopSuggestionsTable)
    .where(
      and(
        eq(coopSuggestionsTable.tenantId, tenantId),
        eq(coopSuggestionsTable.suggestedTenantId, targetId)
      )
    );
  res.json(DismissCoopSuggestionResponse.parse({ dismissed: true }));
});

// ── POST /coop/invites — merchant sends a partnership invite ────────────────
// Strict same-industry guardrail: no tenant-facing override, distinct error
// code the UI maps to the exact platform-guidelines message. Invites start
// pending + inactive; the perk only goes live on acceptance.
router.post("/coop/invites", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateCoopInviteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const { partnerTenantId, perkTitle } = parsed.data;
  if (partnerTenantId === tenantId) {
    res.status(400).json({ message: "A business cannot partner with itself" });
    return;
  }
  const inviteWindowError = validatePerkWindow(parsed.data.perkStartsAt, parsed.data.perkEndsAt);
  if (inviteWindowError) {
    res.status(400).json({ message: inviteWindowError });
    return;
  }
  const tenants = await db
    .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(inArray(tenantsTable.id, [tenantId, partnerTenantId]));
  const requester = tenants.find((t) => t.id === tenantId);
  const target = tenants.find((t) => t.id === partnerTenantId);
  if (!requester || !target) {
    res.status(404).json({ message: "Business not found" });
    return;
  }

  // Sub-category firewall backstop: the directory already hides direct
  // competitors, but a hand-crafted request must hit the same wall. Blocks
  // same Level 2 sub-category and persisted isolation pairs; same-industry
  // but different-sub-niche pairings stay allowed.
  const [profiles, isolated, settings] = await Promise.all([
    loadCoopProfiles([tenantId, partnerTenantId]),
    isolationPartnersOf(tenantId),
    plazaSettingsFor([tenantId, partnerTenantId]),
  ]);
  const myProfile = settings.find((s) => s.tenantId === tenantId);
  const theirProfile = settings.find((s) => s.tenantId === partnerTenantId);
  const mine = industryOf(myProfile);
  const theirs = industryOf(theirProfile);
  if (
    isBlockedPair(
      profiles.get(tenantId)!,
      profiles.get(partnerTenantId)!,
      isolated.has(partnerTenantId)
    )
  ) {
    res.status(403).json({ code: "SAME_INDUSTRY_RESTRICTED", message: SAME_INDUSTRY_MESSAGE });
    return;
  }

  // Plaza exclusivity: within the same commercial complex, a category can be
  // held by only one active partnership. Checked in both directions — the
  // requester may already hold the target's category, or the target may
  // already hold the requester's. An admin release lifts the block for the
  // exact (requester, target, category) pairing.
  if (myProfile && theirProfile && samePlaza(myProfile, theirProfile)) {
    let contested: { category: string; hold: CategoryHold } | null = null;
    if (theirs != null) {
      const myHolds = await samePlazaCategoryHolds(tenantId, myProfile);
      const hold = myHolds.get(theirs);
      if (hold && hold.partnerTenantId !== partnerTenantId) contested = { category: theirs, hold };
    }
    if (!contested && mine != null) {
      const theirHolds = await samePlazaCategoryHolds(partnerTenantId, theirProfile);
      const hold = theirHolds.get(mine);
      if (hold && hold.partnerTenantId !== tenantId) contested = { category: mine, hold };
    }
    if (contested) {
      const released = await plazaConflictReleased(tenantId, partnerTenantId, contested.category);
      if (!released) {
        await recordPlazaConflict(
          tenantId,
          partnerTenantId,
          contested.category,
          contested.hold.partnershipId
        );
        res.status(403).json({
          code: "PLAZA_EXCLUSIVITY_RESTRICTED",
          message: PLAZA_EXCLUSIVITY_MESSAGE,
          category: contested.category,
        });
        return;
      }
    }
  }

  // Bounded retry: auto-generated codes are random, collisions are rare.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [created] = await db
        .insert(merchantCoopPartnershipsTable)
        .values({
          hostTenantId: tenantId,
          partnerTenantId,
          perkTitle,
          perkDescription: parsed.data.perkDescription?.trim() || null,
          mutualRewardTerms: parsed.data.mutualRewardTerms?.trim() || null,
          perkStartsAt: parsed.data.perkStartsAt ? new Date(parsed.data.perkStartsAt) : null,
          perkEndsAt: parsed.data.perkEndsAt ? new Date(parsed.data.perkEndsAt) : null,
          redemptionCode: generateCode(),
          hostTrackingCode: generateTrackingCode(),
          partnerTrackingCode: generateTrackingCode(),
          requestedByTenantId: tenantId,
          status: "pending",
          isActive: false,
        })
        .returning();
      // The pair is now partnered/pending: drop any persisted suggestion rows
      // in both directions (live reads exclude them anyway).
      await db
        .delete(coopSuggestionsTable)
        .where(
          or(
            and(
              eq(coopSuggestionsTable.tenantId, tenantId),
              eq(coopSuggestionsTable.suggestedTenantId, partnerTenantId)
            ),
            and(
              eq(coopSuggestionsTable.tenantId, partnerTenantId),
              eq(coopSuggestionsTable.suggestedTenantId, tenantId)
            )
          )
        );
      // Notify the invited owner: the in-app hub badge picks the pending
      // invite up automatically; the SMS goes through the unified messaging
      // pipeline (opt-in rules + simulated fallback) with a link that lands
      // them on the proposal. Never blocks the invite itself.
      const [targetSettings] = await db
        .select({ publicPhone: sosSettingsTable.publicPhone })
        .from(sosSettingsTable)
        .where(eq(sosSettingsTable.tenantId, partnerTenantId));
      const host = req.get("host") ?? "localhost";
      const proto = req.protocol || "https";
      const proposalUrl = `${proto}://${host}/sos/bookings?tenant=${partnerTenantId}&tab=coop`;
      await sendMessageSafe({
        tenantId: partnerTenantId,
        origin: "operational",
        kind: "coop_invite",
        toNumber: targetSettings?.publicPhone?.trim() || null,
        body:
          `${requester.brandName} wants to partner with your business on Get Next In Line! ` +
          `Proposed perk: "${perkTitle}". Review and accept in one tap: ${proposalUrl}`,
        context: { partnershipId: created.id, requestedByTenantId: tenantId },
      });
      res
        .status(201)
        .json(CreateCoopInviteResponse.parse(serialize(created, requester.brandName, target.brandName)));
      return;
    } catch (err) {
      if (pgUniqueViolation(err)) continue;
      throw err;
    }
  }
  res.status(500).json({ message: "Could not generate a unique redemption code" });
});

// ── Platform invites — invite an OFF-platform business to join & partner ────
// The merchant gets a unique trackable link plus a ready-to-copy message they
// send themselves (no email/SMS infrastructure involved). Registration through
// the link is handled by the public fast-track flow in platformInviteJoin.ts.

function serializePlatformInvite(
  req: Request,
  invite: typeof platformInvitesTable.$inferSelect,
  inviterName: string
) {
  const inviteUrl = buildInviteUrl(req, invite.token);
  return {
    id: invite.id,
    invitedBusinessName: invite.invitedBusinessName,
    invitedContact: invite.invitedContact,
    status: effectiveInviteStatus(invite),
    inviteUrl,
    message: buildInviteMessage({
      inviterName,
      invitedBusinessName: invite.invitedBusinessName,
      inviteUrl,
    }),
    resultingTenantId: invite.resultingTenantId,
    expiresAt: invite.expiresAt.toISOString(),
    createdAt: invite.createdAt.toISOString(),
  };
}

// ── POST /coop/platform-invites — create a trackable off-platform invite ────
router.post("/coop/platform-invites", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreatePlatformInviteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const [inviter] = await db
    .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  if (!inviter) {
    res.status(404).json({ message: "Business not found" });
    return;
  }
  // Bounded retry: tokens are 24 random bytes, collisions are near-impossible.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [created] = await db
        .insert(platformInvitesTable)
        .values({
          inviterTenantId: tenantId,
          invitedBusinessName: parsed.data.businessName.trim(),
          invitedContact: parsed.data.contact?.trim() || null,
          token: generateInviteToken(),
          expiresAt: inviteExpiryDate(),
        })
        .returning();
      res
        .status(201)
        .json(
          CreatePlatformInviteResponse.parse(
            serializePlatformInvite(req, created, inviter.brandName)
          )
        );
      return;
    } catch (err) {
      if (pgUniqueViolation(err)) continue;
      throw err;
    }
  }
  res.status(500).json({ message: "Could not generate a unique invite token" });
});

// ── GET /coop/platform-invites — sent invites with tracking status ──────────
router.get("/coop/platform-invites", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const rows = await db
    .select({ invite: platformInvitesTable, inviterName: tenantsTable.brandName })
    .from(platformInvitesTable)
    .innerJoin(tenantsTable, eq(platformInvitesTable.inviterTenantId, tenantsTable.id))
    .where(eq(platformInvitesTable.inviterTenantId, tenantId))
    .orderBy(desc(platformInvitesTable.createdAt), desc(platformInvitesTable.id));
  res.json(
    ListPlatformInvitesResponse.parse(
      rows.map((r) => serializePlatformInvite(req, r.invite, r.inviterName))
    )
  );
});

// ── POST /coop/invites/:id/respond — target accepts or declines ─────────────
router.post("/coop/invites/:id/respond", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const parsed = RespondToCoopInviteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const [invite] = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.id, id));
  if (!invite) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const isParticipant = invite.hostTenantId === tenantId || invite.partnerTenantId === tenantId;
  if (!isParticipant || invite.requestedByTenantId === tenantId) {
    res.status(403).json({ message: "Only the invited business can respond to this invite" });
    return;
  }
  if (invite.status !== "pending") {
    res.status(409).json({ message: `This invite was already ${invite.status}` });
    return;
  }
  const accept = parsed.data.action === "accept";
  // Conditional update guards against a concurrent double-respond.
  const [updated] = await db
    .update(merchantCoopPartnershipsTable)
    .set({
      status: accept ? "accepted" : "declined",
      isActive: accept,
      respondedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(merchantCoopPartnershipsTable.id, id),
        eq(merchantCoopPartnershipsTable.status, "pending")
      )
    )
    .returning();
  if (!updated) {
    res.status(409).json({ message: "This invite was already responded to" });
    return;
  }
  const [row] = await partnershipRows().where(eq(merchantCoopPartnershipsTable.id, id));
  res.json(
    RespondToCoopInviteResponse.parse(
      serialize(row.partnership, row.hostTenantName, row.partnerTenantName)
    )
  );
});

// ---------------------------------------------------------------------------
// Co-op promotional campaigns & seasonal blasts — /api/coop/campaigns
//
// Partner businesses in an active co-op network launch synchronized flash
// perks under one uniform start/end window and coordinate a single joint SMS
// blast (rolling 7-day network-wide frequency cap). Creation is gated on
// having at least one accepted, active partnership, and only current partners
// can be invited. Tenant scope via x-tenant-id, same as the rest of /coop.
// ---------------------------------------------------------------------------

/** Tenant ids of the scoped tenant's current accepted, active partners. */
async function activePartnerIdsOf(tenantId: number): Promise<Set<number>> {
  const rows = await db
    .select({
      hostTenantId: merchantCoopPartnershipsTable.hostTenantId,
      partnerTenantId: merchantCoopPartnershipsTable.partnerTenantId,
    })
    .from(merchantCoopPartnershipsTable)
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        eq(merchantCoopPartnershipsTable.isActive, true),
        eq(merchantCoopPartnershipsTable.disputeSuspended, false),
        isNull(merchantCoopPartnershipsTable.bannedAt),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
        )
      )
    );
  return new Set(
    rows.map((r) => (r.hostTenantId === tenantId ? r.partnerTenantId : r.hostTenantId))
  );
}

/** Serialize one campaign for the scoped viewer, resolving the creator name. */
function campaignToJson(
  row: Awaited<ReturnType<typeof loadCampaignRows>>[number],
  viewerTenantId: number,
  now: Date
) {
  const creator = row.participants.find((p) => p.tenantId === row.campaign.creatorTenantId);
  return serializeCampaign(row, viewerTenantId, creator?.tenantName ?? "Unknown business", now);
}

// ── GET /coop/campaigns/templates — preset flash-campaign templates ─────────
router.get("/coop/campaigns/templates", async (_req, res): Promise<void> => {
  res.json(ListCoopCampaignTemplatesResponse.parse(CAMPAIGN_TEMPLATES));
});

// ── GET /coop/campaigns — campaigns the scoped tenant participates in ───────
router.get("/coop/campaigns", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const mine = await db
    .select({ campaignId: coopCampaignParticipantsTable.campaignId })
    .from(coopCampaignParticipantsTable)
    .where(eq(coopCampaignParticipantsTable.tenantId, tenantId));
  const rows = await loadCampaignRows(mine.map((r) => r.campaignId));
  const now = new Date();
  res.json(
    ListCoopCampaignsResponse.parse(rows.map((row) => campaignToJson(row, tenantId, now)))
  );
});

// ── POST /coop/campaigns — launch a flash campaign inviting current partners ─
router.post("/coop/campaigns", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateCoopCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const template = parsed.data.template ?? "custom";
  if (!CAMPAIGN_TEMPLATE_SLUGS.has(template)) {
    res.status(400).json({ message: "Unknown campaign template" });
    return;
  }
  const startsAt = new Date(parsed.data.startsAt);
  const endsAt = new Date(parsed.data.endsAt);
  const now = new Date();
  if (!(startsAt < endsAt)) {
    res.status(400).json({ message: "The campaign start must be before its end" });
    return;
  }
  if (endsAt <= now) {
    res.status(400).json({ message: "The campaign window must end in the future" });
    return;
  }
  const inviteeIds = [...new Set(parsed.data.partnerTenantIds)].filter((id) => id !== tenantId);
  if (inviteeIds.length === 0) {
    res.status(400).json({ message: "Invite at least one partner business" });
    return;
  }
  // Gate: creator needs at least one accepted, active partnership, and every
  // invitee must be one of those current partners.
  const partnerIds = await activePartnerIdsOf(tenantId);
  if (partnerIds.size === 0) {
    res.status(403).json({
      message: "You need at least one accepted, active co-op partnership to launch a campaign",
    });
    return;
  }
  const outsiders = inviteeIds.filter((id) => !partnerIds.has(id));
  if (outsiders.length > 0) {
    res.status(403).json({
      message: "Campaigns can only invite your current accepted, active co-op partners",
    });
    return;
  }
  const created = await db.transaction(async (tx) => {
    const [campaign] = await tx
      .insert(coopCampaignsTable)
      .values({
        creatorTenantId: tenantId,
        template,
        name: parsed.data.name.trim(),
        perkBoostText: parsed.data.perkBoostText.trim(),
        startsAt,
        endsAt,
      })
      .returning();
    // The uniform window lives on the campaign row itself — every participant
    // shares it identically by construction. Creator joins at birth.
    await tx.insert(coopCampaignParticipantsTable).values([
      { campaignId: campaign.id, tenantId, status: "joined", respondedAt: now },
      ...inviteeIds.map((id) => ({ campaignId: campaign.id, tenantId: id, status: "invited" })),
    ]);
    return campaign;
  });
  const [row] = await loadCampaignRows([created.id]);
  res.status(201).json(CreateCoopCampaignResponse.parse(campaignToJson(row, tenantId, now)));
});

// ── POST /coop/campaigns/:id/respond — invited partner joins or declines ────
router.post("/coop/campaigns/:id/respond", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const parsed = RespondToCoopCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const [campaign] = await db
    .select()
    .from(coopCampaignsTable)
    .where(eq(coopCampaignsTable.id, id));
  if (!campaign) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const [me] = await db
    .select()
    .from(coopCampaignParticipantsTable)
    .where(
      and(
        eq(coopCampaignParticipantsTable.campaignId, id),
        eq(coopCampaignParticipantsTable.tenantId, tenantId)
      )
    );
  if (!me || campaign.creatorTenantId === tenantId) {
    res.status(403).json({ message: "Only an invited partner can respond to this campaign" });
    return;
  }
  const now = new Date();
  if (campaignPhase(campaign, now) === "ended") {
    res.status(409).json({ message: "This campaign has already ended" });
    return;
  }
  if (me.status !== "invited") {
    res.status(409).json({ message: `You already ${me.status === "joined" ? "joined" : "declined"} this campaign` });
    return;
  }
  // Conditional update guards against a concurrent double-respond.
  const [updated] = await db
    .update(coopCampaignParticipantsTable)
    .set({
      status: parsed.data.action === "join" ? "joined" : "declined",
      respondedAt: now,
    })
    .where(
      and(
        eq(coopCampaignParticipantsTable.id, me.id),
        eq(coopCampaignParticipantsTable.status, "invited")
      )
    )
    .returning();
  if (!updated) {
    res.status(409).json({ message: "This invite was already responded to" });
    return;
  }
  const [row] = await loadCampaignRows([id]);
  res.json(RespondToCoopCampaignResponse.parse(campaignToJson(row, tenantId, now)));
});

// ── POST /coop/campaigns/:id/blast — creator fires the one-time joint blast ─
router.post("/coop/campaigns/:id/blast", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const [campaign] = await db
    .select()
    .from(coopCampaignsTable)
    .where(eq(coopCampaignsTable.id, id));
  if (!campaign) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (campaign.creatorTenantId !== tenantId) {
    res.status(403).json({ message: "Only the campaign creator can trigger the blast" });
    return;
  }
  const now = new Date();
  if (campaignPhase(campaign, now) === "ended") {
    res.status(409).json({ message: "This campaign has already ended" });
    return;
  }
  // Conditional claim = send-once lock: a concurrent manual trigger or the
  // worker's auto-fire sweep can never double-blast the network.
  const [claimed] = await db
    .update(coopCampaignsTable)
    .set({ blastTriggeredAt: now, updatedAt: now })
    .where(and(eq(coopCampaignsTable.id, id), isNull(coopCampaignsTable.blastTriggeredAt)))
    .returning({ id: coopCampaignsTable.id });
  if (!claimed) {
    res.status(409).json({ message: "The blast for this campaign was already sent" });
    return;
  }
  const summary = await runCampaignBlast(id, now);
  res.json(TriggerCoopCampaignBlastResponse.parse(summary));
});

// ── GET /coop/ledger — per-partnership traffic counts, ratio, flags ─────────
// Tenant-scoped: only partnerships the requesting tenant participates in ever
// appear. Window counts cover the requested (or default) window; imbalance
// flagging always evaluates against the tenant's configured evaluation window
// and disparity margin (margin NULL = flagging off).
router.get("/coop/ledger", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const settings = await resolveSettings(tenantId);
  const evaluationDays = settings.coopReciprocityWindowDays ?? 30;
  const marginPercent = settings.coopReciprocityMarginPercent;
  const rawWindow = req.query.windowDays != null ? Number(req.query.windowDays) : null;
  const windowDays =
    rawWindow != null && Number.isInteger(rawWindow) && rawWindow >= 1 && rawWindow <= 365
      ? rawWindow
      : evaluationDays;

  const rows = await partnershipRows()
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
        )
      )
    )
    .orderBy(desc(merchantCoopPartnershipsTable.createdAt), desc(merchantCoopPartnershipsTable.id));

  const traffic = await getTrafficByPartnership(
    tenantId,
    rows.map((r) => r.partnership.id),
    windowDays,
    evaluationDays
  );
  const zero = { inbound: 0, outbound: 0 };
  const entries = rows.map((r) => {
    const t = traffic.get(r.partnership.id) ?? { window: zero, evaluation: zero, allTime: zero };
    const evalDisparity = disparityPercent(t.evaluation);
    const hasEvalTraffic = t.evaluation.inbound + t.evaluation.outbound > 0;
    return {
      partnershipId: r.partnership.id,
      partnerTenantId:
        r.partnership.hostTenantId === tenantId
          ? r.partnership.partnerTenantId
          : r.partnership.hostTenantId,
      partnerName:
        r.partnership.hostTenantId === tenantId ? r.partnerTenantName : r.hostTenantName,
      perkTitle: r.partnership.perkTitle,
      status: r.partnership.status,
      isActive: r.partnership.isActive,
      window: t.window,
      allTime: t.allTime,
      ratio: t.window.outbound === 0 ? null : t.window.inbound / t.window.outbound,
      disparityPercent: Math.round(disparityPercent(t.window) * 10) / 10,
      flagged: marginPercent != null && hasEvalTraffic && evalDisparity > marginPercent,
    };
  });
  res.json(
    GetCoopLedgerResponse.parse({ windowDays, evaluationWindowDays: evaluationDays, marginPercent, entries })
  );
});

/** Load a partnership and verify the scoped tenant participates in it. */
async function participantPartnership(
  res: Parameters<Parameters<IRouter["post"]>[1]>[1],
  tenantId: number,
  rawId: string
): Promise<MerchantCoopPartnership | null> {
  const id = Number(rawId);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return null;
  }
  const [p] = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.id, id));
  if (!p) {
    res.status(404).json({ message: "Not found" });
    return null;
  }
  if (p.hostTenantId !== tenantId && p.partnerTenantId !== tenantId) {
    res.status(403).json({ message: "You are not a participant in this partnership" });
    return null;
  }
  return p;
}

async function respondWithPartnership(
  res: { json: (body: unknown) => unknown },
  id: number,
  schema: { parse: (v: unknown) => unknown }
): Promise<void> {
  const [row] = await partnershipRows().where(eq(merchantCoopPartnershipsTable.id, id));
  res.json(schema.parse(serialize(row.partnership, row.hostTenantName, row.partnerTenantName)));
}

// ── POST /coop/partnerships/:id/renegotiate — propose revised terms ─────────
// The proposal is staged on the row; live perk/mutual terms only change when
// the other participant accepts.
router.post("/coop/partnerships/:id/renegotiate", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = ProposeCoopRenegotiationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const perkTitle = parsed.data.perkTitle?.trim() || null;
  const perkDescription = parsed.data.perkDescription?.trim() || null;
  const mutualRewardTerms = parsed.data.mutualRewardTerms?.trim() || null;
  if (!perkTitle && !perkDescription && !mutualRewardTerms) {
    res.status(400).json({ message: "Propose at least one revised term" });
    return;
  }
  const p = await participantPartnership(res, tenantId, req.params.id);
  if (!p) return;
  if (p.status !== "accepted") {
    res.status(409).json({ message: "Only accepted partnerships can be re-negotiated" });
    return;
  }
  // Conditional update: only stage the proposal if none is pending (guards a
  // concurrent double-propose the same way invite responses are guarded).
  const [updated] = await db
    .update(merchantCoopPartnershipsTable)
    .set({
      proposedPerkTitle: perkTitle ?? p.perkTitle,
      proposedPerkDescription: perkDescription,
      proposedMutualRewardTerms: mutualRewardTerms,
      renegotiationRequestedByTenantId: tenantId,
      renegotiationRequestedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(merchantCoopPartnershipsTable.id, p.id),
        isNull(merchantCoopPartnershipsTable.renegotiationRequestedByTenantId)
      )
    )
    .returning();
  if (!updated) {
    res.status(409).json({ message: "A re-negotiation proposal is already pending" });
    return;
  }
  await respondWithPartnership(res, p.id, ProposeCoopRenegotiationResponse);
});

// ── POST /coop/partnerships/:id/renegotiation/respond — accept / decline ────
router.post("/coop/partnerships/:id/renegotiation/respond", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = RespondToCoopRenegotiationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const p = await participantPartnership(res, tenantId, req.params.id);
  if (!p) return;
  if (p.renegotiationRequestedByTenantId == null) {
    res.status(409).json({ message: "No re-negotiation proposal is pending" });
    return;
  }
  if (p.renegotiationRequestedByTenantId === tenantId) {
    res.status(403).json({ message: "Only the other business can respond to this proposal" });
    return;
  }
  const accept = parsed.data.action === "accept";
  const clearProposal = {
    proposedPerkTitle: null,
    proposedPerkDescription: null,
    proposedMutualRewardTerms: null,
    renegotiationRequestedByTenantId: null,
    renegotiationRequestedAt: null,
    updatedAt: new Date(),
  };
  // Conditional update guards a concurrent double-respond.
  const [updated] = await db
    .update(merchantCoopPartnershipsTable)
    .set(
      accept
        ? {
            perkTitle: p.proposedPerkTitle ?? p.perkTitle,
            perkDescription: p.proposedPerkDescription,
            mutualRewardTerms: p.proposedMutualRewardTerms,
            ...clearProposal,
          }
        : clearProposal
    )
    .where(
      and(
        eq(merchantCoopPartnershipsTable.id, p.id),
        eq(
          merchantCoopPartnershipsTable.renegotiationRequestedByTenantId,
          p.renegotiationRequestedByTenantId
        )
      )
    )
    .returning();
  if (!updated) {
    res.status(409).json({ message: "This proposal was already responded to" });
    return;
  }
  await respondWithPartnership(res, p.id, RespondToCoopRenegotiationResponse);
});

// ── POST /coop/partnerships/:id/pause — tenant pauses from their side ───────
// Paused perks immediately stop appearing on landing pages, /coop/perks, and
// redemption validation (all of which require isActive).
router.post("/coop/partnerships/:id/pause", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const p = await participantPartnership(res, tenantId, req.params.id);
  if (!p) return;
  await db
    .update(merchantCoopPartnershipsTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(merchantCoopPartnershipsTable.id, p.id));
  await respondWithPartnership(res, p.id, PauseCoopPartnershipResponse);
});

// ── POST /coop/partnerships/:id/resume — tenant resumes a paused pact ───────
router.post("/coop/partnerships/:id/resume", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const p = await participantPartnership(res, tenantId, req.params.id);
  if (!p) return;
  if (p.status !== "accepted") {
    res.status(409).json({ message: "Only accepted partnerships can be resumed" });
    return;
  }
  await db
    .update(merchantCoopPartnershipsTable)
    .set({ isActive: true, updatedAt: new Date() })
    .where(eq(merchantCoopPartnershipsTable.id, p.id));
  await respondWithPartnership(res, p.id, ResumeCoopPartnershipResponse);
});

// ---------------------------------------------------------------------------
// Co-op community events & sponsorship sync — /api/coop/events
//
// Connected partner businesses jointly plan neighborhood events: a host
// invites its accepted co-op partners, accepted participants share the event
// calendar and materials, pool sponsorship costs through an internal ledger
// (even or weight-proportional splits — no real money movement), broadcast
// the initiative through each business's own messaging channel, and track
// foot traffic back to each storefront via per-storefront check-in codes.
// Pending/declined participants never surface anywhere customer-facing,
// mirroring the co-op perks rule. Tenant scope via x-tenant-id.
// ---------------------------------------------------------------------------

/** Load an event and assert the scoped tenant is a participant. */
async function loadEventForParticipant(
  eventId: number,
  tenantId: number,
): Promise<
  | { ok: true; row: Awaited<ReturnType<typeof loadEventRows>>[number] }
  | { ok: false; status: 403 | 404; message: string }
> {
  if (!Number.isInteger(eventId)) return { ok: false, status: 404, message: "Not found" };
  const [row] = await loadEventRows([eventId]);
  if (!row) return { ok: false, status: 404, message: "Not found" };
  if (!row.participants.some((p) => p.tenantId === tenantId)) {
    return { ok: false, status: 403, message: "Only a participating business can view this event" };
  }
  return { ok: true, row };
}

// ── GET /coop/events — shared co-op event calendar for the scoped tenant ────
router.get("/coop/events", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const mine = await db
    .select({ eventId: coopCommunityEventParticipantsTable.eventId })
    .from(coopCommunityEventParticipantsTable)
    .where(eq(coopCommunityEventParticipantsTable.tenantId, tenantId));
  const rows = await loadEventRows(mine.map((r) => r.eventId));
  const now = new Date();
  res.json(ListCoopEventsResponse.parse(rows.map((row) => serializeEvent(row, tenantId, now))));
});

// ── POST /coop/events — host a joint event inviting current partners ────────
router.post("/coop/events", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateCoopEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const startsAt = new Date(parsed.data.startsAt);
  const endsAt = new Date(parsed.data.endsAt);
  const now = new Date();
  if (!(startsAt < endsAt)) {
    res.status(400).json({ message: "The event start must be before its end" });
    return;
  }
  if (endsAt <= now) {
    res.status(400).json({ message: "The event must end in the future" });
    return;
  }
  const inviteeIds = [...new Set(parsed.data.partnerTenantIds)].filter((id) => id !== tenantId);
  if (inviteeIds.length === 0) {
    res.status(400).json({ message: "Invite at least one partner business" });
    return;
  }
  // Gate: same rule as campaigns — hosts need at least one accepted, active
  // partnership, and every invitee must be one of those current partners.
  const partnerIds = await activePartnerIdsOf(tenantId);
  if (partnerIds.size === 0) {
    res.status(403).json({
      message: "You need at least one accepted, active co-op partnership to host a joint event",
    });
    return;
  }
  const outsiders = inviteeIds.filter((id) => !partnerIds.has(id));
  if (outsiders.length > 0) {
    res.status(403).json({
      message: "Events can only invite your current accepted, active co-op partners",
    });
    return;
  }
  const created = await db.transaction(async (tx) => {
    const [event] = await tx
      .insert(coopCommunityEventsTable)
      .values({
        hostTenantId: tenantId,
        name: parsed.data.name.trim(),
        description: parsed.data.description?.trim() || null,
        location: parsed.data.location?.trim() || null,
        startsAt,
        endsAt,
        unifiedCode: newUnifiedEventCode(),
      })
      .returning();
    // The host joins its own event at birth, already accepted and holding a
    // live storefront check-in code. Invitees get theirs when they accept.
    await tx.insert(coopCommunityEventParticipantsTable).values([
      {
        eventId: event.id,
        tenantId,
        status: "accepted",
        checkinCode: newStorefrontCode(),
        respondedAt: now,
      },
      ...inviteeIds.map((id) => ({ eventId: event.id, tenantId: id, status: "invited" })),
    ]);
    return event;
  });
  const [row] = await loadEventRows([created.id]);
  res.status(201).json(CreateCoopEventResponse.parse(serializeEvent(row, tenantId, now)));
});

// ── GET /coop/events/:id — full detail: ledger, settlement, passes, stats ───
router.get("/coop/events/:id", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const loaded = await loadEventForParticipant(Number(req.params.id), tenantId);
  if (!loaded.ok) {
    res.status(loaded.status).json({ message: loaded.message });
    return;
  }
  res.json(GetCoopEventResponse.parse(await serializeEventDetail(loaded.row, tenantId)));
});

// ── POST /coop/events/:id/respond — invited partner accepts or declines ─────
router.post("/coop/events/:id/respond", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = RespondToCoopEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const loaded = await loadEventForParticipant(Number(req.params.id), tenantId);
  if (!loaded.ok) {
    // A non-participant can't respond — but keep 404 for unknown events.
    res.status(loaded.status).json({
      message: loaded.status === 403 ? "Only an invited partner can respond to this event" : loaded.message,
    });
    return;
  }
  const { row } = loaded;
  const me = row.participants.find((p) => p.tenantId === tenantId)!;
  if (row.event.hostTenantId === tenantId) {
    res.status(403).json({ message: "Only an invited partner can respond to this event" });
    return;
  }
  const now = new Date();
  if (eventPhase(row.event, now) === "ended") {
    res.status(409).json({ message: "This event has already ended" });
    return;
  }
  if (me.status !== "invited") {
    res.status(409).json({
      message: `You already ${me.status === "accepted" ? "accepted" : "declined"} this event`,
    });
    return;
  }
  const accepting = parsed.data.action === "accept";
  // Conditional update guards against a concurrent double-respond. Accepting
  // is the moment the storefront check-in code comes to life — a pending or
  // declined participant never holds a scannable code.
  const [updated] = await db
    .update(coopCommunityEventParticipantsTable)
    .set({
      status: accepting ? "accepted" : "declined",
      checkinCode: accepting ? newStorefrontCode() : null,
      respondedAt: now,
    })
    .where(
      and(
        eq(coopCommunityEventParticipantsTable.id, me.id),
        eq(coopCommunityEventParticipantsTable.status, "invited"),
      ),
    )
    .returning();
  if (!updated) {
    res.status(409).json({ message: "This invite was already responded to" });
    return;
  }
  const [fresh] = await loadEventRows([row.event.id]);
  res.json(RespondToCoopEventResponse.parse(serializeEvent(fresh, tenantId, now)));
});

// ── POST /coop/events/:id/expenses — accepted participant logs a shared cost ─
router.post("/coop/events/:id/expenses", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateCoopEventExpenseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const amountCents = Math.round(parsed.data.amount * 100);
  if (amountCents <= 0 || Math.abs(parsed.data.amount * 100 - amountCents) > 1e-6) {
    res.status(400).json({ message: "Amount must be a positive dollar value with at most 2 decimals" });
    return;
  }
  const loaded = await loadEventForParticipant(Number(req.params.id), tenantId);
  if (!loaded.ok) {
    res.status(loaded.status).json({ message: loaded.message });
    return;
  }
  const me = loaded.row.participants.find((p) => p.tenantId === tenantId)!;
  if (me.status !== "accepted") {
    res.status(403).json({ message: "Only an accepted participant can log event expenses" });
    return;
  }
  await db.insert(coopCommunityEventExpensesTable).values({
    eventId: loaded.row.event.id,
    paidByTenantId: tenantId,
    description: parsed.data.description.trim(),
    amount: (amountCents / 100).toFixed(2),
    splitMethod: parsed.data.splitMethod ?? "even",
  });
  const [fresh] = await loadEventRows([loaded.row.event.id]);
  res.status(201).json(CreateCoopEventExpenseResponse.parse(await serializeEventDetail(fresh, tenantId)));
});

// ── PATCH /coop/events/:id/participants/:tenantId — host sets share weight ──
router.patch("/coop/events/:id/participants/:tenantId", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = UpdateCoopEventParticipantBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const weightHundredths = Math.round(parsed.data.shareWeight * 100);
  if (weightHundredths <= 0 || Math.abs(parsed.data.shareWeight * 100 - weightHundredths) > 1e-6) {
    res.status(400).json({ message: "Share weight must be positive with at most 2 decimals" });
    return;
  }
  const loaded = await loadEventForParticipant(Number(req.params.id), tenantId);
  if (!loaded.ok) {
    res.status(loaded.status).json({ message: loaded.message });
    return;
  }
  if (loaded.row.event.hostTenantId !== tenantId) {
    res.status(403).json({ message: "Only the event host can set cost-share weights" });
    return;
  }
  const targetTenantId = Number(req.params.tenantId);
  const target = loaded.row.participants.find((p) => p.tenantId === targetTenantId);
  if (!target) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  await db
    .update(coopCommunityEventParticipantsTable)
    .set({ shareWeight: (weightHundredths / 100).toFixed(2) })
    .where(eq(coopCommunityEventParticipantsTable.id, target.id));
  const [fresh] = await loadEventRows([loaded.row.event.id]);
  res.json(UpdateCoopEventParticipantResponse.parse(await serializeEventDetail(fresh, tenantId)));
});

// ── POST /coop/events/:id/broadcast — host fires the one-time announcement ──
router.post("/coop/events/:id/broadcast", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const loaded = await loadEventForParticipant(Number(req.params.id), tenantId);
  if (!loaded.ok) {
    res.status(loaded.status).json({ message: loaded.message });
    return;
  }
  if (loaded.row.event.hostTenantId !== tenantId) {
    res.status(403).json({ message: "Only the event host can trigger the broadcast" });
    return;
  }
  const now = new Date();
  if (eventPhase(loaded.row.event, now) === "ended") {
    res.status(409).json({ message: "This event has already ended" });
    return;
  }
  // Conditional claim = send-once lock: concurrent triggers can never
  // double-text the combined customer bases.
  const [claimed] = await db
    .update(coopCommunityEventsTable)
    .set({ broadcastTriggeredAt: now, updatedAt: now })
    .where(
      and(
        eq(coopCommunityEventsTable.id, loaded.row.event.id),
        isNull(coopCommunityEventsTable.broadcastTriggeredAt),
      ),
    )
    .returning({ id: coopCommunityEventsTable.id });
  if (!claimed) {
    res.status(409).json({ message: "The announcement for this event was already sent" });
    return;
  }
  const summary = await runEventBroadcast(loaded.row.event.id, now);
  res.json(TriggerCoopEventBroadcastResponse.parse(summary));
});

// ── POST /coop/events/checkin — record a scanned/entered check-in code ──────
router.post("/coop/events/checkin", async (req, res): Promise<void> => {
  const parsed = CheckInCoopEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const code = parsed.data.code.trim();
  // Resolve the code: a storefront code attributes the sign-up to that
  // participant's business; the unified code counts community-level only.
  // Only accepted participants ever hold a code, so pending/declined codes
  // simply don't exist — unknown codes fail closed.
  let event: typeof coopCommunityEventsTable.$inferSelect | undefined;
  let attributedTenantId: number | null = null;
  const [byUnified] = await db
    .select()
    .from(coopCommunityEventsTable)
    .where(eq(coopCommunityEventsTable.unifiedCode, code));
  if (byUnified) {
    event = byUnified;
  } else {
    const [participant] = await db
      .select({
        participant: coopCommunityEventParticipantsTable,
        event: coopCommunityEventsTable,
      })
      .from(coopCommunityEventParticipantsTable)
      .innerJoin(
        coopCommunityEventsTable,
        eq(coopCommunityEventParticipantsTable.eventId, coopCommunityEventsTable.id),
      )
      .where(eq(coopCommunityEventParticipantsTable.checkinCode, code));
    if (participant && participant.participant.status === "accepted") {
      event = participant.event;
      attributedTenantId = participant.participant.tenantId;
    }
  }
  if (!event) {
    res.status(400).json({ message: "Unknown or inactive check-in code" });
    return;
  }
  const now = new Date();
  if (now >= event.endsAt) {
    res.status(409).json({ message: "This event has already ended" });
    return;
  }
  const [checkin] = await db
    .insert(coopCommunityEventCheckinsTable)
    .values({
      eventId: event.id,
      attributedTenantId,
      code,
      attendeeName: parsed.data.attendeeName?.trim() || null,
    })
    .returning();
  let attributedTenantName: string | null = null;
  if (attributedTenantId != null) {
    const [t] = await db
      .select({ brandName: tenantsTable.brandName })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, attributedTenantId));
    attributedTenantName = t?.brandName ?? null;
  }
  res.status(201).json(
    CheckInCoopEventResponse.parse({
      eventId: event.id,
      eventName: event.name,
      attributedTenantId,
      attributedTenantName,
      checkedInAt: checkin.checkedInAt.toISOString(),
    }),
  );
});

// ── GET /coop/perks — live partner perks for the scoped tenant ──────────────
// The single source every customer surface (checkout, receipts, pass/plan
// views) reads: only accepted AND active partnerships ever appear, so perks
// deploy on acceptance and vanish on deactivation with no manual steps.
router.get("/coop/perks", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const allRows = await partnershipRows()
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        eq(merchantCoopPartnershipsTable.isActive, true),
        // Dispute-suspended and banned partnerships never serve their perk.
        eq(merchantCoopPartnershipsTable.disputeSuspended, false),
        isNull(merchantCoopPartnershipsTable.bannedAt),
        // Performance-paused partnerships never serve their perk either.
        isNull(merchantCoopPartnershipsTable.performancePausedAt),
        // Perks outside their optional date window never reach any surface.
        perkWindowOpen(),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
        )
      )
    )
    .orderBy(desc(merchantCoopPartnershipsTable.createdAt), desc(merchantCoopPartnershipsTable.id));
  // Consumer-surface exclusion filter: this endpoint feeds every
  // customer-facing surface (checkout confirmation, receipts, pass/wallet),
  // so a competitor's or isolation-paired business's perk can never render —
  // including legacy admin-created partnerships predating the firewall.
  const visible = await filterPartnershipsForConsumerSurface(
    tenantId,
    allRows.map((r) => r.partnership)
  );
  const visibleIds = new Set(visible.map((p) => p.id));
  const rows = allRows.filter((r) => visibleIds.has(r.partnership.id));
  // Analytics: each perk served to this business's customer surfaces
  // (checkout ticket, receipt, pass) counts as one impression. Best-effort.
  // Recorded only for perks that passed the firewall filter — never-rendered
  // perks must not count as impressions.
  await recordPerkImpressionsSafe(
    tenantId,
    rows.map((r) => r.partnership),
  );
  // Boosted flash offers from live campaigns this business joined — shown on
  // the same storefront perk surfaces, only while the campaign window is open.
  const flashPerks = await flashPerksForTenant(tenantId);
  // Live surge boosts: when a traffic-routing rule has fired, the perk shows
  // its elevated discount + limited-time window on every surface, and reverts
  // automatically once the activation ends.
  const surgeBoosts = await liveSurgeBoostsByPartnership(rows.map((r) => r.partnership.id));
  // Sponsorship Hub: perks whose partnership holds an active paid boost for
  // the booking-confirmation surface render highlighted above organic perks.
  const confirmationBoosts = await activeBoostsForSurface("booking_confirmation");
  const boostedPartnershipIds = new Set(confirmationBoosts.map((b) => b.partnershipId));
  res.json(
    ListCoopActivePerksResponse.parse({
      disclaimer: COOP_PERK_DISCLAIMER,
      flashPerks,
      perks: rows
        .map((r) => ({
          surge: surgeBoosts.has(r.partnership.id)
            ? {
                baseDiscountPercent: surgeBoosts.get(r.partnership.id)!.baseDiscountPercent,
                boostedDiscountPercent: surgeBoosts.get(r.partnership.id)!.boostedDiscountPercent,
                expiresAt: surgeBoosts.get(r.partnership.id)!.expiresAt.toISOString(),
              }
            : null,
          id: r.partnership.id,
          perkTitle: r.partnership.perkTitle,
          perkDescription: r.partnership.perkDescription,
          mutualRewardTerms: r.partnership.mutualRewardTerms,
          partnerName:
            r.partnership.hostTenantId === tenantId ? r.partnerTenantName : r.hostTenantName,
          redemptionCode: r.partnership.redemptionCode,
          // Direction-aware tracking code for the scoped tenant *as sender*:
          // this tenant's customers carry it and redeem it at the partner, so
          // the redemption is attributed to this business as the referrer.
          trackingCode:
            r.partnership.hostTenantId === tenantId
              ? r.partnership.hostTrackingCode
              : r.partnership.partnerTrackingCode,
          perkEndsAt: r.partnership.perkEndsAt ? r.partnership.perkEndsAt.toISOString() : null,
          featured: boostedPartnershipIds.has(r.partnership.id),
        }))
        // Featured perks sort above organic ones (stable sort).
        .sort((a, b) => Number(b.featured) - Number(a.featured)),
    })
  );
});

// ── GET /coop/redemptions/:code — validate a perk code at checkout ──────────
// Always 200 with a valid flag so staff-facing checkout flows get a clean
// yes/no; unknown codes and inactive partnerships both fail validation.
router.get("/coop/redemptions/:code", async (req, res): Promise<void> => {
  const code = String(req.params.code).trim();
  // Wallet pass tokens (from a customer's Local Perks QR) validate through
  // the pass, which carries its own expiry and single-use state.
  if (isWalletPassToken(code)) {
    const walletRow = await findWalletPass(code);
    const outcome = walletPassState(walletRow);
    res.json(
      ValidateCoopRedemptionCodeResponse.parse({
        valid: outcome.reason == null,
        reason: outcome.reason,
        partnership: walletRow
          ? serialize(walletRow.partnership, walletRow.hostTenantName, walletRow.partnerTenantName)
          : null,
      })
    );
    return;
  }
  const [row] = await partnershipRows().where(matchesAnyCode(code));
  if (!row) {
    res.json(
      ValidateCoopRedemptionCodeResponse.parse({
        valid: false,
        reason: "Unknown redemption code",
        partnership: null,
      })
    );
    return;
  }
  // Reputation Shield: perks of decoupled businesses never redeem.
  const decoupledForValidate = await decoupledTenantIdSet();
  if (
    !row.partnership.isActive ||
    row.partnership.status !== "accepted" ||
    row.partnership.disputeSuspended ||
    row.partnership.bannedAt != null ||
    // Reputation Shield: perks of decoupled businesses never redeem.
    decoupledForValidate.has(row.partnership.hostTenantId) ||
    decoupledForValidate.has(row.partnership.partnerTenantId)
  ) {
    res.json(
      ValidateCoopRedemptionCodeResponse.parse({
        valid: false,
        reason: "This partnership is no longer active",
        partnership: serialize(row.partnership, row.hostTenantName, row.partnerTenantName),
      })
    );
    return;
  }
  const windowState = perkWindowState(row.partnership);
  if (windowState !== "open") {
    res.json(
      ValidateCoopRedemptionCodeResponse.parse({
        valid: false,
        reason:
          windowState === "expired"
            ? "This perk has expired"
            : "This perk is not active yet",
        partnership: serialize(row.partnership, row.hostTenantName, row.partnerTenantName),
      })
    );
    return;
  }
  // Analytics: a successful code check at checkout is a perk claim, recorded
  // at the business validating it (header scope when it's a participant,
  // else the perk's host business).
  const validatingTenantId = tenantIdFrom(req);
  const claimTenantId =
    validatingTenantId != null &&
    (validatingTenantId === row.partnership.hostTenantId ||
      validatingTenantId === row.partnership.partnerTenantId)
      ? validatingTenantId
      : row.partnership.hostTenantId;
  await recordCoopEventsSafe([
    {
      tenantId: claimTenantId,
      partnershipId: row.partnership.id,
      partnerTenantId:
        claimTenantId === row.partnership.hostTenantId
          ? row.partnership.partnerTenantId
          : row.partnership.hostTenantId,
      eventType: "claim",
    },
  ]);
  // Traffic ledger: a successful checkout validation means a referred
  // customer physically arrived at the validating business. Only attributable
  // when the request carries a tenant scope that is a participant.
  if (
    validatingTenantId != null &&
    (validatingTenantId === row.partnership.hostTenantId ||
      validatingTenantId === row.partnership.partnerTenantId)
  ) {
    await recordCoopTrafficEvent({
      partnershipId: row.partnership.id,
      receivingTenantId: validatingTenantId,
      sourceTenantId:
        validatingTenantId === row.partnership.hostTenantId
          ? row.partnership.partnerTenantId
          : row.partnership.hostTenantId,
      eventType: "code_validation",
    });
  }
  res.json(
    ValidateCoopRedemptionCodeResponse.parse({
      valid: true,
      reason: null,
      partnership: serialize(row.partnership, row.hostTenantName, row.partnerTenantName),
    })
  );
});

// ── POST /coop/redemptions — redeem a scanned pass, locking the instance ────
// Records which partnership + pass/code instance was redeemed, when, and by
// which tenant. The unique (partnership, passCode) constraint is the lock:
// a second scan of the same instance — even a concurrent double-scan — hits
// the constraint and is rejected as already redeemed. Always 200 with a
// valid flag, mirroring the validation endpoint.
router.post("/coop/redemptions", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = RedeemCoopPerkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const code = parsed.data.code.trim();
  const passCode = parsed.data.passCode?.trim() ?? "";

  // ── Wallet pass token path ─────────────────────────────────────────────
  // A scanned Local Perks QR encodes a single unguessable token; the pass
  // itself is the redemption instance (no separate passCode needed).
  if (isWalletPassToken(code)) {
    const walletRow = await findWalletPass(code);
    const outcome = walletPassState(walletRow);
    const partnershipJson = walletRow
      ? serialize(walletRow.partnership, walletRow.hostTenantName, walletRow.partnerTenantName)
      : null;
    if (outcome.reason != null) {
      res.json(
        RedeemCoopPerkResponse.parse({
          valid: false,
          reason: outcome.reason,
          partnership: partnershipJson,
          redeemedAt: walletRow?.pass.redeemedAt?.toISOString() ?? null,
        })
      );
      return;
    }
    // Only a party to the partnership may redeem a wallet pass — same
    // integrity rule as classic codes.
    if (
      tenantId !== walletRow!.partnership.hostTenantId &&
      tenantId !== walletRow!.partnership.partnerTenantId
    ) {
      res.json(
        RedeemCoopPerkResponse.parse({
          valid: false,
          reason: "Only a business in this partnership can redeem this perk",
          partnership: partnershipJson,
          redeemedAt: null,
        })
      );
      return;
    }
    // Conditional update is the single-use lock: of two concurrent scans of
    // the same pass, exactly one flips redeemed_at from NULL.
    const [redeemedPass] = await db
      .update(perkPassesTable)
      .set({ redeemedAt: new Date(), redeemedByTenantId: tenantId })
      .where(and(eq(perkPassesTable.token, code), isNull(perkPassesTable.redeemedAt)))
      .returning();
    if (!redeemedPass) {
      const again = await findWalletPass(code);
      res.json(
        RedeemCoopPerkResponse.parse({
          valid: false,
          reason: "This pass was already redeemed",
          partnership: partnershipJson,
          redeemedAt: again?.pass.redeemedAt?.toISOString() ?? null,
        })
      );
      return;
    }
    // Mirror the redemption into the shared ledger so partner-side reporting
    // sees wallet redemptions alongside classic pass-code redemptions.
    const [walletRedemption] = await db
      .insert(coopPerkRedemptionsTable)
      .values({
        partnershipId: walletRow!.partnership.id,
        passCode: code,
        redeemedByTenantId: tenantId,
      })
      .onConflictDoNothing()
      .returning();
    // Attribution: wallet passes are server-issued single-use tokens — the
    // strongest redemption instance we have. The scanning tenant is the
    // receiver; the other side of the partnership sent the customer.
    if (walletRedemption) {
      const wp = walletRow!.partnership;
      const walletDirection: CoopDirection =
        tenantId === wp.hostTenantId ? "partner_to_host" : "host_to_partner";
      await db
        .insert(coopAttributionEventsTable)
        .values({
          redemptionId: walletRedemption.id,
          partnershipId: wp.id,
          direction: walletDirection,
          sendingTenantId:
            walletDirection === "host_to_partner" ? wp.hostTenantId : wp.partnerTenantId,
          receivingTenantId: tenantId,
        })
        .onConflictDoNothing();
      // Neighborhood Passport: stamp the redeeming business on the wallet
      // owner's passport (phone-keyed identity). Never blocks the redemption.
      await recordPassportStampSafe({
        redeemedByTenantId: tenantId,
        redemptionId: walletRedemption.id,
        person: {
          phone: walletRow!.pass.customerPhone,
          name: walletRow!.pass.customerName,
        },
      });
      // Tax compliance ledger: log the redemption when the perk has monetary
      // terms. Observes only — never blocks or alters the redemption.
      await recordPerkRedemptionComplianceSafe({
        redemptionId: walletRedemption.id,
        redeemedByTenantId: tenantId,
        otherTenantId: tenantId === wp.hostTenantId ? wp.partnerTenantId : wp.hostTenantId,
        perkValueAmount: wp.perkValueAmount,
        perkTitle: wp.perkTitle,
        redeemedAt: redeemedPass.redeemedAt!,
      });
      // Revenue-share accounting: if the partnership carries split terms, log
      // the earning/charge wallet entries (net of the platform fee).
      await applyRedemptionSplitSafe(walletRow!.partnership, walletRedemption.id, tenantId);
    }
    res.json(
      RedeemCoopPerkResponse.parse({
        valid: true,
        reason: null,
        partnership: partnershipJson,
        redeemedAt: redeemedPass.redeemedAt!.toISOString(),
      })
    );
    return;
  }

  if (!code || !passCode) {
    res.status(400).json({ message: "Both code and passCode are required" });
    return;
  }

  const fail = (reason: string, row?: Awaited<ReturnType<typeof partnershipRows>>[number], redeemedAt: Date | null = null) => {
    res.json(
      RedeemCoopPerkResponse.parse({
        valid: false,
        reason,
        partnership: row
          ? serialize(row.partnership, row.hostTenantName, row.partnerTenantName)
          : null,
        redeemedAt: redeemedAt ? redeemedAt.toISOString() : null,
      })
    );
  };

  const [row] = await partnershipRows().where(matchesAnyCode(code));
  if (!row) {
    fail("Unknown redemption code");
    return;
  }
  const decoupledForRedeem = await decoupledTenantIdSet();
  if (
    !row.partnership.isActive ||
    row.partnership.status !== "accepted" ||
    row.partnership.disputeSuspended ||
    row.partnership.bannedAt != null ||
    // Reputation Shield: perks of decoupled businesses never redeem.
    decoupledForRedeem.has(row.partnership.hostTenantId) ||
    decoupledForRedeem.has(row.partnership.partnerTenantId)
  ) {
    fail("This partnership is no longer active", row);
    return;
  }
  const windowState = perkWindowState(row.partnership);
  if (windowState !== "open") {
    fail(windowState === "expired" ? "This perk has expired" : "This perk is not active yet", row);
    return;
  }

  // Integrity: only a business that is a party to this partnership can record
  // a redemption. Without this, any tenant holding a leaked code could write
  // redemption + attribution rows into someone else's partnership.
  if (
    tenantId !== row.partnership.hostTenantId &&
    tenantId !== row.partnership.partnerTenantId
  ) {
    fail("Only a business in this partnership can redeem this perk", row);
    return;
  }
  // Direction-aware codes must be redeemed at the RECEIVING side:
  // hostTrackingCode travels with the host's customers and is only redeemable
  // at the partner; partnerTrackingCode is the mirror. This stops a business
  // from scanning its own outbound code to inflate its "sent" count.
  if (code === row.partnership.hostTrackingCode && tenantId !== row.partnership.partnerTenantId) {
    fail("This code can only be redeemed at the partner business", row);
    return;
  }
  if (code === row.partnership.partnerTrackingCode && tenantId !== row.partnership.hostTenantId) {
    fail("This code can only be redeemed at the host business", row);
    return;
  }

  // onConflictDoNothing + returning(): exactly one of two concurrent scans
  // gets a row back; the loser sees the existing redemption instead.
  const [redemption] = await db
    .insert(coopPerkRedemptionsTable)
    .values({
      partnershipId: row.partnership.id,
      passCode,
      redeemedByTenantId: tenantId,
    })
    .onConflictDoNothing()
    .returning();
  if (!redemption) {
    const [existing] = await db
      .select({ redeemedAt: coopPerkRedemptionsTable.redeemedAt })
      .from(coopPerkRedemptionsTable)
      .where(
        and(
          eq(coopPerkRedemptionsTable.partnershipId, row.partnership.id),
          eq(coopPerkRedemptionsTable.passCode, passCode)
        )
      );
    fail("This pass was already redeemed", row, existing?.redeemedAt ?? null);
    return;
  }
  // Revenue-share accounting: if the partnership carries split terms, log
  // the earning/charge wallet entries (net of the platform fee).
  await applyRedemptionSplitSafe(row.partnership, redemption.id, tenantId);
  // Analytics: a redeemed pass is both a claim and a cross-over visit — the
  // partner's customer physically showed up at the redeeming business. The
  // crossover's revenue is attributed later, when the visit checks out.
  if (
    tenantId === row.partnership.hostTenantId ||
    tenantId === row.partnership.partnerTenantId
  ) {
    const otherTenantId =
      tenantId === row.partnership.hostTenantId
        ? row.partnership.partnerTenantId
        : row.partnership.hostTenantId;
    await recordCoopEventsSafe([
      {
        tenantId,
        partnershipId: row.partnership.id,
        partnerTenantId: otherTenantId,
        eventType: "claim",
      },
      {
        tenantId,
        partnershipId: row.partnership.id,
        partnerTenantId: otherTenantId,
        eventType: "crossover",
      },
    ]);
    // Traffic ledger: the redeeming tenant is where the referred customer
    // arrived — inbound for them, outbound for the other party.
    await recordCoopTrafficEvent({
      partnershipId: row.partnership.id,
      receivingTenantId: tenantId,
      sourceTenantId: otherTenantId,
      eventType: "code_validation",
    });
  }

  // Attribution: exactly one event per counted redemption. The direction
  // comes from which tracking code was presented; a legacy shared code is
  // attributed by who scanned it (the scanning tenant is the receiver).
  // Only the winner of the pass lock reaches this insert, and the unique
  // redemption_id makes any replay a no-op — no double counting.
  const p = row.partnership;
  const direction: CoopDirection =
    code === p.hostTrackingCode
      ? "host_to_partner"
      : code === p.partnerTrackingCode
        ? "partner_to_host"
        : tenantId === p.hostTenantId
          ? "partner_to_host"
          : "host_to_partner";
  const sendingTenantId = direction === "host_to_partner" ? p.hostTenantId : p.partnerTenantId;
  const receivingTenantId = direction === "host_to_partner" ? p.partnerTenantId : p.hostTenantId;
  await db
    .insert(coopAttributionEventsTable)
    .values({
      redemptionId: redemption.id,
      partnershipId: p.id,
      direction,
      sendingTenantId,
      receivingTenantId,
    })
    .onConflictDoNothing();

  // Neighborhood Passport: customer-pass codes ("C<id>") resolve to a person;
  // stamp the redeeming business on their cross-tenant passport. Codes with
  // no resolvable person (manual/POS receipt codes) simply don't stamp.
  const passPerson = await personFromClassicPassCode(passCode);
  if (passPerson) {
    await recordPassportStampSafe({
      redeemedByTenantId: tenantId,
      redemptionId: redemption.id,
      person: passPerson,
    });
  }

  // Tax compliance ledger: log the redemption when the perk has monetary
  // terms. Observes only — never blocks or alters the redemption.
  await recordPerkRedemptionComplianceSafe({
    redemptionId: redemption.id,
    redeemedByTenantId: tenantId,
    otherTenantId: tenantId === p.hostTenantId ? p.partnerTenantId : p.hostTenantId,
    perkValueAmount: p.perkValueAmount,
    perkTitle: p.perkTitle,
    redeemedAt: redemption.redeemedAt,
  });

  res.json(
    RedeemCoopPerkResponse.parse({
      valid: true,
      reason: null,
      partnership: serialize(row.partnership, row.hostTenantName, row.partnerTenantName),
      redeemedAt: redemption.redeemedAt.toISOString(),
    })
  );
});

// ── GET /coop/analytics/partners — per-partner performance breakdown ────────
// Tenant-scoped (x-tenant-id): for each accepted partnership this business
// participates in, the recorded impressions, claims, clients sent vs.
// received, and estimated revenue influenced, over an optional date range.
// Legacy partnerships with no recorded events return zeros.
router.get("/coop/analytics/partners", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parseDate = (v: unknown): Date | undefined => {
    if (typeof v !== "string" || !v) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);
  if ((req.query.from && !from) || (req.query.to && !to)) {
    res.status(400).json({ message: "Invalid date range" });
    return;
  }
  const rows = await partnerPerformanceForTenant(tenantId, { from, to });
  res.json(ListCoopPartnerPerformanceResponse.parse(rows));
});

// ── GET /coop/reports/monthly — persisted monthly impact reports ────────────
// Tenant-scoped (x-tenant-id): the business's generated monthly co-op impact
// reports, newest month first. Months with no report simply aren't listed —
// the hub renders an empty state.
router.get("/coop/reports/monthly", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const rows = await db
    .select()
    .from(coopMonthlyReportsTable)
    .where(eq(coopMonthlyReportsTable.tenantId, tenantId))
    .orderBy(desc(coopMonthlyReportsTable.month));
  res.json(
    ListCoopMonthlyReportsResponse.parse(
      rows.map((r) => ({
        id: r.id,
        month: r.month,
        impressions: r.impressions,
        claims: r.claims,
        crossoverVisits: r.crossoverVisits,
        revenueInfluenced: parseFloat(r.revenueInfluenced),
        createdAt: r.createdAt.toISOString(),
      }))
    )
  );
});

// ---------------------------------------------------------------------------
// Dispute resolution — merchants flag problem partners; the platform mediates
// with a 7-business-day grace window before auto-suspending the shared perk.
// ---------------------------------------------------------------------------

// ── GET /coop/disputes — disputes involving the scoped tenant ───────────────
router.get("/coop/disputes", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const rows = await disputeRows()
    .where(
      or(
        eq(coopDisputesTable.reportingTenantId, tenantId),
        eq(coopDisputesTable.reportedTenantId, tenantId)
      )
    )
    .orderBy(desc(coopDisputesTable.createdAt), desc(coopDisputesTable.id));
  res.json(
    ListCoopDisputesResponse.parse(
      rows.map((r) =>
        serializeDispute(r.dispute, r.reportingTenantName, r.reportedTenantName, r.perkTitle)
      )
    )
  );
});

// ── POST /coop/disputes — file a dispute against an active partnership ──────
// Starts the 7-business-day grace window and alerts the reported business
// owner through the unified messaging pipeline (SMS, respecting opt-in).
router.post("/coop/disputes", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateCoopDisputeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const { partnershipId, category } = parsed.data;
  const [partnership] = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
  if (!partnership) {
    res.status(404).json({ message: "Partnership not found" });
    return;
  }
  const isParty =
    partnership.hostTenantId === tenantId || partnership.partnerTenantId === tenantId;
  if (!isParty) {
    res.status(403).json({ message: "Only a party to this partnership can report an issue" });
    return;
  }
  if (
    partnership.status !== "accepted" ||
    !partnership.isActive ||
    partnership.bannedAt != null
  ) {
    res.status(409).json({ message: "Disputes can only be filed on active partnerships" });
    return;
  }

  const reportedTenantId =
    partnership.hostTenantId === tenantId ? partnership.partnerTenantId : partnership.hostTenantId;
  const now = new Date();
  let created: CoopDispute;
  try {
    [created] = await db
      .insert(coopDisputesTable)
      .values({
        partnershipId,
        reportingTenantId: tenantId,
        reportedTenantId,
        category,
        details: parsed.data.details?.trim() || null,
        status: "open",
        graceDeadlineAt: addBusinessDays(now, DISPUTE_GRACE_BUSINESS_DAYS),
      })
      .returning();
  } catch (err) {
    // Partial unique index (one live dispute per partnership) — concurrent or
    // repeat filings surface as a unique violation, not a race.
    const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code ??
      (err as { code?: string })?.code;
    if (code === "23505") {
      res.status(409).json({ message: "This partnership already has an open dispute" });
      return;
    }
    throw err;
  }

  const [row] = await disputeRows().where(eq(coopDisputesTable.id, created.id));

  // Alert the reported partner's business owner via the unified messaging
  // pipeline (public business phone). Never blocks the filing itself.
  const [reportedSettings] = await db
    .select({ publicPhone: sosSettingsTable.publicPhone })
    .from(sosSettingsTable)
    .where(eq(sosSettingsTable.tenantId, reportedTenantId));
  await sendMessageSafe({
    tenantId: reportedTenantId,
    origin: "operational",
    kind: "coop_dispute",
    toNumber: reportedSettings?.publicPhone?.trim() || null,
    body:
      `Co-Op alert: ${row.reportingTenantName} reported an issue on your "${partnership.perkTitle}" partnership ` +
      `(${category}). Please resolve it within 7 business days or the shared perk will be paused automatically.`,
    context: { disputeId: created.id, partnershipId, category },
  });

  res
    .status(201)
    .json(
      CreateCoopDisputeResponse.parse(
        serializeDispute(row.dispute, row.reportingTenantName, row.reportedTenantName, row.perkTitle)
      )
    );
});

// ── POST /coop/disputes/:id/withdraw — reporter withdraws before escalation ─
router.post("/coop/disputes/:id/withdraw", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const [dispute] = await db.select().from(coopDisputesTable).where(eq(coopDisputesTable.id, id));
  if (!dispute) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (dispute.reportingTenantId !== tenantId) {
    res.status(403).json({ message: "Only the reporting business can withdraw its dispute" });
    return;
  }
  if (dispute.status !== "open") {
    res.status(409).json({
      message:
        dispute.status === "escalated"
          ? "This dispute has already escalated — a platform admin must resolve it"
          : "This dispute is already closed",
    });
    return;
  }
  const now = new Date();
  // Conditional update guards against a concurrent escalation/withdrawal.
  const [updated] = await db
    .update(coopDisputesTable)
    .set({ status: "withdrawn", withdrawnAt: now, updatedAt: now })
    .where(and(eq(coopDisputesTable.id, id), eq(coopDisputesTable.status, "open")))
    .returning();
  if (!updated) {
    res.status(409).json({ message: "This dispute was already escalated or closed" });
    return;
  }
  // Restore the partnership immediately (defensive — an open dispute should
  // never have suspended it, but withdrawal must always leave it clean).
  await db
    .update(merchantCoopPartnershipsTable)
    .set({ disputeSuspended: false, updatedAt: now })
    .where(eq(merchantCoopPartnershipsTable.id, dispute.partnershipId));

  const [row] = await disputeRows().where(eq(coopDisputesTable.id, id));
  res.json(
    WithdrawCoopDisputeResponse.parse(
      serializeDispute(row.dispute, row.reportingTenantName, row.reportedTenantName, row.perkTitle)
    )
  );
});

// ── GET /coop/stats — cross-promotion traffic for the scoped tenant ─────────
// Per partnership and in aggregate: customers this business sent to partners
// vs. received from partners, over a rolling window (30 or 90 days). Counts
// come from attribution events (one per counted redemption), never revenue.
router.get("/coop/stats", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const windowDays = Number(req.query.windowDays ?? 30);
  if (windowDays !== 30 && windowDays !== 90) {
    res.status(400).json({ message: "windowDays must be 30 or 90" });
    return;
  }
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // All accepted partnerships this tenant participates in (active or not, so
  // history from a since-deactivated pact still shows in the window).
  const partnerships = await partnershipRows().where(
    and(
      eq(merchantCoopPartnershipsTable.status, "accepted"),
      or(
        eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
        eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
      )
    )
  );
  const ids = partnerships.map((r) => r.partnership.id);
  const events = ids.length
    ? await db
        .select({
          partnershipId: coopAttributionEventsTable.partnershipId,
          sendingTenantId: coopAttributionEventsTable.sendingTenantId,
          receivingTenantId: coopAttributionEventsTable.receivingTenantId,
        })
        .from(coopAttributionEventsTable)
        .where(
          and(
            inArray(coopAttributionEventsTable.partnershipId, ids),
            gte(coopAttributionEventsTable.occurredAt, since)
          )
        )
    : [];

  const byPartnership = new Map<number, { sent: number; received: number }>();
  let totalSent = 0;
  let totalReceived = 0;
  for (const e of events) {
    const bucket = byPartnership.get(e.partnershipId) ?? { sent: 0, received: 0 };
    if (e.sendingTenantId === tenantId) {
      bucket.sent += 1;
      totalSent += 1;
    } else if (e.receivingTenantId === tenantId) {
      bucket.received += 1;
      totalReceived += 1;
    }
    byPartnership.set(e.partnershipId, bucket);
  }

  res.json(
    GetCoopStatsResponse.parse({
      windowDays,
      totals: { sent: totalSent, received: totalReceived },
      partnerships: partnerships.map((r) => {
        const counts = byPartnership.get(r.partnership.id) ?? { sent: 0, received: 0 };
        return {
          partnershipId: r.partnership.id,
          partnerName:
            r.partnership.hostTenantId === tenantId ? r.partnerTenantName : r.hostTenantName,
          perkTitle: r.partnership.perkTitle,
          isActive: r.partnership.isActive,
          sent: counts.sent,
          received: counts.received,
        };
      }),
    })
  );
});


// ── GET /coop/plaza-notifications — in-app exclusivity notices (tenant) ─────
// Both sides of a blocked pairing see the conflict: the requester whose
// invite was blocked and the business that couldn't be invited.
router.get("/coop/plaza-notifications", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const { hostTenant: requesterT, partnerTenant: blockedT } = tenantAliases();
  const rows = await db
    .select({
      conflict: coopPlazaConflictsTable,
      requesterName: requesterT.brandName,
      blockedName: blockedT.brandName,
    })
    .from(coopPlazaConflictsTable)
    .innerJoin(requesterT, eq(coopPlazaConflictsTable.requesterTenantId, requesterT.id))
    .innerJoin(blockedT, eq(coopPlazaConflictsTable.blockedPartnerTenantId, blockedT.id))
    .where(
      or(
        eq(coopPlazaConflictsTable.requesterTenantId, tenantId),
        eq(coopPlazaConflictsTable.blockedPartnerTenantId, tenantId)
      )
    )
    .orderBy(desc(coopPlazaConflictsTable.createdAt), desc(coopPlazaConflictsTable.id));
  res.json(
    ListCoopPlazaNotificationsResponse.parse(
      rows.map((r) => {
        const role = r.conflict.requesterTenantId === tenantId ? "requester" : "blocked";
        const otherName = role === "requester" ? r.blockedName : r.requesterName;
        return {
          id: r.conflict.id,
          role,
          otherBusinessName: otherName,
          category: r.conflict.category,
          status: r.conflict.status,
          message: plazaNotificationMessage(role, otherName, r.conflict.category, r.conflict.status),
          createdAt: r.conflict.createdAt.toISOString(),
        };
      })
    )
  );
});

// ── Admin — plaza conflict review & release ─────────────────────────────────

async function serializePlazaConflicts(
  rows: { conflict: CoopPlazaConflict; requesterName: string; blockedName: string }[]
) {
  // Resolve the name of the partner in the still-referenced existing
  // partnership (the business currently holding the category).
  const partnershipIds = [
    ...new Set(rows.map((r) => r.conflict.existingPartnershipId).filter((n): n is number => n != null)),
  ];
  const holderNameByPartnership = new Map<number, string>();
  if (partnershipIds.length > 0) {
    const { hostTenant, partnerTenant } = tenantAliases();
    const partnerships = await db
      .select({
        id: merchantCoopPartnershipsTable.id,
        hostTenantId: merchantCoopPartnershipsTable.hostTenantId,
        hostName: hostTenant.brandName,
        partnerName: partnerTenant.brandName,
      })
      .from(merchantCoopPartnershipsTable)
      .innerJoin(hostTenant, eq(merchantCoopPartnershipsTable.hostTenantId, hostTenant.id))
      .innerJoin(partnerTenant, eq(merchantCoopPartnershipsTable.partnerTenantId, partnerTenant.id))
      .where(inArray(merchantCoopPartnershipsTable.id, partnershipIds));
    for (const r of rows) {
      const p = partnerships.find((x) => x.id === r.conflict.existingPartnershipId);
      if (!p) continue;
      holderNameByPartnership.set(
        p.id,
        p.hostTenantId === r.conflict.requesterTenantId ? p.partnerName : p.hostName
      );
    }
  }
  return rows.map((r) => ({
    id: r.conflict.id,
    requesterTenantId: r.conflict.requesterTenantId,
    requesterTenantName: r.requesterName,
    blockedPartnerTenantId: r.conflict.blockedPartnerTenantId,
    blockedPartnerTenantName: r.blockedName,
    existingPartnershipId: r.conflict.existingPartnershipId,
    existingPartnerTenantName:
      r.conflict.existingPartnershipId != null
        ? holderNameByPartnership.get(r.conflict.existingPartnershipId) ?? null
        : null,
    category: r.conflict.category,
    status: r.conflict.status,
    releasedAt: r.conflict.releasedAt ? r.conflict.releasedAt.toISOString() : null,
    createdAt: r.conflict.createdAt.toISOString(),
  }));
}

function plazaConflictRows() {
  const { hostTenant: requesterT, partnerTenant: blockedT } = tenantAliases();
  return db
    .select({
      conflict: coopPlazaConflictsTable,
      requesterName: requesterT.brandName,
      blockedName: blockedT.brandName,
    })
    .from(coopPlazaConflictsTable)
    .innerJoin(requesterT, eq(coopPlazaConflictsTable.requesterTenantId, requesterT.id))
    .innerJoin(blockedT, eq(coopPlazaConflictsTable.blockedPartnerTenantId, blockedT.id));
}

// ── GET /coop/plaza-conflicts — admin list ──────────────────────────────────
// Platform-admin-only (also classified in authorizeTenantAccess); the route
// guard is defense in depth so a middleware regression can't expose it.
router.get("/coop/plaza-conflicts", async (req, res): Promise<void> => {
  if (!sessionIsPlatformAdmin(req)) {
    res.status(403).json({ message: "This operation requires platform administrator access" });
    return;
  }
  const rows = await plazaConflictRows().orderBy(
    desc(coopPlazaConflictsTable.createdAt),
    desc(coopPlazaConflictsTable.id)
  );
  res.json(ListCoopPlazaConflictsResponse.parse(await serializePlazaConflicts(rows)));
});

// ── POST /coop/plaza-conflicts/:id/release — admin-only override ────────────
// Releasing marks the exclusivity as lifted for that exact (requester,
// blocked partner, category) pairing, letting a retried invite through.
// Never tenant-facing: only the admin console calls this.
router.post("/coop/plaza-conflicts/:id/release", async (req, res): Promise<void> => {
  if (!sessionIsPlatformAdmin(req)) {
    res.status(403).json({ message: "This operation requires platform administrator access" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  // Conditional update guards against a concurrent double-release.
  const [updated] = await db
    .update(coopPlazaConflictsTable)
    .set({ status: "released", releasedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(coopPlazaConflictsTable.id, id), eq(coopPlazaConflictsTable.status, "active")))
    .returning();
  if (!updated) {
    const [existing] = await db
      .select({ status: coopPlazaConflictsTable.status })
      .from(coopPlazaConflictsTable)
      .where(eq(coopPlazaConflictsTable.id, id));
    if (!existing) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    res.status(409).json({ message: "This conflict was already released" });
    return;
  }
  const [row] = await plazaConflictRows().where(eq(coopPlazaConflictsTable.id, id));
  res.json(ReleaseCoopPlazaConflictResponse.parse((await serializePlazaConflicts([row]))[0]));
});

// ── Neighborhood Passport — merchant sponsorship console ────────────────────
// Merchants create/sponsor milestone challenges (redeem perks at N distinct
// partner businesses within M days → automated reward) and see how many
// customers completed them. All routes tenant-scoped via x-tenant-id.

type PassportChallengeRow = typeof passportChallengesTable.$inferSelect;

function serializePassportChallenge(c: PassportChallengeRow, completionCount: number) {
  return {
    id: c.id,
    sponsorTenantId: c.sponsorTenantId,
    title: c.title,
    requiredBusinesses: c.requiredBusinesses,
    windowDays: c.windowDays,
    rewardType: c.rewardType,
    rewardDescription: c.rewardDescription,
    startsAt: c.startsAt ? c.startsAt.toISOString() : null,
    endsAt: c.endsAt ? c.endsAt.toISOString() : null,
    isActive: c.isActive,
    completionCount,
    createdAt: c.createdAt.toISOString(),
  };
}

/** Validate an optional challenge date window; returns an error message or null. */
function validateChallengeWindow(
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
): string | null {
  const parse = (v: string | null | undefined): Date | null | "invalid" => {
    if (v == null) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "invalid" : d;
  };
  const start = parse(startsAt);
  const end = parse(endsAt);
  if (start === "invalid" || end === "invalid") return "Invalid challenge date";
  if (start && end && end <= start) return "The challenge end date must be after the start date";
  return null;
}

// GET /coop/passport/challenges — the scoped tenant's sponsored challenges.
router.get("/coop/passport/challenges", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const [rows, counts] = await Promise.all([
    db
      .select()
      .from(passportChallengesTable)
      .where(eq(passportChallengesTable.sponsorTenantId, tenantId))
      .orderBy(desc(passportChallengesTable.createdAt), desc(passportChallengesTable.id)),
    challengeCompletionCounts(tenantId),
  ]);
  res.json(
    ListPassportChallengesResponse.parse(
      rows.map((c) => serializePassportChallenge(c, counts.get(c.id) ?? 0)),
    ),
  );
});

// POST /coop/passport/challenges — sponsor a new milestone challenge.
router.post("/coop/passport/challenges", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreatePassportChallengeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const body = parsed.data;
  const windowError = validateChallengeWindow(body.startsAt, body.endsAt);
  if (windowError) {
    res.status(400).json({ message: windowError });
    return;
  }
  if (!PASSPORT_REWARD_TYPES.includes(body.rewardType)) {
    res.status(400).json({ message: "Unknown reward type" });
    return;
  }
  const [created] = await db
    .insert(passportChallengesTable)
    .values({
      sponsorTenantId: tenantId,
      title: body.title.trim(),
      requiredBusinesses: body.requiredBusinesses,
      windowDays: body.windowDays,
      rewardType: body.rewardType,
      rewardDescription: body.rewardDescription.trim(),
      startsAt: body.startsAt ? new Date(body.startsAt) : null,
      endsAt: body.endsAt ? new Date(body.endsAt) : null,
    })
    .returning();
  res.status(201).json(CreatePassportChallengeResponse.parse(serializePassportChallenge(created, 0)));
});

// PATCH /coop/passport/challenges/:id — edit / activate / deactivate.
router.patch("/coop/passport/challenges/:id", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const parsed = UpdatePassportChallengeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const body = parsed.data;
  // Only the sponsor may edit its own challenge.
  const [existing] = await db
    .select()
    .from(passportChallengesTable)
    .where(
      and(eq(passportChallengesTable.id, id), eq(passportChallengesTable.sponsorTenantId, tenantId)),
    );
  if (!existing) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const nextStartsAt =
    body.startsAt !== undefined ? (body.startsAt ? body.startsAt : null) : undefined;
  const nextEndsAt = body.endsAt !== undefined ? (body.endsAt ? body.endsAt : null) : undefined;
  const windowError = validateChallengeWindow(
    nextStartsAt !== undefined ? nextStartsAt : (existing.startsAt?.toISOString() ?? null),
    nextEndsAt !== undefined ? nextEndsAt : (existing.endsAt?.toISOString() ?? null),
  );
  if (windowError) {
    res.status(400).json({ message: windowError });
    return;
  }
  const updates: Partial<typeof passportChallengesTable.$inferInsert> = { updatedAt: new Date() };
  if (body.title !== undefined) updates.title = body.title.trim();
  if (body.requiredBusinesses !== undefined) updates.requiredBusinesses = body.requiredBusinesses;
  if (body.windowDays !== undefined) updates.windowDays = body.windowDays;
  if (body.rewardType !== undefined) updates.rewardType = body.rewardType;
  if (body.rewardDescription !== undefined) updates.rewardDescription = body.rewardDescription.trim();
  if (nextStartsAt !== undefined) updates.startsAt = nextStartsAt ? new Date(nextStartsAt) : null;
  if (nextEndsAt !== undefined) updates.endsAt = nextEndsAt ? new Date(nextEndsAt) : null;
  if (body.isActive !== undefined) updates.isActive = body.isActive;
  const [updated] = await db
    .update(passportChallengesTable)
    .set(updates)
    .where(eq(passportChallengesTable.id, id))
    .returning();
  const counts = await challengeCompletionCounts(tenantId);
  res.json(
    UpdatePassportChallengeResponse.parse(
      serializePassportChallenge(updated, counts.get(updated.id) ?? 0),
    ),
  );
});

// ═══ Co-Op Review & Reputation Shield ════════════════════════════════════════
// Internal B2B ratings between partners. STRICTLY INTERNAL: served only
// through these authenticated, tenant-scoped endpoints — never on public
// landing pages, customer perk surfaces, or the customer review system.

function serializeRating(r: CoopPartnerRating) {
  return {
    id: r.id,
    partnershipId: r.partnershipId,
    raterTenantId: r.raterTenantId,
    ratedTenantId: r.ratedTenantId,
    reliability: r.reliability,
    professionalism: r.professionalism,
    trafficValue: r.trafficValue,
    comment: r.comment,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ── PUT /coop/partnerships/:id/rating — rate a partner ──────────────────────
// One rating per rater per partner per rolling period: re-rating inside the
// period updates the latest rating; a new period supersedes the old one
// (kept, non-current, for audit and recency-weighted history).
router.put("/coop/partnerships/:id/rating", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Partnership not found" });
    return;
  }
  const parsed = SubmitCoopPartnerRatingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const [partnership] = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.id, id));
  if (!partnership) {
    res.status(404).json({ message: "Partnership not found" });
    return;
  }
  if (partnership.hostTenantId !== tenantId && partnership.partnerTenantId !== tenantId) {
    res.status(403).json({ message: "Only a party to this partnership can rate it" });
    return;
  }
  if (partnership.status !== "accepted") {
    res.status(409).json({ message: "Only accepted partnerships can be rated" });
    return;
  }
  const ratedTenantId =
    partnership.hostTenantId === tenantId ? partnership.partnerTenantId : partnership.hostTenantId;
  const now = new Date();
  const values = {
    reliability: parsed.data.reliability,
    professionalism: parsed.data.professionalism,
    trafficValue: parsed.data.trafficValue,
    comment: parsed.data.comment?.trim() || null,
  };

  const [current] = await db
    .select()
    .from(coopPartnerRatingsTable)
    .where(
      and(
        eq(coopPartnerRatingsTable.raterTenantId, tenantId),
        eq(coopPartnerRatingsTable.ratedTenantId, ratedTenantId),
        eq(coopPartnerRatingsTable.isCurrent, true)
      )
    );

  const withinPeriod =
    current != null &&
    now.getTime() - current.createdAt.getTime() < RATING_PERIOD_DAYS * 86_400_000;

  let saved: CoopPartnerRating;
  if (current && withinPeriod) {
    // Update the latest rating in place within the rolling period.
    [saved] = await db
      .update(coopPartnerRatingsTable)
      .set({ ...values, partnershipId: id, updatedAt: now })
      .where(eq(coopPartnerRatingsTable.id, current.id))
      .returning();
  } else {
    // New period (or first rating): supersede the previous current rating.
    if (current) {
      await db
        .update(coopPartnerRatingsTable)
        .set({ isCurrent: false, updatedAt: now })
        .where(eq(coopPartnerRatingsTable.id, current.id));
    }
    try {
      [saved] = await db
        .insert(coopPartnerRatingsTable)
        .values({
          partnershipId: id,
          raterTenantId: tenantId,
          ratedTenantId,
          ...values,
          isCurrent: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    } catch (err) {
      const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code ??
        (err as { code?: string })?.code;
      if (code === "23505") {
        // Concurrent submit won the partial-unique race — treat as conflict.
        res.status(409).json({ message: "A rating was just submitted — refresh and try again" });
        return;
      }
      throw err;
    }
  }
  res.json(SubmitCoopPartnerRatingResponse.parse(serializeRating(saved)));
});

// ── GET /coop/reputation — partner reputation overview (internal only) ──────
// The scoped tenant's own Reputation Shield status plus, for every business
// it has an accepted partnership with, the partner's aggregate score,
// per-dimension averages, flag/decouple status, and the viewer's own latest
// rating. Never exposed publicly.
router.get("/coop/reputation", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const partnerships = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
        )
      )
    )
    .orderBy(desc(merchantCoopPartnershipsTable.createdAt));

  const partnerIds = [
    ...new Set(
      partnerships.map((p) =>
        p.hostTenantId === tenantId ? p.partnerTenantId : p.hostTenantId
      )
    ),
  ];
  // Latest accepted partnership per partner drives the "rate this partner"
  // action in the hub.
  const partnershipByPartner = new Map<number, number>();
  for (const p of partnerships) {
    const other = p.hostTenantId === tenantId ? p.partnerTenantId : p.hostTenantId;
    if (!partnershipByPartner.has(other)) partnershipByPartner.set(other, p.id);
  }

  const [computed, names, states, myRatings, selfStates] = await Promise.all([
    computeReputations(partnerIds),
    partnerIds.length
      ? db
          .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
          .from(tenantsTable)
          .where(inArray(tenantsTable.id, partnerIds))
      : Promise.resolve([]),
    partnerIds.length
      ? db
          .select()
          .from(coopReputationStatesTable)
          .where(inArray(coopReputationStatesTable.tenantId, partnerIds))
      : Promise.resolve([]),
    db
      .select()
      .from(coopPartnerRatingsTable)
      .where(
        and(
          eq(coopPartnerRatingsTable.raterTenantId, tenantId),
          eq(coopPartnerRatingsTable.isCurrent, true)
        )
      ),
    db
      .select()
      .from(coopReputationStatesTable)
      .where(eq(coopReputationStatesTable.tenantId, tenantId)),
  ]);
  const nameById = new Map(names.map((t) => [t.id, t.brandName]));
  const stateById = new Map(states.map((s) => [s.tenantId, s]));
  const myRatingByPartner = new Map(myRatings.map((r) => [r.ratedTenantId, r]));
  const self = selfStates[0] ?? null;

  res.json(
    GetCoopReputationOverviewResponse.parse({
      minRaters: REPUTATION_MIN_RATERS,
      threshold: REPUTATION_FLAG_THRESHOLD,
      ratingPeriodDays: RATING_PERIOD_DAYS,
      self: self
        ? {
            status: self.status,
            score: self.score == null ? null : Number(self.score),
            flaggedAt: self.flaggedAt?.toISOString() ?? null,
            decoupledAt: self.decoupledAt?.toISOString() ?? null,
          }
        : null,
      partners: partnerIds.map((pid) => {
        const comp = computed.get(pid)!;
        const state = stateById.get(pid);
        const mine = myRatingByPartner.get(pid);
        return {
          tenantId: pid,
          tenantName: nameById.get(pid) ?? "Unknown business",
          partnershipId: partnershipByPartner.get(pid) ?? null,
          score: comp.score,
          raterCount: comp.raterCount,
          sufficient: comp.score != null,
          dimensions: comp.dimensions,
          status: state?.status ?? "ok",
          myRating: mine ? serializeRating(mine) : null,
        };
      }),
    })
  );
});

export default router;
