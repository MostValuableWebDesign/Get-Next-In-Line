import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  modulesTable,
  agencySettingsTable,
  tenantsTable,
  tenantActivitiesTable,
  tenantModulesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetBillingSummaryResponse,
  SimulateCheckoutBody,
  SimulateCheckoutResponse,
} from "@workspace/api-zod";
import { randomUUID } from "crypto";

const router: IRouter = Router();

router.get("/billing/summary", async (_req, res): Promise<void> => {
  const tenants = await db.select().from(tenantsTable);
  const totalMrr = tenants.reduce((sum, t) => sum + parseFloat(t.mrr ?? "0"), 0);

  const modules = await db.select().from(modulesTable);
  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  const markup = parseFloat(settings?.markupPercent ?? "35");

  const categoryMap: Record<string, number> = {};
  for (const mod of modules) {
    const resale = parseFloat(mod.wholesalePrice) * (1 + markup / 100);
    categoryMap[mod.category] = (categoryMap[mod.category] ?? 0) + resale;
  }
  const byCategory = Object.entries(categoryMap).map(([category, mrr]) => ({
    category,
    mrr: Math.round(mrr * 100) / 100,
  }));

  const topTenants = tenants
    .sort((a, b) => parseFloat(b.mrr ?? "0") - parseFloat(a.mrr ?? "0"))
    .slice(0, 5)
    .map((t) => ({
      tenantId: t.id,
      brandName: t.brandName,
      mrr: parseFloat(t.mrr ?? "0"),
    }));

  res.json(
    GetBillingSummaryResponse.parse({
      totalMrr: Math.round(totalMrr * 100) / 100,
      byCategory,
      topTenants,
    })
  );
});

router.post("/billing/checkout", async (req, res): Promise<void> => {
  const parsed = SimulateCheckoutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { tenantId, moduleIds, applyMarkup } = parsed.data;

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  const markup = parseFloat(settings?.markupPercent ?? "35");

  const selectedModules = await db
    .select()
    .from(modulesTable)
    .then((all) => all.filter((m) => moduleIds.includes(m.id)));

  // Skip modules the tenant already has — no double-provisioning.
  const existingAssignments = await db
    .select()
    .from(tenantModulesTable)
    .where(eq(tenantModulesTable.tenantId, tenantId));
  const alreadyProvisionedIds = new Set(existingAssignments.map((a) => a.moduleId));
  const skippedModules = selectedModules.filter((m) => alreadyProvisionedIds.has(m.id));
  const modulesToProvision = selectedModules.filter((m) => !alreadyProvisionedIds.has(m.id));

  if (selectedModules.length > 0 && modulesToProvision.length === 0) {
    res.status(409).json({
      error: `All selected module(s) are already provisioned for ${tenant.brandName}: ${skippedModules.map((m) => m.name).join(", ")}`,
    });
    return;
  }

  let totalWholesale = 0;
  let totalResale = 0;
  for (const mod of modulesToProvision) {
    const wholesale = parseFloat(mod.wholesalePrice);
    const resale = applyMarkup !== false ? wholesale * (1 + markup / 100) : wholesale;
    totalWholesale += wholesale;
    totalResale += resale;
  }

  totalWholesale = Math.round(totalWholesale * 100) / 100;
  totalResale = Math.round(totalResale * 100) / 100;
  const margin = Math.round((totalResale - totalWholesale) * 100) / 100;

  // Update tenant MRR and modules count
  const newMrr = parseFloat(tenant.mrr ?? "0") + totalResale;

  // Record per-tenant module assignments
  if (modulesToProvision.length > 0) {
    await db
      .insert(tenantModulesTable)
      .values(modulesToProvision.map((m) => ({ tenantId, moduleId: m.id })))
      .onConflictDoNothing();
  }

  // Derive modulesEnabled from the join table so the two can never drift apart.
  const assignmentsAfter = await db
    .select()
    .from(tenantModulesTable)
    .where(eq(tenantModulesTable.tenantId, tenantId));
  const newModulesEnabled = assignmentsAfter.length;

  await db
    .update(tenantsTable)
    .set({
      mrr: String(Math.round(newMrr * 100) / 100),
      modulesEnabled: newModulesEnabled,
    })
    .where(eq(tenantsTable.id, tenantId));

  const transactionId = `txn_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

  // Log activity
  await db.insert(tenantActivitiesTable).values({
    tenantId,
    action: `Modules provisioned`,
    details: `${modulesToProvision.length} module(s) activated — ${modulesToProvision.map((m) => m.name).join(", ")}${skippedModules.length > 0 ? ` (skipped already-active: ${skippedModules.map((m) => m.name).join(", ")})` : ""}`,
  });

  const skippedNote =
    skippedModules.length > 0
      ? ` Skipped ${skippedModules.length} already-provisioned module(s): ${skippedModules.map((m) => m.name).join(", ")}.`
      : "";

  res.json(
    SimulateCheckoutResponse.parse({
      success: true,
      transactionId,
      totalWholesale,
      totalResale,
      margin,
      modulesProvisioned: modulesToProvision.length,
      modulesSkipped: skippedModules.length,
      message: `Successfully provisioned ${modulesToProvision.length} module(s) for ${tenant.brandName}. Transaction ${transactionId} authorized.${skippedNote}`,
    })
  );
});

export default router;
