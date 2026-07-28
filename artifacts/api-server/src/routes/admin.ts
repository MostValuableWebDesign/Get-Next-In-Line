import { Router, type IRouter } from "express";
import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
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
  platformLedgerEntriesTable,
} from "@workspace/db";
import { disputeRows, serializeDispute } from "./coop";
import {
  coopFinancialDisputesTable,
  coopLedgerAdjustmentsTable,
  coopTenantSuspensionsTable,
} from "@workspace/db";
import {
  financialDisputeRows,
  serializeFinancialDisputes,
  serializedFinancialDispute,
  recordDisputeEvent,
  serializeSuspension,
  notifyTenantSafe,
  checkRepeatViolator,
} from "../lib/coopFinancialDisputes";
import {
  GetAdminComplianceSummaryResponse,
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
  ListAdminCoopReputationResponse,
  ReinstateCoopReputationResponse,
  ListAdminCoopFinancialDisputesResponse,
  CreateCoopFinancialAdjustmentBody,
  CreateCoopFinancialAdjustmentResponse,
  IssueCoopFinancialRulingBody,
  IssueCoopFinancialRulingResponse,
  ListCoopSuspensionsResponse,
  CreateCoopSuspensionBody,
  CreateCoopSuspensionResponse,
  LiftCoopSuspensionResponse,
} from "@workspace/api-zod";
import {
  coopReputationStatesTable,
  coopReputationEventsTable,
  type CoopReputationState,
  type CoopReputationEvent,
} from "@workspace/db";
import { reinstateReputation } from "../lib/coopReputation";
import { inArray, ne } from "drizzle-orm";
import { CAMPAIGN_CODE_RE } from "./campaignRedirect";

import { effectiveMarkupPercent } from "../lib/pricing";
import { requireRole } from "../middlewares/roles";

const router: IRouter = Router();

// Route-level platform-role guard: every /admin/* route in this router (and,
// because this router sits early in the chain, any /admin/* route mounted
// after it) requires the super_admin role. Protection travels with the
// router — adding or renaming an admin route here cannot silently bypass
// authorization. The path-based check in middlewares/tenantAccess.ts remains
// as defense-in-depth only.
router.use("/admin", requireRole("super_admin"));

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

// ── Platform compliance ledger ──────────────────────────────────────────────
// Admin-only aggregates + CSV export over the append-only platform_ledger
// table. Figures come from persisted realized amounts (never recomputed from
// current markup), partner-category subscriptions always carry zero margin,
// and no supplier/wholesale-connector details are exposed beyond amounts.

const BIWEEKLY_TO_MONTHLY = 26 / 12;
const round2 = (n: number) => Math.round(n * 100) / 100;

function parsePeriod(req: { query: Record<string, unknown> }): { from: Date; to: Date } | null {
  const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
  if (!from || !to || isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) return null;
  return { from, to };
}

/** Ledger rows in [from, to), joined with tenant names, oldest first. */
async function ledgerEntriesForPeriod(from: Date, to: Date) {
  return db
    .select({
      entry: platformLedgerEntriesTable,
      brandName: tenantsTable.brandName,
    })
    .from(platformLedgerEntriesTable)
    .leftJoin(tenantsTable, eq(platformLedgerEntriesTable.tenantId, tenantsTable.id))
    .where(
      and(
        gte(platformLedgerEntriesTable.occurredAt, from),
        lt(platformLedgerEntriesTable.occurredAt, to),
      ),
    )
    .orderBy(platformLedgerEntriesTable.occurredAt, platformLedgerEntriesTable.id);
}

/**
 * Current monthly-equivalent module MRR by category from realized charged
 * amounts (bi-weekly ×26/12). Legacy rows without persisted charges fall back
 * to wholesale × current effective markup — the same rule as the agency
 * dashboard. Partner-category modules are pass-through: margin is always 0.
 */
async function mrrByCategoryFromAssignments() {
  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  const agencyMarkup = parseFloat(settings?.markupPercent ?? "25");
  const modules = await db.select().from(modulesTable);
  const moduleById = new Map(modules.map((m) => [m.id, m]));
  const assignments = await db.select().from(tenantModulesTable);

  const byCategory = new Map<string, { mrr: number; margin: number }>();
  for (const a of assignments) {
    const mod = moduleById.get(a.moduleId);
    if (!mod) continue;
    const biweekly = a.billingCadence === "biweekly" && mod.wholesalePriceBiweekly != null;
    let resale: number;
    let wholesale: number;
    if (a.chargedResale != null && a.chargedWholesale != null) {
      resale = parseFloat(a.chargedResale);
      wholesale = parseFloat(a.chargedWholesale);
    } else {
      wholesale = biweekly ? parseFloat(mod.wholesalePriceBiweekly!) : parseFloat(mod.wholesalePrice);
      resale = wholesale * (1 + effectiveMarkupPercent(mod, agencyMarkup) / 100);
    }
    const factor = biweekly ? BIWEEKLY_TO_MONTHLY : 1;
    const bucket = byCategory.get(mod.category) ?? { mrr: 0, margin: 0 };
    bucket.mrr += resale * factor;
    // Partner pass-through is enforced structurally (charged resale ===
    // wholesale), but clamp anyway so the contract can never drift here.
    bucket.margin += mod.categorySlug === "partners" ? 0 : (resale - wholesale) * factor;
    byCategory.set(mod.category, bucket);
  }
  return [...byCategory.entries()]
    .map(([category, b]) => ({ category, mrr: round2(b.mrr), platformMargin: round2(b.margin) }))
    .sort((x, y) => y.mrr - x.mrr);
}

router.get("/admin/compliance/summary", async (req, res): Promise<void> => {
  const period = parsePeriod(req);
  if (!period) {
    res.status(400).json({ message: "Invalid period: 'from' and 'to' must be valid dates with from < to" });
    return;
  }

  const rows = await ledgerEntriesForPeriod(period.from, period.to);

  let grossAmount = 0;
  let platformMargin = 0;
  const bySource = new Map<string, { entryCount: number; amount: number }>();
  const deposits = { captured: 0, released: 0, failed: 0, capturedFees: 0 };
  const byTenant = new Map<
    number | null,
    { brandName: string; entryCount: number; amount: number; platformMargin: number }
  >();

  for (const { entry, brandName } of rows) {
    const amount = parseFloat(entry.amount);
    const margin = parseFloat(entry.platformMargin);
    grossAmount += amount;
    platformMargin += margin;

    const src = bySource.get(entry.source) ?? { entryCount: 0, amount: 0 };
    src.entryCount += 1;
    src.amount += amount;
    bySource.set(entry.source, src);

    if (entry.source === "deposit_captured") {
      deposits.captured += 1;
      deposits.capturedFees += amount;
    } else if (entry.source === "deposit_released") deposits.released += 1;
    else if (entry.source === "deposit_failed") deposits.failed += 1;

    const tenant = byTenant.get(entry.tenantId) ?? {
      brandName: brandName ?? "Legacy (pre-tenant)",
      entryCount: 0,
      amount: 0,
      platformMargin: 0,
    };
    tenant.entryCount += 1;
    tenant.amount += amount;
    tenant.platformMargin += margin;
    byTenant.set(entry.tenantId, tenant);
  }

  res.json(
    GetAdminComplianceSummaryResponse.parse({
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      totals: {
        entryCount: rows.length,
        grossAmount: round2(grossAmount),
        platformMargin: round2(platformMargin),
      },
      mrrByCategory: await mrrByCategoryFromAssignments(),
      bySource: [...bySource.entries()].map(([source, s]) => ({
        source,
        entryCount: s.entryCount,
        amount: round2(s.amount),
      })),
      depositOutcomes: { ...deposits, capturedFees: round2(deposits.capturedFees) },
      tenantContributions: [...byTenant.entries()]
        .map(([tenantId, t]) => ({
          tenantId,
          brandName: t.brandName,
          entryCount: t.entryCount,
          amount: round2(t.amount),
          platformMargin: round2(t.platformMargin),
        }))
        .sort((a, b) => b.amount - a.amount),
    }),
  );
});

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Server-side CSV compliance report — the canonical, auditable export.
 * One row per immutable ledger entry in the period.
 */
router.get("/admin/compliance/export", async (req, res): Promise<void> => {
  const period = parsePeriod(req);
  if (!period) {
    res.status(400).json({ message: "Invalid period: 'from' and 'to' must be valid dates with from < to" });
    return;
  }

  const rows = await ledgerEntriesForPeriod(period.from, period.to);
  const header = [
    "Entry ID",
    "Source",
    "Reference",
    "Tenant ID",
    "Tenant",
    "Category",
    "Description",
    "Amount",
    "Wholesale Amount",
    "Platform Margin",
    "Occurred At",
    "Recorded At",
  ];
  const lines = [header.join(",")];
  for (const { entry, brandName } of rows) {
    lines.push(
      [
        String(entry.id),
        csvEscape(entry.source),
        csvEscape(entry.sourceRef),
        entry.tenantId != null ? String(entry.tenantId) : "",
        csvEscape(brandName ?? (entry.tenantId != null ? "" : "Legacy (pre-tenant)")),
        csvEscape(entry.category),
        csvEscape(entry.description ?? ""),
        parseFloat(entry.amount).toFixed(2),
        entry.wholesaleAmount != null ? parseFloat(entry.wholesaleAmount).toFixed(2) : "",
        parseFloat(entry.platformMargin).toFixed(2),
        entry.occurredAt.toISOString(),
        entry.recordedAt.toISOString(),
      ].join(","),
    );
  }

  const stamp = (d: Date) => d.toISOString().slice(0, 10);
  res
    .status(200)
    .setHeader("Content-Type", "text/csv; charset=utf-8")
    .setHeader(
      "Content-Disposition",
      `attachment; filename="compliance-report-${stamp(period.from)}-to-${stamp(period.to)}.csv"`,
    )
    .send(lines.join("\r\n") + "\r\n");
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
      and(
        eq(attributionEventsTable.campaignCode, campaignsTable.code),
        eq(attributionEventsTable.tenantId, campaignsTable.tenantId),
      ),
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
    // Suffix until unique within this tenant (bounded — collisions are rare).
    for (let i = 2; i < 50; i++) {
      const [existing] = await db
        .select({ id: campaignsTable.id })
        .from(campaignsTable)
        .where(and(eq(campaignsTable.tenantId, tenantId), eq(campaignsTable.code, code)));
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
      res.status(400).json({ message: "Campaign code already in use for this business" });
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
    .where(
      and(
        eq(attributionEventsTable.campaignCode, updated.code),
        eq(attributionEventsTable.tenantId, updated.tenantId),
      ),
    );

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

// ── Co-op Reputation Shield console ─────────────────────────────────────────
// Flagged/decoupled tenants with their score history, and admin
// reinstatement after an automatic decouple.

function serializeReputationEntry(
  state: CoopReputationState,
  tenantName: string,
  events: CoopReputationEvent[],
) {
  return {
    tenantId: state.tenantId,
    tenantName,
    score: state.score == null ? null : Number(state.score),
    raterCount: state.raterCount,
    status: state.status,
    flaggedAt: state.flaggedAt?.toISOString() ?? null,
    decoupledAt: state.decoupledAt?.toISOString() ?? null,
    updatedAt: state.updatedAt.toISOString(),
    events: events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      score: e.score == null ? null : Number(e.score),
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

router.get("/admin/coop/reputation", async (_req, res): Promise<void> => {
  const states = await db
    .select()
    .from(coopReputationStatesTable)
    .where(ne(coopReputationStatesTable.status, "ok"))
    .orderBy(desc(coopReputationStatesTable.updatedAt));
  const tenantIds = states.map((s) => s.tenantId);
  const [tenants, events] = tenantIds.length
    ? await Promise.all([
        db
          .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
          .from(tenantsTable)
          .where(inArray(tenantsTable.id, tenantIds)),
        db
          .select()
          .from(coopReputationEventsTable)
          .where(inArray(coopReputationEventsTable.tenantId, tenantIds))
          .orderBy(desc(coopReputationEventsTable.createdAt)),
      ])
    : [[], []];
  const nameById = new Map(tenants.map((t) => [t.id, t.brandName]));
  res.json(
    ListAdminCoopReputationResponse.parse(
      states.map((s) =>
        serializeReputationEntry(
          s,
          nameById.get(s.tenantId) ?? "Unknown business",
          events.filter((e) => e.tenantId === s.tenantId),
        ),
      ),
    ),
  );
});

// Reinstate a decoupled tenant: reactivates exactly the partnerships the
// decouple deactivated and restores directory visibility. Audited.
router.post("/admin/coop/reputation/:tenantId/reinstate", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const [existing] = await db
    .select()
    .from(coopReputationStatesTable)
    .where(eq(coopReputationStatesTable.tenantId, tenantId));
  if (!existing) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (existing.status !== "decoupled") {
    res.status(409).json({ message: "This business is not decoupled" });
    return;
  }
  const updated = await reinstateReputation(tenantId);
  if (!updated) {
    res.status(409).json({ message: "This business is not decoupled" });
    return;
  }
  const [tenant] = await db
    .select({ brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  const events = await db
    .select()
    .from(coopReputationEventsTable)
    .where(eq(coopReputationEventsTable.tenantId, tenantId))
    .orderBy(desc(coopReputationEventsTable.createdAt));
  res.json(
    ReinstateCoopReputationResponse.parse(
      serializeReputationEntry(updated, tenant?.brandName ?? "Unknown business", events),
    ),
  );
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

// ---------------------------------------------------------------------------
// Mediation Hub — escalated financial disputes between co-op partners.
// Admins record compensating ledger adjustments and referral bounty
// reversals (persisted entries that inform settlement — no money movement),
// close tickets with rulings, and manage tenant co-op suspensions.
// ---------------------------------------------------------------------------

const FINANCIAL_DISPUTE_STATUSES = new Set([
  "filed",
  "auto_resolved",
  "escalated",
  "resolved",
  "adjusted",
]);

// ── GET /admin/coop/financial-disputes — mediation queue ────────────────────
router.get("/admin/coop/financial-disputes", async (req, res): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  if (status !== undefined && !FINANCIAL_DISPUTE_STATUSES.has(status)) {
    res.status(400).json({ message: "Unknown status filter" });
    return;
  }
  let query = financialDisputeRows().$dynamic();
  if (status) query = query.where(eq(coopFinancialDisputesTable.status, status));
  const rows = await query.orderBy(
    desc(coopFinancialDisputesTable.createdAt),
    desc(coopFinancialDisputesTable.id)
  );
  res.json(ListAdminCoopFinancialDisputesResponse.parse(await serializeFinancialDisputes(rows)));
});

async function loadFinancialDispute(
  req: import("express").Request,
  res: import("express").Response
) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return null;
  }
  const [dispute] = await db
    .select()
    .from(coopFinancialDisputesTable)
    .where(eq(coopFinancialDisputesTable.id, id));
  if (!dispute) {
    res.status(404).json({ message: "Not found" });
    return null;
  }
  return dispute;
}

// ── POST /admin/coop/financial-disputes/:id/adjustments ─────────────────────
router.post(
  "/admin/coop/financial-disputes/:id/adjustments",
  async (req, res): Promise<void> => {
    const parsed = CreateCoopFinancialAdjustmentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
      return;
    }
    const dispute = await loadFinancialDispute(req, res);
    if (!dispute) return;
    if (dispute.status !== "escalated") {
      res.status(409).json({ message: "Adjustments can only be recorded on escalated tickets" });
      return;
    }
    const parties = new Set([dispute.filedByTenantId, dispute.respondentTenantId]);
    const { creditTenantId, debitTenantId } = parsed.data;
    if (
      !parties.has(creditTenantId) ||
      !parties.has(debitTenantId) ||
      creditTenantId === debitTenantId
    ) {
      res.status(400).json({
        message: "Credit and debit tenants must be the two parties of this dispute",
      });
      return;
    }
    await db.insert(coopLedgerAdjustmentsTable).values({
      disputeId: dispute.id,
      partnershipId: dispute.partnershipId,
      adjustmentType: parsed.data.adjustmentType,
      amount: parsed.data.amount.toFixed(2),
      creditTenantId,
      debitTenantId,
      reason: parsed.data.reason.trim(),
    });
    await recordDisputeEvent({
      disputeId: dispute.id,
      eventType: "adjustment_recorded",
      actorType: "admin",
      note:
        `${parsed.data.adjustmentType === "bounty_reversal" ? "Referral bounty reversal" : "Ledger adjustment"} ` +
        `of $${parsed.data.amount.toFixed(2)} recorded (credit tenant #${creditTenantId}, ` +
        `debit tenant #${debitTenantId}): ${parsed.data.reason.trim()}`,
    });
    await db
      .update(coopFinancialDisputesTable)
      .set({ updatedAt: new Date() })
      .where(eq(coopFinancialDisputesTable.id, dispute.id));
    res.json(
      CreateCoopFinancialAdjustmentResponse.parse(await serializedFinancialDispute(dispute.id))
    );
  }
);

// ── POST /admin/coop/financial-disputes/:id/ruling — close with a ruling ────
// Closing status is "adjusted" when any compensating entries were recorded,
// otherwise "resolved". A ruling against a tenant feeds the repeat-violator
// counter and may auto-suspend its co-op participation.
router.post("/admin/coop/financial-disputes/:id/ruling", async (req, res): Promise<void> => {
  const parsed = IssueCoopFinancialRulingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const dispute = await loadFinancialDispute(req, res);
  if (!dispute) return;
  if (dispute.status !== "escalated") {
    res.status(409).json({ message: "Only escalated tickets can be closed with a ruling" });
    return;
  }
  const ruledAgainstTenantId = parsed.data.ruledAgainstTenantId ?? null;
  if (
    ruledAgainstTenantId != null &&
    ruledAgainstTenantId !== dispute.filedByTenantId &&
    ruledAgainstTenantId !== dispute.respondentTenantId
  ) {
    res.status(400).json({ message: "The ruled-against tenant must be a party to this dispute" });
    return;
  }
  const [{ n: adjustmentCount }] = await db
    .select({ n: count() })
    .from(coopLedgerAdjustmentsTable)
    .where(eq(coopLedgerAdjustmentsTable.disputeId, dispute.id));
  const now = new Date();
  // Conditional update guards against concurrent double-rulings.
  const [updated] = await db
    .update(coopFinancialDisputesTable)
    .set({
      status: adjustmentCount > 0 ? "adjusted" : "resolved",
      ruling: parsed.data.ruling.trim(),
      ruledAgainstTenantId,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(coopFinancialDisputesTable.id, dispute.id),
        eq(coopFinancialDisputesTable.status, "escalated")
      )
    )
    .returning();
  if (!updated) {
    res.status(409).json({ message: "This ticket was already closed" });
    return;
  }
  await recordDisputeEvent({
    disputeId: dispute.id,
    eventType: "ruling_issued",
    actorType: "admin",
    note:
      parsed.data.ruling.trim() +
      (ruledAgainstTenantId != null ? ` (ruled against tenant #${ruledAgainstTenantId})` : ""),
  });
  // Notify both parties of the ruling through the unified messaging layer.
  for (const partyId of [dispute.filedByTenantId, dispute.respondentTenantId]) {
    await notifyTenantSafe(
      partyId,
      "coop_financial_dispute",
      `Co-Op mediation update: a platform mediator has closed the financial dispute on your ` +
        `partnership with a written ruling. Review it in your Co-Op hub.`,
      { disputeId: dispute.id, ruling: true }
    );
  }
  // Repeat-violator automation runs on every ruling against a tenant.
  if (ruledAgainstTenantId != null) {
    await checkRepeatViolator(ruledAgainstTenantId, updated);
  }
  res.json(IssueCoopFinancialRulingResponse.parse(await serializedFinancialDispute(dispute.id)));
});

// ── GET /admin/coop/suspensions — suspension history, newest first ──────────
router.get("/admin/coop/suspensions", async (_req, res): Promise<void> => {
  const rows = await db
    .select({ suspension: coopTenantSuspensionsTable, tenantName: tenantsTable.brandName })
    .from(coopTenantSuspensionsTable)
    .innerJoin(tenantsTable, eq(coopTenantSuspensionsTable.tenantId, tenantsTable.id))
    .orderBy(desc(coopTenantSuspensionsTable.suspendedAt), desc(coopTenantSuspensionsTable.id));
  res.json(
    ListCoopSuspensionsResponse.parse(rows.map((r) => serializeSuspension(r.suspension, r.tenantName)))
  );
});

// ── POST /admin/coop/suspensions — manual suspension ────────────────────────
router.post("/admin/coop/suspensions", async (req, res): Promise<void> => {
  const parsed = CreateCoopSuspensionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const [tenant] = await db
    .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, parsed.data.tenantId));
  if (!tenant) {
    res.status(404).json({ message: "Tenant not found" });
    return;
  }
  // Partial unique index (one active suspension per tenant) makes the insert
  // race-safe; a conflict means one already exists.
  const [created] = await db
    .insert(coopTenantSuspensionsTable)
    .values({
      tenantId: tenant.id,
      status: "active",
      trigger: "manual",
      reason: parsed.data.reason?.trim() || null,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    res.status(409).json({ message: "This tenant already has an active co-op suspension" });
    return;
  }
  await notifyTenantSafe(
    tenant.id,
    "coop_financial_dispute",
    `Co-Op notice: a platform admin has suspended your co-op participation` +
      `${parsed.data.reason ? ` (${parsed.data.reason.trim()})` : ""}. Your perks are paused and ` +
      `new partnerships are blocked until you are reinstated.`,
    { suspensionId: created.id, trigger: "manual" }
  );
  res.status(201).json(CreateCoopSuspensionResponse.parse(serializeSuspension(created, tenant.brandName)));
});

// ── POST /admin/coop/suspensions/:id/lift — reinstate a tenant ──────────────
router.post("/admin/coop/suspensions/:id/lift", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const now = new Date();
  // Conditional update: only an active suspension can be lifted.
  const [lifted] = await db
    .update(coopTenantSuspensionsTable)
    .set({ status: "lifted", liftedAt: now })
    .where(
      and(eq(coopTenantSuspensionsTable.id, id), eq(coopTenantSuspensionsTable.status, "active"))
    )
    .returning();
  if (!lifted) {
    const [existing] = await db
      .select()
      .from(coopTenantSuspensionsTable)
      .where(eq(coopTenantSuspensionsTable.id, id));
    res
      .status(existing ? 409 : 404)
      .json({ message: existing ? "This suspension was already lifted" : "Not found" });
    return;
  }
  const [tenant] = await db
    .select({ brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, lifted.tenantId));
  await notifyTenantSafe(
    lifted.tenantId,
    "coop_financial_dispute",
    `Co-Op notice: your co-op participation has been reinstated by a platform admin. ` +
      `Your perks are live again and you can form new partnerships.`,
    { suspensionId: lifted.id, lifted: true }
  );
  res.json(
    LiftCoopSuspensionResponse.parse(serializeSuspension(lifted, tenant?.brandName ?? "Unknown"))
  );
});

export default router;
