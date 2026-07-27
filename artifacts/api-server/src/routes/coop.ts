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
  sosSettingsTable,
  type MerchantCoopPartnership,
  type CoopDispute,
} from "@workspace/db";
import { perkPassesTable } from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { isWalletPassToken, findWalletPass, type WalletPassRow } from "../lib/perkPasses";
import { sendMessageSafe } from "../lib/messaging";
import { sessionIsPlatformAdmin } from "../middlewares/tenantAccess";
import {
  COOP_PERK_DISCLAIMER,
  perkWindowOpen,
  perkWindowState,
  validatePerkWindow,
} from "../lib/coopPerks";
import {
  recordCoopEventsSafe,
  recordPerkImpressionsSafe,
  partnerPerformanceForTenant,
} from "../lib/coopEvents";
import { coopMonthlyReportsTable } from "@workspace/db";
import {
  ListCoopPartnershipsResponse,
  CreateCoopPartnershipBody,
  CreateCoopPartnershipResponse,
  UpdateCoopPartnershipBody,
  UpdateCoopPartnershipResponse,
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
} from "@workspace/api-zod";
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
    perkStartsAt: p.perkStartsAt ? p.perkStartsAt.toISOString() : null,
    perkEndsAt: p.perkEndsAt ? p.perkEndsAt.toISOString() : null,
    disputeSuspended: p.disputeSuspended,
    bannedAt: p.bannedAt ? p.bannedAt.toISOString() : null,
    isActive: p.isActive,
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
  if (row.pass.redeemedAt != null) return { reason: "This pass was already redeemed" };
  if (row.pass.expiresAt <= new Date()) return { reason: "This pass has expired" };
  return { reason: null };
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
          perkStartsAt: parsed.data.perkStartsAt ? new Date(parsed.data.perkStartsAt) : null,
          perkEndsAt: parsed.data.perkEndsAt ? new Date(parsed.data.perkEndsAt) : null,
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
  if (parsed.data.perkStartsAt !== undefined)
    updates.perkStartsAt = parsed.data.perkStartsAt ? new Date(parsed.data.perkStartsAt) : null;
  if (parsed.data.perkEndsAt !== undefined)
    updates.perkEndsAt = parsed.data.perkEndsAt ? new Date(parsed.data.perkEndsAt) : null;
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
  const isolated = await isolationPartnersOf(tenantId);

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
    })
    .from(tenantsTable)
    .leftJoin(sosSettingsTable, eq(sosSettingsTable.tenantId, tenantsTable.id))
    .where(and(ne(tenantsTable.id, tenantId), eq(tenantsTable.status, "active")))
    .orderBy(tenantsTable.brandName);

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
        },
      };
    })
    // Discovery-level firewall: same L2 sub-category or isolation-paired
    // businesses never appear — the block happens here, not at invite time.
    .filter(({ profile, entry }) => !isBlockedPair(me, profile, isolated.has(entry.id)))
    // Proximity scope: viewer's radius (coords), city fallback otherwise.
    .filter(({ profile }) => withinDiscoveryRange(me, profile))
    .map(({ entry }) => entry)
    .filter((e) => !search || e.name.toLowerCase().includes(search))
    .filter((e) => !cityFilter || (e.city ?? "").toLowerCase() === cityFilter)
    .filter((e) => !categoryFilter || (e.category ?? "").toLowerCase() === categoryFilter);

  res.json(ListCoopDirectoryResponse.parse(entries));
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
  const [suggestions, myProfiles, stored] = await Promise.all([
    computeSuggestions(tenantId),
    loadCoopProfiles([tenantId]),
    db
      .select({ id: coopSuggestionsTable.id })
      .from(coopSuggestionsTable)
      .where(eq(coopSuggestionsTable.tenantId, tenantId))
      .limit(1),
  ]);
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
  const [profiles, isolated] = await Promise.all([
    loadCoopProfiles([tenantId, partnerTenantId]),
    isolationPartnersOf(tenantId),
  ]);
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
  res.json(
    ListCoopActivePerksResponse.parse({
      disclaimer: COOP_PERK_DISCLAIMER,
      perks: rows.map((r) => ({
        id: r.partnership.id,
        perkTitle: r.partnership.perkTitle,
        perkDescription: r.partnership.perkDescription,
        mutualRewardTerms: r.partnership.mutualRewardTerms,
        partnerName:
          r.partnership.hostTenantId === tenantId ? r.partnerTenantName : r.hostTenantName,
        redemptionCode: r.partnership.redemptionCode,
        perkEndsAt: r.partnership.perkEndsAt ? r.partnership.perkEndsAt.toISOString() : null,
      })),
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
  const [row] = await partnershipRows().where(
    eq(merchantCoopPartnershipsTable.redemptionCode, code)
  );
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
  if (
    !row.partnership.isActive ||
    row.partnership.status !== "accepted" ||
    row.partnership.disputeSuspended ||
    row.partnership.bannedAt != null
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
    await db
      .insert(coopPerkRedemptionsTable)
      .values({
        partnershipId: walletRow!.partnership.id,
        passCode: code,
        redeemedByTenantId: tenantId,
      })
      .onConflictDoNothing();
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

  const [row] = await partnershipRows().where(
    eq(merchantCoopPartnershipsTable.redemptionCode, code)
  );
  if (!row) {
    fail("Unknown redemption code");
    return;
  }
  if (
    !row.partnership.isActive ||
    row.partnership.status !== "accepted" ||
    row.partnership.disputeSuspended ||
    row.partnership.bannedAt != null
  ) {
    fail("This partnership is no longer active", row);
    return;
  }
  const windowState = perkWindowState(row.partnership);
  if (windowState !== "open") {
    fail(windowState === "expired" ? "This perk has expired" : "This perk is not active yet", row);
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
  }
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

export default router;
