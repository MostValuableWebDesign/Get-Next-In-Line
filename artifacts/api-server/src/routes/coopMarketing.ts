import { Router, type IRouter, type Request } from "express";
import {
  db,
  merchantCoopPartnershipsTable,
  coopMarketingChannelsTable,
  coopMarketingCampaignsTable,
  coopMarketingParticipantsTable,
} from "@workspace/db";
import {
  CreateCoopMarketingChannelBody,
  SuggestCoopMarketingCopyBody,
  CreateCoopMarketingCampaignBody,
  RespondToCoopMarketingCampaignBody,
} from "@workspace/api-zod";
import { and, desc, eq, or } from "drizzle-orm";
import {
  MARKETING_TEMPLATES,
  MARKETING_TEMPLATE_SLUGS,
  brandingForTenants,
  suggestMarketingCopy,
  socialPostingMode,
  loadMarketingCampaignRows,
  serializeMarketingCampaign,
  allParticipantsApproved,
  dispatchMarketingCampaign,
  campaignAnalytics,
  type MarketingCampaignRow,
} from "../lib/coopMarketing";

// ── Co-op Marketing & Social Syndication Hub routes ──────────────────────────
// Tenant scope follows the /coop convention: the x-tenant-id header IS the
// acting tenant (authorized upstream by the tenant-access middleware) and the
// caller is treated strictly as that tenant — no platform-admin bypass on
// visibility checks. Only accepted co-op partners can be campaign
// participants, and every participant must approve before any dispatch.

const router: IRouter = Router();

function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Load a partnership and verify the tenant is one of its two parties. */
async function partnershipForTenant(partnershipId: number, tenantId: number) {
  const [p] = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
  if (!p) return { partnership: null, isParty: false } as const;
  const isParty = p.hostTenantId === tenantId || p.partnerTenantId === tenantId;
  return { partnership: p, isParty } as const;
}

function serializeChannel(c: {
  id: number;
  tenantId: number;
  platform: string;
  handle: string;
  accessToken: string | null;
  createdAt: Date;
}) {
  // accessToken is NEVER serialized.
  return {
    id: c.id,
    tenantId: c.tenantId,
    platform: c.platform as "instagram" | "facebook",
    handle: c.handle,
    mode: c.accessToken && socialPostingMode() === "live" ? ("live" as const) : ("simulated" as const),
    createdAt: c.createdAt.toISOString(),
  };
}

// ── Templates ────────────────────────────────────────────────────────────────

router.get("/coop/marketing/templates", (_req, res): void => {
  res.json(MARKETING_TEMPLATES);
});

// ── Branding for a partnership (both sides) ──────────────────────────────────

router.get("/coop/marketing/branding", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const partnershipId = Number(req.query.partnershipId);
  if (!Number.isInteger(partnershipId)) {
    res.status(400).json({ message: "partnershipId query parameter is required" });
    return;
  }
  const { partnership, isParty } = await partnershipForTenant(partnershipId, tenantId);
  if (!partnership) {
    res.status(404).json({ message: "Partnership not found" });
    return;
  }
  if (!isParty) {
    res.status(403).json({ message: "You are not a party to this partnership" });
    return;
  }
  const branding = await brandingForTenants([
    partnership.hostTenantId,
    partnership.partnerTenantId,
  ]);
  const host = branding.find((b) => b.tenantId === partnership.hostTenantId);
  const partner = branding.find((b) => b.tenantId === partnership.partnerTenantId);
  if (!host || !partner) {
    res.status(404).json({ message: "Partnership not found" });
    return;
  }
  res.json({ partnershipId, perkTitle: partnership.perkTitle, host, partner });
});

// ── Channel connections ──────────────────────────────────────────────────────

router.get("/coop/marketing/channels", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const rows = await db
    .select()
    .from(coopMarketingChannelsTable)
    .where(eq(coopMarketingChannelsTable.tenantId, tenantId))
    .orderBy(coopMarketingChannelsTable.platform);
  res.json(rows.map(serializeChannel));
});

router.post("/coop/marketing/channels", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateCoopMarketingChannelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const existing = await db
    .select({ id: coopMarketingChannelsTable.id })
    .from(coopMarketingChannelsTable)
    .where(
      and(
        eq(coopMarketingChannelsTable.tenantId, tenantId),
        eq(coopMarketingChannelsTable.platform, parsed.data.platform),
      ),
    );
  if (existing.length > 0) {
    res.status(409).json({ message: `${parsed.data.platform} is already connected` });
    return;
  }
  const [row] = await db
    .insert(coopMarketingChannelsTable)
    .values({ tenantId, platform: parsed.data.platform, handle: parsed.data.handle.trim() })
    .returning();
  res.status(201).json(serializeChannel(row));
});

router.delete("/coop/marketing/channels/:id", async (req, res): Promise<void> => {
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
  const [deleted] = await db
    .delete(coopMarketingChannelsTable)
    .where(
      and(eq(coopMarketingChannelsTable.id, id), eq(coopMarketingChannelsTable.tenantId, tenantId)),
    )
    .returning();
  if (!deleted) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  res.status(204).end();
});

// ── AI copy suggestion ───────────────────────────────────────────────────────

router.post("/coop/marketing/copy", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = SuggestCoopMarketingCopyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const { partnership, isParty } = await partnershipForTenant(parsed.data.partnershipId, tenantId);
  if (!partnership) {
    res.status(404).json({ message: "Partnership not found" });
    return;
  }
  if (!isParty) {
    res.status(403).json({ message: "You are not a party to this partnership" });
    return;
  }
  const branding = await brandingForTenants([
    partnership.hostTenantId,
    partnership.partnerTenantId,
  ]);
  const hostName = branding.find((b) => b.tenantId === partnership.hostTenantId)?.name ?? "";
  const partnerName = branding.find((b) => b.tenantId === partnership.partnerTenantId)?.name ?? "";
  const copy = await suggestMarketingCopy(
    hostName,
    partnerName,
    parsed.data.offerText?.trim() || partnership.perkTitle,
    parsed.data.templateSlug,
  );
  res.json(copy);
});

// ── Campaigns ────────────────────────────────────────────────────────────────

router.get("/coop/marketing/campaigns", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const mine = await db
    .select({ campaignId: coopMarketingParticipantsTable.campaignId })
    .from(coopMarketingParticipantsTable)
    .where(eq(coopMarketingParticipantsTable.tenantId, tenantId));
  const rows = await loadMarketingCampaignRows(mine.map((m) => m.campaignId));
  res.json(rows.map((r) => serializeMarketingCampaign(r, tenantId)));
});

router.post("/coop/marketing/campaigns", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateCoopMarketingCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const body = parsed.data;
  if (!MARKETING_TEMPLATE_SLUGS.has(body.templateSlug)) {
    res.status(400).json({ message: "Unknown template" });
    return;
  }
  const { partnership, isParty } = await partnershipForTenant(body.partnershipId, tenantId);
  if (!partnership) {
    res.status(404).json({ message: "Partnership not found" });
    return;
  }
  // Only accepted co-op partners can run joint campaigns, and only a party
  // to the partnership can initiate one.
  if (!isParty) {
    res.status(403).json({ message: "You are not a party to this partnership" });
    return;
  }
  if (partnership.status !== "accepted") {
    res.status(403).json({ message: "Joint campaigns require an accepted partnership" });
    return;
  }
  const participantTenantIds = [partnership.hostTenantId, partnership.partnerTenantId];
  // Every channel target must belong to a participant.
  for (const target of body.channels) {
    if (!participantTenantIds.includes(target.tenantId)) {
      res.status(400).json({ message: "Channel targets must belong to the two partner businesses" });
      return;
    }
  }
  let scheduledAt: Date | null = null;
  if (body.scheduledAt != null && body.scheduledAt !== "") {
    scheduledAt = new Date(body.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      res.status(400).json({ message: "Invalid scheduledAt" });
      return;
    }
    if (scheduledAt.getTime() <= Date.now()) {
      res.status(400).json({ message: "scheduledAt must be in the future" });
      return;
    }
  }
  const campaign = await db.transaction(async (tx) => {
    const [c] = await tx
      .insert(coopMarketingCampaignsTable)
      .values({
        creatorTenantId: tenantId,
        partnershipId: partnership.id,
        name: body.name.trim(),
        templateSlug: body.templateSlug,
        headline: body.headline ?? "",
        bodyText: body.bodyText ?? "",
        smsText: body.smsText ?? "",
        assetPayload: body.assetPayload ?? {},
        channels: body.channels,
        scheduledAt,
        status: "pending_approval",
      })
      .returning();
    // The creator's approval is implicit; the partner starts pending.
    await tx.insert(coopMarketingParticipantsTable).values(
      participantTenantIds.map((tid) => ({
        campaignId: c.id,
        tenantId: tid,
        approval: tid === tenantId ? "approved" : "pending",
        respondedAt: tid === tenantId ? new Date() : null,
      })),
    );
    return c;
  });
  const [row] = await loadMarketingCampaignRows([campaign.id]);
  res.status(201).json(serializeMarketingCampaign(row, tenantId));
});

/** Load a campaign row only if the tenant participates in it. */
async function campaignRowForParticipant(
  campaignId: number,
  tenantId: number,
): Promise<{ row: MarketingCampaignRow | null; isParticipant: boolean }> {
  const [row] = await loadMarketingCampaignRows([campaignId]);
  if (!row) return { row: null, isParticipant: false };
  return { row, isParticipant: row.participants.some((p) => p.tenantId === tenantId) };
}

router.post("/coop/marketing/campaigns/:id/respond", async (req, res): Promise<void> => {
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
  const parsed = RespondToCoopMarketingCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const { row, isParticipant } = await campaignRowForParticipant(id, tenantId);
  // Non-participants get a 404, not a 403 — campaign existence is itself
  // participant-scoped information.
  if (!row || !isParticipant) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (row.campaign.creatorTenantId === tenantId) {
    res.status(403).json({ message: "Only the invited partner can respond to a campaign" });
    return;
  }
  if (row.campaign.dispatchTriggeredAt) {
    res.status(409).json({ message: "This campaign has already been dispatched" });
    return;
  }
  const now = new Date();
  // Conditional update guards against a concurrent double-respond.
  const [updated] = await db
    .update(coopMarketingParticipantsTable)
    .set({
      approval: parsed.data.action === "approve" ? "approved" : "declined",
      respondedAt: now,
    })
    .where(
      and(
        eq(coopMarketingParticipantsTable.campaignId, id),
        eq(coopMarketingParticipantsTable.tenantId, tenantId),
        eq(coopMarketingParticipantsTable.approval, "pending"),
      ),
    )
    .returning();
  if (!updated) {
    res.status(409).json({ message: "You already responded to this campaign" });
    return;
  }
  const [fresh] = await loadMarketingCampaignRows([id]);
  const nextStatus =
    parsed.data.action === "decline"
      ? "declined"
      : allParticipantsApproved(fresh)
        ? "scheduled"
        : "pending_approval";
  await db
    .update(coopMarketingCampaignsTable)
    .set({ status: nextStatus, updatedAt: now })
    .where(eq(coopMarketingCampaignsTable.id, id));
  const [finalRow] = await loadMarketingCampaignRows([id]);
  res.json(serializeMarketingCampaign(finalRow, tenantId));
});

router.post("/coop/marketing/campaigns/:id/dispatch", async (req, res): Promise<void> => {
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
  const { row, isParticipant } = await campaignRowForParticipant(id, tenantId);
  if (!row || !isParticipant) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (row.campaign.creatorTenantId !== tenantId) {
    res.status(403).json({ message: "Only the campaign creator can dispatch" });
    return;
  }
  if (!allParticipantsApproved(row)) {
    res.status(409).json({ message: "Every partner must approve before this campaign can send" });
    return;
  }
  if (row.campaign.dispatchTriggeredAt) {
    res.status(409).json({ message: "This campaign has already been dispatched" });
    return;
  }
  const result = await dispatchMarketingCampaign(id);
  if (!result.dispatched) {
    res.status(409).json({ message: "This campaign has already been dispatched" });
    return;
  }
  res.json(result);
});

router.get("/coop/marketing/campaigns/:id/analytics", async (req, res): Promise<void> => {
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
  const { row, isParticipant } = await campaignRowForParticipant(id, tenantId);
  if (!row || !isParticipant) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  res.json(await campaignAnalytics(id));
});

export default router;
