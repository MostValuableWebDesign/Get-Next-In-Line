// Module checkout payment + provisioning engine.
//
// Two payment modes, one provisioning path:
//   - "simulated": Stripe isn't configured — modules are provisioned
//     immediately with no real charge, and the record says so.
//   - "live": Stripe IS configured — checkout creates a real Stripe Checkout
//     session and provisions NOTHING until the checkout.session.completed
//     webhook confirms the payment. Failed/expired sessions provision nothing.
//
// The pending cart is snapshotted in module_checkout_sessions (priced at
// checkout time, never re-derived at webhook time), and the row's
// pending → completed conditional claim makes webhook handling idempotent.
import {
  db,
  tenantsTable,
  tenantActivitiesTable,
  tenantModulesTable,
  modulesTable,
  moduleCheckoutSessionsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { recordLedgerEventsSafe } from "./platformLedger";
import { isStripeConfigured } from "./stripeClient";
import { logger } from "./logger";

/** Bi-weekly charges recur 26×/year → monthly-equivalent factor for MRR. */
export const BIWEEKLY_TO_MONTHLY = 26 / 12;

export type ModuleCheckoutCadence = "monthly" | "biweekly";

/** One priced line of a checkout cart (amounts fixed at checkout time). */
export interface ModuleCheckoutItem {
  moduleId: number;
  cadence: ModuleCheckoutCadence;
  wholesale: number;
  resale: number;
}

// ── Live-mode gate ───────────────────────────────────────────────────────────
// Under NODE_ENV=test the live Stripe path is disabled by default so existing
// checkout integration tests (which don't mock Stripe) keep exercising the
// simulated path against the real dev DB. Live-mode tests opt back in via the
// hook below with a mocked Stripe client.
let liveCheckoutForTests: boolean | null = null;

/** Test hook: force live module checkout on/off (null restores default). */
export function __setLiveModuleCheckoutForTests(value: boolean | null): void {
  liveCheckoutForTests = value;
}

/** Whether module checkout should collect a real Stripe payment. */
export function liveModuleCheckoutEnabled(): boolean {
  if (process.env.NODE_ENV === "test") return liveCheckoutForTests ?? false;
  return isStripeConfigured();
}

// ── Provisioning (shared by simulated route + payment webhook) ───────────────

export interface ProvisionResult {
  provisionedCount: number;
  provisionedNames: string[];
  skippedNames: string[];
  mrrDelta: number;
}

/**
 * Provision the given priced items for a tenant: tenant_modules rows (with
 * payment mode), compliance-ledger entries, tenant MRR/modulesEnabled update,
 * and an activity-log entry. Items whose module the tenant already has are
 * skipped (never double-provisioned, never double-counted in MRR).
 */
export async function provisionModuleItems(opts: {
  tenantId: number;
  items: ModuleCheckoutItem[];
  paymentMode: "simulated" | "live";
  stripeCheckoutSessionId?: string | null;
}): Promise<ProvisionResult> {
  const { tenantId, items, paymentMode } = opts;

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

  const moduleIds = items.map((i) => i.moduleId);
  const mods = moduleIds.length
    ? await db.select().from(modulesTable).where(inArray(modulesTable.id, moduleIds))
    : [];
  const moduleById = new Map(mods.map((m) => [m.id, m]));
  const itemById = new Map(items.map((i) => [i.moduleId, i]));

  const created = items.length
    ? await db
        .insert(tenantModulesTable)
        .values(
          items
            .filter((i) => moduleById.has(i.moduleId))
            .map((i) => ({
              tenantId,
              moduleId: i.moduleId,
              billingCadence: i.cadence,
              chargedWholesale: i.wholesale.toFixed(2),
              chargedResale: i.resale.toFixed(2),
              paymentMode,
              stripeCheckoutSessionId: opts.stripeCheckoutSessionId ?? null,
            }))
        )
        .onConflictDoNothing()
        .returning()
    : [];

  // Compliance ledger: one immutable entry per provisioned charge, carrying
  // the realized wholesale/resale so reports never re-derive pricing.
  await recordLedgerEventsSafe(
    created.flatMap((row) => {
      const mod = moduleById.get(row.moduleId);
      const item = itemById.get(row.moduleId);
      if (!mod || !item) return [];
      return [
        {
          source: "module_subscription" as const,
          sourceRef: `tenant_modules:${row.id}`,
          tenantId,
          category: mod.category,
          description: `${mod.name} (${row.billingCadence})${paymentMode === "simulated" ? " — simulated, no real charge" : " — paid via Stripe"}`,
          amount: item.resale.toFixed(2),
          wholesaleAmount: item.wholesale.toFixed(2),
          platformMargin: (Math.round((item.resale - item.wholesale) * 100) / 100).toFixed(2),
          occurredAt: row.provisionedAt,
        },
      ];
    })
  );

  // MRR delta counts only the rows actually created (monthly-equivalent).
  let mrrDelta = 0;
  const provisionedNames: string[] = [];
  for (const row of created) {
    const item = itemById.get(row.moduleId);
    const mod = moduleById.get(row.moduleId);
    if (!item) continue;
    mrrDelta += item.cadence === "biweekly" ? item.resale * BIWEEKLY_TO_MONTHLY : item.resale;
    provisionedNames.push(
      `${mod?.name ?? `module ${row.moduleId}`} (${item.cadence === "biweekly" ? "bi-weekly" : "monthly"})`
    );
  }

  const createdIds = new Set(created.map((r) => r.moduleId));
  const skippedNames = items
    .filter((i) => !createdIds.has(i.moduleId))
    .map((i) => moduleById.get(i.moduleId)?.name ?? `module ${i.moduleId}`);

  // Derive modulesEnabled from the join table so the two can never drift apart.
  const assignmentsAfter = await db
    .select()
    .from(tenantModulesTable)
    .where(eq(tenantModulesTable.tenantId, tenantId));

  await db
    .update(tenantsTable)
    .set({
      mrr: String(Math.round((parseFloat(tenant.mrr ?? "0") + mrrDelta) * 100) / 100),
      modulesEnabled: assignmentsAfter.length,
    })
    .where(eq(tenantsTable.id, tenantId));

  await db.insert(tenantActivitiesTable).values({
    tenantId,
    action: paymentMode === "live" ? "Modules provisioned (paid)" : "Modules provisioned",
    details: `${created.length} module(s) activated — ${provisionedNames.join(", ")}${
      skippedNames.length > 0 ? ` (skipped already-active: ${skippedNames.join(", ")})` : ""
    }${paymentMode === "live" ? " — payment collected via Stripe" : " — SIMULATED checkout, no payment collected"}`,
  });

  return {
    provisionedCount: created.length,
    provisionedNames,
    skippedNames,
    mrrDelta,
  };
}

// ── Stripe webhook lifecycle ─────────────────────────────────────────────────

export interface ModuleCheckoutStripeEvent {
  type: string;
  data?: { object?: { id?: string } };
}

/**
 * Apply a (signature-verified) Stripe event to the module-checkout lifecycle.
 *
 * checkout.session.completed → claim the pending row (pending → completed,
 * exactly once) and provision the snapshotted cart as a LIVE payment.
 * checkout.session.expired → mark failed; nothing is ever provisioned.
 *
 * Sessions we don't recognize (e.g. no-show deposit holds) are ignored.
 */
export async function applyModuleCheckoutEvent(event: ModuleCheckoutStripeEvent): Promise<void> {
  const sessionId = event.data?.object?.id;
  if (!sessionId) return;

  if (event.type === "checkout.session.expired") {
    await db
      .update(moduleCheckoutSessionsTable)
      .set({ status: "failed", completedAt: new Date() })
      .where(
        and(
          eq(moduleCheckoutSessionsTable.stripeSessionId, sessionId),
          eq(moduleCheckoutSessionsTable.status, "pending")
        )
      );
    return;
  }

  if (event.type !== "checkout.session.completed") return;

  // Send-once claim: only the update that flips pending → completed wins;
  // Stripe webhook retries and duplicate deliveries provision nothing more.
  const [claimed] = await db
    .update(moduleCheckoutSessionsTable)
    .set({ status: "completed", completedAt: new Date() })
    .where(
      and(
        eq(moduleCheckoutSessionsTable.stripeSessionId, sessionId),
        eq(moduleCheckoutSessionsTable.status, "pending")
      )
    )
    .returning();
  if (!claimed) return; // not a module checkout session, or already handled

  try {
    const result = await provisionModuleItems({
      tenantId: claimed.tenantId,
      items: claimed.items as ModuleCheckoutItem[],
      paymentMode: "live",
      stripeCheckoutSessionId: sessionId,
    });
    logger.info(
      { sessionId, tenantId: claimed.tenantId, provisioned: result.provisionedCount },
      "Module checkout paid — modules provisioned"
    );
  } catch (err) {
    // Payment succeeded but provisioning crashed: surface loudly (money was
    // collected). The claim stays "completed" so retries won't double-charge
    // MRR; operators resolve via the activity/ledger trail.
    logger.error(
      { err, sessionId, tenantId: claimed.tenantId },
      "Module checkout payment completed but provisioning FAILED — manual review required"
    );
    throw err;
  }
}
