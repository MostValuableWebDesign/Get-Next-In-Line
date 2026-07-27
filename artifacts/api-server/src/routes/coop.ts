import { Router, type Request, type IRouter } from "express";
import { randomBytes } from "crypto";
import {
  db,
  tenantsTable,
  modulesTable,
  tenantModulesTable,
  merchantCoopPartnershipsTable,
  coopPerkRedemptionsTable,
  sosSettingsTable,
  type MerchantCoopPartnership,
} from "@workspace/db";
import { perkPassesTable } from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { isWalletPassToken, findWalletPass, type WalletPassRow } from "../lib/perkPasses";
import {
  COOP_PERK_DISCLAIMER,
  perkWindowOpen,
  perkWindowState,
  validatePerkWindow,
} from "../lib/coopPerks";
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
} from "@workspace/api-zod";
import { platformInvitesTable } from "@workspace/db";
import {
  generateInviteToken,
  inviteExpiryDate,
  buildInviteUrl,
  buildInviteMessage,
  effectiveInviteStatus,
} from "../lib/platformInvites";

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
    isActive: p.isActive,
    createdAt: p.createdAt.toISOString(),
  };
}

/** Tenant scope from the x-tenant-id header (same convention as /api/sos). */
function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Exact tenant-facing copy the UI shows when the guardrail blocks a pairing.
const SAME_INDUSTRY_MESSAGE = "Same-industry pairings are restricted by platform guidelines.";

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

// ── GET /coop/partnerships — list, optionally filtered to one tenant ────────
router.get("/coop/partnerships", async (req, res): Promise<void> => {
  const rawTenantId = req.query.tenantId;
  const tenantId = rawTenantId != null ? Number(rawTenantId) : null;
  let query = partnershipRows()
    .orderBy(desc(merchantCoopPartnershipsTable.createdAt), desc(merchantCoopPartnershipsTable.id))
    .$dynamic();
  if (tenantId != null && Number.isInteger(tenantId)) {
    query = query.where(
      or(
        eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
        eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
      )
    );
  }
  const rows = await query;
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
router.patch("/coop/partnerships/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
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
  // Fetch the existing row when needed to validate the merged date window or
  // the activation transition.
  const touchesWindow =
    parsed.data.perkStartsAt !== undefined || parsed.data.perkEndsAt !== undefined;
  if (updates.isActive === true || touchesWindow) {
    const [existing] = await db
      .select({
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

// ── GET /coop/directory — other businesses on the platform ──────────────────
// Safe, public-ish profile only (name, category, city); never contacts, MRR,
// or module details. Flags same-industry businesses so the UI can warn before
// an invite is even attempted.
router.get("/coop/directory", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const [me] = await db
    .select({
      businessCategory: sosSettingsTable.businessCategory,
      industryType: sosSettingsTable.industryType,
    })
    .from(sosSettingsTable)
    .where(eq(sosSettingsTable.tenantId, tenantId));
  const myIndustry = industryOf(me);

  const rows = await db
    .select({
      id: tenantsTable.id,
      name: tenantsTable.brandName,
      businessCategory: sosSettingsTable.businessCategory,
      industryType: sosSettingsTable.industryType,
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
      const industry = industryOf(
        r.businessCategory != null && r.industryType != null
          ? { businessCategory: r.businessCategory, industryType: r.industryType }
          : null
      );
      // Display casing: prefer the raw profile values over the lowercased key.
      const category = (r.businessCategory?.trim() || r.industryType?.trim()) ?? null;
      return {
        id: r.id,
        name: r.name,
        category: category || null,
        city: r.city?.trim() || null,
        sameIndustry: myIndustry != null && industry != null && industry === myIndustry,
      };
    })
    .filter((e) => !search || e.name.toLowerCase().includes(search))
    .filter((e) => !cityFilter || (e.city ?? "").toLowerCase() === cityFilter)
    .filter((e) => !categoryFilter || (e.category ?? "").toLowerCase() === categoryFilter);

  res.json(ListCoopDirectoryResponse.parse(entries));
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

  const settings = await db
    .select({
      tenantId: sosSettingsTable.tenantId,
      businessCategory: sosSettingsTable.businessCategory,
      industryType: sosSettingsTable.industryType,
    })
    .from(sosSettingsTable)
    .where(inArray(sosSettingsTable.tenantId, [tenantId, partnerTenantId]));
  const mine = industryOf(settings.find((s) => s.tenantId === tenantId));
  const theirs = industryOf(settings.find((s) => s.tenantId === partnerTenantId));
  if (mine != null && theirs != null && mine === theirs) {
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
  const rows = await partnershipRows()
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        eq(merchantCoopPartnershipsTable.isActive, true),
        // Perks outside their optional date window never reach any surface.
        perkWindowOpen(),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
        )
      )
    )
    .orderBy(desc(merchantCoopPartnershipsTable.createdAt), desc(merchantCoopPartnershipsTable.id));
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
  if (!row.partnership.isActive || row.partnership.status !== "accepted") {
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
  if (!row.partnership.isActive || row.partnership.status !== "accepted") {
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
  res.json(
    RedeemCoopPerkResponse.parse({
      valid: true,
      reason: null,
      partnership: serialize(row.partnership, row.hostTenantName, row.partnerTenantName),
      redeemedAt: redemption.redeemedAt.toISOString(),
    })
  );
});

export default router;
