import { Router, type IRouter } from "express";
import { count, desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  modulesTable,
  agencySettingsTable,
  tenantsTable,
  tenantModulesTable,
  tenantActivitiesTable,
  campaignsTable,
  attributionEventsTable,
  coopDisputesTable,
  merchantCoopPartnershipsTable,
} from "@workspace/db";
import { disputeRows, serializeDispute } from "./coop";
import {
  GetConnectorRegistryResponse,
  UpdateConnectorRegistryEntryBody,
  UpdateConnectorRegistryEntryResponse,
  GetAdminModuleDetailResponse,
  ListAdminCampaignsResponse,
  CreateAdminCampaignBody,
  CreateAdminCampaignResponse,
  UpdateAdminCampaignBody,
  UpdateAdminCampaignResponse,
  ListAdminCoopDisputesResponse,
  ReinstateCoopDisputeResponse,
  BanCoopDisputePartnershipResponse,
  AddCoopDisputeMediationNoteBody,
  AddCoopDisputeMediationNoteResponse,
} from "@workspace/api-zod";
import { CAMPAIGN_CODE_RE } from "./campaignRedirect";

import { effectiveMarkupPercent } from "../lib/pricing";

const router: IRouter = Router();

/**
 * Admin-only: full white-label proxy map — every module together with its
 * hidden upstream connector. This data must NEVER be served through
 * tenant-facing endpoints.
 */
router.get("/admin/connector-registry", async (_req, res): Promise<void> => {
  const modules = await db
    .select()
    .from(modulesTable)
    .orderBy(modulesTable.categorySlug, modulesTable.name);

  res.json(
    GetConnectorRegistryResponse.parse(
      modules.map((m) => ({
        id: m.id,
        name: m.name,
        slug: m.slug,
        category: m.category,
        categorySlug: m.categorySlug,
        isActive: m.isActive,
        upstreamVendor: m.upstreamVendor,
        hiddenConnector: m.hiddenConnector,
        proxyNotes: m.proxyNotes,
      }))
    )
  );
});

/**
 * Admin-only: update a module's hidden connector details (slug, upstream
 * vendor, hidden connector description, proxy notes). Never affects
 * tenant-facing endpoints.
 */
router.patch("/admin/connector-registry/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  const parsed = UpdateConnectorRegistryEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const updates: Partial<typeof modulesTable.$inferInsert> = {};
  if ("slug" in parsed.data) updates.slug = parsed.data.slug ?? null;
  if ("upstreamVendor" in parsed.data) updates.upstreamVendor = parsed.data.upstreamVendor ?? null;
  if ("hiddenConnector" in parsed.data) updates.hiddenConnector = parsed.data.hiddenConnector ?? null;
  if ("proxyNotes" in parsed.data) updates.proxyNotes = parsed.data.proxyNotes ?? null;

  const existing = await db.select().from(modulesTable).where(eq(modulesTable.id, id));
  if (existing.length === 0) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  const [m] =
    Object.keys(updates).length === 0
      ? existing
      : await db.update(modulesTable).set(updates).where(eq(modulesTable.id, id)).returning();

  res.json(
    UpdateConnectorRegistryEntryResponse.parse({
      id: m.id,
      name: m.name,
      slug: m.slug,
      category: m.category,
      categorySlug: m.categorySlug,
      isActive: m.isActive,
      upstreamVendor: m.upstreamVendor,
      hiddenConnector: m.hiddenConnector,
      proxyNotes: m.proxyNotes,
    })
  );
});

/**
 * Admin-only: connector-aware module detail — combines the module's hidden
 * connector mapping with its tenant assignments (provisioned dates, cadence,
 * MRR contribution) and recent provisioning activity for those tenants.
 * This data must NEVER be served through tenant-facing endpoints.
 */
router.get("/admin/modules/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  const [m] = await db.select().from(modulesTable).where(eq(modulesTable.id, id));
  if (!m) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  const markup = effectiveMarkupPercent(m, parseFloat(settings?.markupPercent ?? "25"));
  const wholesale = parseFloat(m.wholesalePrice);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const resale = round2(wholesale * (1 + markup / 100));
  const resaleBiweekly =
    m.wholesalePriceBiweekly != null
      ? round2(parseFloat(m.wholesalePriceBiweekly) * (1 + markup / 100))
      : undefined;

  const assignments = await db
    .select({
      tenantId: tenantsTable.id,
      brandName: tenantsTable.brandName,
      subdomain: tenantsTable.subdomain,
      status: tenantsTable.status,
      provisionedAt: tenantModulesTable.provisionedAt,
      billingCadence: tenantModulesTable.billingCadence,
    })
    .from(tenantModulesTable)
    .innerJoin(tenantsTable, eq(tenantModulesTable.tenantId, tenantsTable.id))
    .where(eq(tenantModulesTable.moduleId, id))
    .orderBy(tenantsTable.brandName);

  // Provisioning history from the existing tenant activity log, filtered to
  // entries that mention this module by name.
  const recentActivities = await db
    .select({
      id: tenantActivitiesTable.id,
      tenantId: tenantActivitiesTable.tenantId,
      tenantName: tenantsTable.brandName,
      action: tenantActivitiesTable.action,
      details: tenantActivitiesTable.details,
      timestamp: tenantActivitiesTable.timestamp,
    })
    .from(tenantActivitiesTable)
    .innerJoin(tenantsTable, eq(tenantActivitiesTable.tenantId, tenantsTable.id))
    .orderBy(desc(tenantActivitiesTable.timestamp), desc(tenantActivitiesTable.id))
    .limit(500);
  const provisioningActivity = recentActivities
    .filter((a) => a.details?.includes(m.name) ?? false)
    .slice(0, 20);

  res.json(
    GetAdminModuleDetailResponse.parse({
      mapping: {
        id: m.id,
        name: m.name,
        slug: m.slug,
        category: m.category,
        categorySlug: m.categorySlug,
        isActive: m.isActive,
        upstreamVendor: m.upstreamVendor,
        hiddenConnector: m.hiddenConnector,
        proxyNotes: m.proxyNotes,
      },
      description: m.description,
      wholesalePrice: wholesale,
      resalePrice: resale,
      markupPercent: markup,
      ...(resaleBiweekly != null ? { resalePriceBiweekly: resaleBiweekly } : {}),
      tenants: assignments.map((a) => ({
        tenantId: a.tenantId,
        brandName: a.brandName,
        subdomain: a.subdomain,
        status: a.status,
        provisionedAt: a.provisionedAt.toISOString(),
        // Cadence is per-assignment: each tenant stores its own billing
        // cadence on tenant_modules.
        cadence: a.billingCadence === "biweekly" ? "biweekly" : "monthly",
        mrrContribution:
          a.billingCadence === "biweekly" && resaleBiweekly != null
            ? round2((resaleBiweekly * 26) / 12)
            : resale,
      })),
      activity: provisioningActivity.map((a) => ({
        id: a.id,
        tenantId: a.tenantId,
        tenantName: a.tenantName,
        action: a.action,
        details: a.details,
        timestamp: a.timestamp.toISOString(),
      })),
    })
  );
});

// ── Campaign redirect links ─────────────────────────────────────────────────
// Admin CRUD for the trackable /r/:code marketing links plus click counts
// pulled from the attribution-events log.

function serializeCampaign(
  c: typeof campaignsTable.$inferSelect,
  tenantName: string,
  clickCount: number,
) {
  return {
    id: c.id,
    code: c.code,
    tenantId: c.tenantId,
    tenantName,
    name: c.name,
    isActive: c.isActive,
    clickCount,
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/admin/campaigns", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      campaign: campaignsTable,
      tenantName: tenantsTable.brandName,
      clickCount: count(attributionEventsTable.id),
    })
    .from(campaignsTable)
    .innerJoin(tenantsTable, eq(campaignsTable.tenantId, tenantsTable.id))
    .leftJoin(
      attributionEventsTable,
      eq(attributionEventsTable.campaignCode, campaignsTable.code),
    )
    .groupBy(campaignsTable.id, tenantsTable.brandName)
    .orderBy(desc(campaignsTable.createdAt), desc(campaignsTable.id));

  res.json(
    ListAdminCampaignsResponse.parse(
      rows.map((r) => serializeCampaign(r.campaign, r.tenantName, Number(r.clickCount))),
    ),
  );
});

/** Derive a URL-safe campaign code from a human-readable name. */
function slugifyCode(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

router.post("/admin/campaigns", async (req, res): Promise<void> => {
  const parsed = CreateAdminCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const { tenantId, name } = parsed.data;

  const [tenant] = await db
    .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.status(404).json({ message: "Tenant not found" });
    return;
  }

  let code = parsed.data.code ?? "";
  if (!code) {
    const base = slugifyCode(name) || `campaign-${tenantId}`;
    code = base;
    // Suffix until unique (bounded — collisions are rare).
    for (let i = 2; i < 50; i++) {
      const [existing] = await db
        .select({ id: campaignsTable.id })
        .from(campaignsTable)
        .where(eq(campaignsTable.code, code));
      if (!existing) break;
      code = `${base}-${i}`;
    }
  }
  if (!CAMPAIGN_CODE_RE.test(code)) {
    res.status(400).json({ message: "Invalid campaign code" });
    return;
  }

  try {
    const [created] = await db
      .insert(campaignsTable)
      .values({ code, tenantId, name })
      .returning();
    res
      .status(201)
      .json(CreateAdminCampaignResponse.parse(serializeCampaign(created, tenant.brandName, 0)));
  } catch (err) {
    // Unique-code violation from an explicit duplicate code. Drizzle may wrap
    // the pg error, so check both the error and its cause.
    const pgCode =
      (err as { code?: string }).code ??
      ((err as { cause?: { code?: string } }).cause?.code);
    if (pgCode === "23505") {
      res.status(400).json({ message: "Campaign code already in use" });
      return;
    }
    throw err;
  }
});

router.patch("/admin/campaigns/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const parsed = UpdateAdminCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const [updated] = await db
    .update(campaignsTable)
    .set({ isActive: parsed.data.isActive, updatedAt: sql`now()` })
    .where(eq(campaignsTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  const [tenant] = await db
    .select({ brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, updated.tenantId));
  const [clicks] = await db
    .select({ n: count() })
    .from(attributionEventsTable)
    .where(eq(attributionEventsTable.campaignCode, updated.code));

  res.json(
    UpdateAdminCampaignResponse.parse(
      serializeCampaign(updated, tenant?.brandName ?? "", Number(clicks?.n ?? 0)),
    ),
  );
});

// ── Co-op dispute escalation queue ──────────────────────────────────────────
// Platform mediation console: list disputes, reinstate the partnership,
// permanently ban it, or record mediation notes while keeping it open.

const DISPUTE_STATUSES = new Set(["open", "escalated", "resolved", "withdrawn", "banned"]);

router.get("/admin/coop/disputes", async (req, res): Promise<void> => {
  const status = String(req.query.status ?? "").trim();
  let query = disputeRows()
    .orderBy(desc(coopDisputesTable.createdAt), desc(coopDisputesTable.id))
    .$dynamic();
  if (status && DISPUTE_STATUSES.has(status)) {
    query = query.where(eq(coopDisputesTable.status, status));
  }
  const rows = await query;
  res.json(
    ListAdminCoopDisputesResponse.parse(
      rows.map((r) =>
        serializeDispute(r.dispute, r.reportingTenantName, r.reportedTenantName, r.perkTitle)
      )
    )
  );
});

/** Load a dispute or 404. Returns null after responding. */
async function loadDispute(
  req: Parameters<Parameters<IRouter["post"]>[1]>[0],
  res: Parameters<Parameters<IRouter["post"]>[1]>[1]
) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return null;
  }
  const [dispute] = await db.select().from(coopDisputesTable).where(eq(coopDisputesTable.id, id));
  if (!dispute) {
    res.status(404).json({ message: "Not found" });
    return null;
  }
  return dispute;
}

async function respondWithDispute(res: { json: (b: unknown) => void }, id: number, schema: { parse: (v: unknown) => unknown }) {
  const [row] = await disputeRows().where(eq(coopDisputesTable.id, id));
  res.json(
    schema.parse(
      serializeDispute(row.dispute, row.reportingTenantName, row.reportedTenantName, row.perkTitle)
    )
  );
}

// Resolve the dispute and reinstate the partnership: perk reactivated and
// directory visibility restored (the ban flag is also cleared — reinstating
// is the explicit admin undo for both suspension and ban).
router.post("/admin/coop/disputes/:id/reinstate", async (req, res): Promise<void> => {
  const dispute = await loadDispute(req, res);
  if (!dispute) return;
  if (dispute.status !== "open" && dispute.status !== "escalated" && dispute.status !== "banned") {
    res.status(409).json({ message: "This dispute is already closed" });
    return;
  }
  const now = new Date();
  await db
    .update(coopDisputesTable)
    .set({ status: "resolved", resolvedAt: now, updatedAt: now })
    .where(eq(coopDisputesTable.id, dispute.id));
  await db
    .update(merchantCoopPartnershipsTable)
    .set({ disputeSuspended: false, bannedAt: null, updatedAt: now })
    .where(eq(merchantCoopPartnershipsTable.id, dispute.partnershipId));
  await respondWithDispute(res, dispute.id, ReinstateCoopDisputeResponse);
});

// Permanently ban the partnership behind the dispute.
router.post("/admin/coop/disputes/:id/ban", async (req, res): Promise<void> => {
  const dispute = await loadDispute(req, res);
  if (!dispute) return;
  if (dispute.status !== "open" && dispute.status !== "escalated") {
    res.status(409).json({ message: "This dispute is already closed" });
    return;
  }
  const now = new Date();
  await db
    .update(coopDisputesTable)
    .set({ status: "banned", resolvedAt: now, updatedAt: now })
    .where(eq(coopDisputesTable.id, dispute.id));
  await db
    .update(merchantCoopPartnershipsTable)
    .set({ bannedAt: now, disputeSuspended: true, updatedAt: now })
    .where(eq(merchantCoopPartnershipsTable.id, dispute.partnershipId));
  await respondWithDispute(res, dispute.id, BanCoopDisputePartnershipResponse);
});

// Append a timestamped mediation note; the dispute stays in its current state.
router.post("/admin/coop/disputes/:id/mediation-notes", async (req, res): Promise<void> => {
  const parsed = AddCoopDisputeMediationNoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const dispute = await loadDispute(req, res);
  if (!dispute) return;
  const now = new Date();
  const line = `[${now.toISOString()}] ${parsed.data.note.trim()}`;
  const mediationNotes = dispute.mediationNotes ? `${dispute.mediationNotes}\n${line}` : line;
  await db
    .update(coopDisputesTable)
    .set({ mediationNotes, updatedAt: now })
    .where(eq(coopDisputesTable.id, dispute.id));
  await respondWithDispute(res, dispute.id, AddCoopDisputeMediationNoteResponse);
});

export default router;
