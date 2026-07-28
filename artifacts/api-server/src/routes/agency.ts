import { Router, type IRouter } from "express";
import { requireRole } from "../middlewares/roles";
import { db } from "@workspace/db";
import {
  agencySettingsTable,
  tenantsTable,
  tenantActivitiesTable,
  modulesTable,
  tenantModulesTable,
  mrrSnapshotsTable,
} from "@workspace/db";
import { eq, sql, lte, desc } from "drizzle-orm";
import {
  GetAgencyDashboardResponse,
  GetAgencySettingsResponse,
  UpdateAgencySettingsBody,
  UpdateAgencySettingsResponse,
} from "@workspace/api-zod";
import { effectiveMarkupPercent } from "../lib/pricing";

const router: IRouter = Router();

// Route-level platform-role guard (see routes/admin.ts): the whole agency
// console is platform-admin-only; the path-based check in tenantAccess.ts is
// backstop only.
router.use("/agency", requireRole("super_admin"));

/**
 * Month-over-month MRR growth percent: (current − baseline) / baseline × 100,
 * rounded to one decimal. Null when there is no baseline (fresh install with
 * no snapshot history) or the baseline is 0 (growth from nothing is
 * undefined, not infinite) — the dashboard renders that as "not enough data".
 */
export function computeMrrGrowthPercent(
  currentMrr: number,
  baselineMrr: number | null,
): number | null {
  if (baselineMrr == null || baselineMrr <= 0) return null;
  return Math.round(((currentMrr - baselineMrr) / baselineMrr) * 1000) / 10;
}

const BASELINE_DAYS = 30;

router.get("/agency/dashboard", async (req, res): Promise<void> => {
  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  const markup = parseFloat(settings?.markupPercent ?? "25");

  const tenants = await db.select().from(tenantsTable);
  const activeTenants = tenants.filter((t) => t.status === "active").length;
  const suspendedTenants = tenants.filter((t) => t.status === "suspended").length;
  const totalMrr = tenants.reduce((sum, t) => sum + parseFloat(t.mrr ?? "0"), 0);

  const modules = await db.select().from(modulesTable);
  const totalModulesProvisioned = tenants.reduce((sum, t) => sum + t.modulesEnabled, 0);

  // Revenue by category (apply markup to wholesale prices, proportioned by tenant count)
  const categoryMap: Record<string, number> = {};
  for (const mod of modules) {
    const resale = parseFloat(mod.wholesalePrice) * (1 + effectiveMarkupPercent(mod, markup) / 100);
    categoryMap[mod.category] = (categoryMap[mod.category] ?? 0) + resale;
  }
  const revenueByCategory = Object.entries(categoryMap).map(([category, mrr]) => ({
    category,
    mrr: Math.round(mrr * 100) / 100,
  }));

  // Monthly profit from retail markups: for every provisioned module, profit
  // = realized resale − wholesale as captured at checkout time
  // (monthly-equivalent for bi-weekly cadences). A checkout made with markup
  // disabled recorded chargedResale === chargedWholesale and contributes $0.
  // Legacy rows provisioned before realized pricing was persisted fall back
  // to wholesale × current markup%. Partner modules carry a $0 wholesale
  // price, so they contribute nothing either way.
  // Bi-weekly charges recur 26 times/year → ×26/12 monthly-equivalent.
  const BIWEEKLY_TO_MONTHLY = 26 / 12;
  const moduleById = new Map(modules.map((m) => [m.id, m]));
  const assignments = await db.select().from(tenantModulesTable);
  let markupEarnings = 0;
  for (const a of assignments) {
    const mod = moduleById.get(a.moduleId);
    if (!mod) continue;
    const biweekly = a.billingCadence === "biweekly" && mod.wholesalePriceBiweekly != null;
    let marginPerCharge: number;
    if (a.chargedResale != null && a.chargedWholesale != null) {
      marginPerCharge = parseFloat(a.chargedResale) - parseFloat(a.chargedWholesale);
    } else {
      const wholesale = biweekly
        ? parseFloat(mod.wholesalePriceBiweekly!)
        : parseFloat(mod.wholesalePrice);
      marginPerCharge = wholesale * (effectiveMarkupPercent(mod, markup) / 100);
    }
    markupEarnings += biweekly ? marginPerCharge * BIWEEKLY_TO_MONTHLY : marginPerCharge;
  }
  markupEarnings = Math.round(markupEarnings * 100) / 100;

  const roundedTotalMrr = Math.round(totalMrr * 100) / 100;

  // Record today's total-MRR snapshot (one row per UTC day, last write wins)
  // so future dashboard reads have a real historical baseline.
  const today = new Date().toISOString().slice(0, 10);
  await db
    .insert(mrrSnapshotsTable)
    .values({ snapshotDate: today, totalMrr: roundedTotalMrr.toFixed(2) })
    .onConflictDoUpdate({
      target: mrrSnapshotsTable.snapshotDate,
      set: { totalMrr: roundedTotalMrr.toFixed(2) },
    });

  // Baseline = the most recent snapshot at least ~30 days old. A fresh
  // install has no such snapshot → growth is null ("not enough data"),
  // never a fabricated number.
  const baselineDate = new Date(Date.now() - BASELINE_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const [baseline] = await db
    .select()
    .from(mrrSnapshotsTable)
    .where(lte(mrrSnapshotsTable.snapshotDate, baselineDate))
    .orderBy(desc(mrrSnapshotsTable.snapshotDate))
    .limit(1);
  const mrrGrowthPercent = computeMrrGrowthPercent(
    roundedTotalMrr,
    baseline ? parseFloat(baseline.totalMrr) : null,
  );

  const dashboard = GetAgencyDashboardResponse.parse({
    totalMrr: roundedTotalMrr,
    monthlyProfit: markupEarnings,
    markupEarnings,
    activeTenants,
    suspendedTenants,
    totalTenants: tenants.length,
    mrrGrowthPercent,
    totalModulesProvisioned,
    revenueByCategory,
  });

  res.json(dashboard);
});

router.get("/agency/settings", async (req, res): Promise<void> => {
  let [settings] = await db.select().from(agencySettingsTable).limit(1);
  if (!settings) {
    [settings] = await db.insert(agencySettingsTable).values({}).returning();
  }
  res.json(
    GetAgencySettingsResponse.parse({
      ...settings,
      markupPercent: parseFloat(settings.markupPercent),
      updatedAt: settings.updatedAt.toISOString(),
    })
  );
});

router.patch("/agency/settings", async (req, res): Promise<void> => {
  const parsed = UpdateAgencySettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let [existing] = await db.select().from(agencySettingsTable).limit(1);
  if (!existing) {
    [existing] = await db.insert(agencySettingsTable).values({}).returning();
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.markupPercent !== undefined) {
    updateData.markupPercent = String(parsed.data.markupPercent);
  }
  if (parsed.data.platformName !== undefined) {
    updateData.platformName = parsed.data.platformName;
  }
  if (parsed.data.deploymentMode !== undefined) {
    updateData.deploymentMode = parsed.data.deploymentMode;
  }

  const [updated] = await db
    .update(agencySettingsTable)
    .set(updateData)
    .where(eq(agencySettingsTable.id, existing.id))
    .returning();

  res.json(
    UpdateAgencySettingsResponse.parse({
      ...updated,
      markupPercent: parseFloat(updated.markupPercent),
      updatedAt: updated.updatedAt.toISOString(),
    })
  );
});

export default router;
