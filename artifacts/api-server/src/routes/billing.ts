import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  modulesTable,
  agencySettingsTable,
  tenantsTable,
  tenantModulesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetBillingSummaryResponse,
  SimulateCheckoutBody,
  SimulateCheckoutResponse,
} from "@workspace/api-zod";
import { randomUUID } from "crypto";
import { effectiveMarkupPercent } from "../lib/pricing";
import { getUncachableStripeClient } from "../lib/stripeClient";
import {
  liveModuleCheckoutEnabled,
  provisionModuleItems,
  type ModuleCheckoutItem,
} from "../lib/moduleCheckout";
import { moduleCheckoutSessionsTable } from "@workspace/db";
import { logger } from "../lib/logger";

/** Public base URL for Stripe redirect targets (dev domain fallback). */
function appBaseUrl(): string {
  const base = process.env.APP_BASE_URL || process.env.REPLIT_DOMAINS?.split(",")[0];
  return base ? (base.startsWith("http") ? base : `https://${base}`) : "http://localhost:5000";
}

const router: IRouter = Router();

router.get("/billing/summary", async (_req, res): Promise<void> => {
  const tenants = await db.select().from(tenantsTable);
  const totalMrr = tenants.reduce((sum, t) => sum + parseFloat(t.mrr ?? "0"), 0);

  const modules = await db.select().from(modulesTable);
  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  const markup = parseFloat(settings?.markupPercent ?? "25");

  const categoryMap: Record<string, number> = {};
  for (const mod of modules) {
    const resale = parseFloat(mod.wholesalePrice) * (1 + effectiveMarkupPercent(mod, markup) / 100);
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

  const { tenantId, moduleIds, applyMarkup, moduleCadences } = parsed.data;
  const cadenceById = new Map<number, "monthly" | "biweekly">(
    (moduleCadences ?? []).map((c) => [c.moduleId, c.cadence])
  );

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  const markup = parseFloat(settings?.markupPercent ?? "25");

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

  // Validate cadence selections: bi-weekly is only allowed for modules that
  // actually offer a bi-weekly rate (and that are part of this checkout).
  for (const [moduleId, cadence] of cadenceById) {
    if (cadence !== "biweekly") continue;
    const mod = selectedModules.find((m) => m.id === moduleId);
    if (!mod) {
      res.status(400).json({ error: `Cadence specified for module ${moduleId}, which is not in this checkout` });
      return;
    }
    if (mod.wholesalePriceBiweekly == null) {
      res.status(400).json({ error: `${mod.name} does not offer bi-weekly billing` });
      return;
    }
  }

  // Price the cart. Per-module override (0% partner-direct, 25% resale
  // engines) beats the agency-wide markup; applyMarkup=false still forces
  // pass-through.
  let totalWholesale = 0;
  let totalResale = 0;
  const items: ModuleCheckoutItem[] = [];
  for (const mod of modulesToProvision) {
    const cadence = cadenceById.get(mod.id) ?? "monthly";
    const wholesale =
      cadence === "biweekly" ? parseFloat(mod.wholesalePriceBiweekly!) : parseFloat(mod.wholesalePrice);
    const moduleMarkup = effectiveMarkupPercent(mod, markup);
    const resale = applyMarkup !== false ? wholesale * (1 + moduleMarkup / 100) : wholesale;
    items.push({
      moduleId: mod.id,
      cadence,
      wholesale: Math.round(wholesale * 100) / 100,
      resale: Math.round(resale * 100) / 100,
    });
    totalWholesale += wholesale;
    totalResale += resale;
  }

  totalWholesale = Math.round(totalWholesale * 100) / 100;
  totalResale = Math.round(totalResale * 100) / 100;
  const margin = Math.round((totalResale - totalWholesale) * 100) / 100;

  const skippedNote =
    skippedModules.length > 0
      ? ` Skipped ${skippedModules.length} already-provisioned module(s): ${skippedModules.map((m) => m.name).join(", ")}.`
      : "";

  // ── LIVE payment path ──────────────────────────────────────────────────────
  // Stripe is configured: collect a real payment first. Nothing is provisioned
  // here — the checkout.session.completed webhook provisions the snapshotted
  // cart, so a failed or abandoned payment provisions nothing.
  if (liveModuleCheckoutEnabled() && totalResale > 0) {
    try {
      const stripe = await getUncachableStripeClient();
      const itemModById = new Map(modulesToProvision.map((m) => [m.id, m]));
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: items.map((i) => ({
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(i.resale * 100),
            product_data: {
              name: `${itemModById.get(i.moduleId)?.name ?? `Module ${i.moduleId}`} (${i.cadence === "biweekly" ? "bi-weekly" : "monthly"})`,
              description: `Module subscription for ${tenant.brandName} — first ${i.cadence === "biweekly" ? "bi-weekly" : "monthly"} charge`,
            },
          },
        })),
        metadata: { moduleCheckout: "1", tenantId: String(tenantId) },
        success_url: `${appBaseUrl()}/?module_checkout=paid`,
        cancel_url: `${appBaseUrl()}/?module_checkout=cancelled`,
      });

      await db.insert(moduleCheckoutSessionsTable).values({
        tenantId,
        stripeSessionId: session.id,
        checkoutUrl: session.url ?? null,
        status: "pending",
        items,
        totalWholesale: totalWholesale.toFixed(2),
        totalResale: totalResale.toFixed(2),
      });

      res.json(
        SimulateCheckoutResponse.parse({
          success: true,
          transactionId: session.id,
          totalWholesale,
          totalResale,
          margin,
          modulesProvisioned: 0,
          modulesSkipped: skippedModules.length,
          paymentMode: "live_pending",
          checkoutUrl: session.url ?? null,
          message: `Payment required: complete the Stripe checkout to provision ${modulesToProvision.length} module(s) for ${tenant.brandName}. Modules activate as soon as the payment succeeds.${skippedNote}`,
        })
      );
    } catch (err) {
      // A real payment could not be initiated — provision nothing and say so.
      logger.error({ err, tenantId }, "Stripe module checkout session could not be created");
      res.status(502).json({
        error: `Stripe payment could not be started — no modules were provisioned. ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return;
  }

  // ── SIMULATED fallback ─────────────────────────────────────────────────────
  // Stripe isn't configured (or the cart totals $0): provision immediately,
  // clearly labeled as simulated so real revenue is never conflated with it.
  const result = await provisionModuleItems({
    tenantId,
    items,
    paymentMode: "simulated",
  });

  const transactionId = `sim_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

  res.json(
    SimulateCheckoutResponse.parse({
      success: true,
      transactionId,
      totalWholesale,
      totalResale,
      margin,
      modulesProvisioned: result.provisionedCount,
      modulesSkipped: skippedModules.length,
      paymentMode: "simulated",
      message: `SIMULATED checkout (Stripe not configured — no payment collected): provisioned ${result.provisionedCount} module(s) for ${tenant.brandName}. Transaction ${transactionId}.${skippedNote}`,
    })
  );
});

export default router;
