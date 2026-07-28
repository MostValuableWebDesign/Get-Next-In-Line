import { Router, type Request, type IRouter } from "express";
import {
  db,
  sosSettingsTable,
  merchantCoopPartnershipsTable,
  coopSurgeRulesTable,
  coopSurgeActivationsTable,
  tenantsTable,
  type CoopSurgeRule,
  type CoopSurgeActivation,
} from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { getSettingsForTenant } from "../lib/settings";
import {
  computeCapacityStatus,
  CAPACITY_STATUSES,
  type CapacityStatus,
} from "../lib/capacityStatus";
import { partnershipServesPerk, surgeActivationsForTenant } from "../lib/surgeEngine";
import { isBlockedPair, isolationPartnersOf, loadCoopProfiles } from "../lib/coopFirewall";
import {
  GetCoopCapacityResponse,
  UpdateCoopCapacityBody,
  UpdateCoopCapacityResponse,
  ListCoopSurgeRulesResponse,
  CreateCoopSurgeRuleBody,
  CreateCoopSurgeRuleResponse,
  UpdateCoopSurgeRuleBody,
  UpdateCoopSurgeRuleResponse,
  DeleteCoopSurgeRuleResponse,
  ListCoopSurgeActivationsResponse,
} from "@workspace/api-zod";

// ── Co-Op Dynamic Surge Pricing & Traffic Balancing ─────────────────────────
// Merchant-facing capacity broadcasting + per-partnership traffic-routing
// rules (/coop/capacity, /coop/surge-rules, /coop/surge-activations). Tenant
// scope via x-tenant-id, same convention as the rest of /api/coop. Behind the
// shared session auth + tenant authorization middlewares.

const router: IRouter = Router();

function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

async function capacityPayload(tenantId: number) {
  const [settings, live] = await Promise.all([
    getSettingsForTenant(tenantId),
    computeCapacityStatus(tenantId),
  ]);
  return {
    status: live.status,
    source: live.source,
    waitMinutes: live.waitMinutes,
    appointmentsToday: live.appointmentsToday,
    capacityThreshold: settings?.capacityThreshold ?? null,
    manualStatus: settings?.capacityStatusOverride?.trim() || null,
    overrideExpiresAt: iso(settings?.capacityOverrideExpiresAt),
  };
}

// ── GET /coop/capacity — live capacity status + settings for the tenant ─────
router.get("/coop/capacity", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  res.json(GetCoopCapacityResponse.parse(await capacityPayload(tenantId)));
});

// ── PATCH /coop/capacity — set threshold / flip manual status ────────────────
router.patch("/coop/capacity", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const body = UpdateCoopCapacityBody.parse(req.body);
  const settings = await getSettingsForTenant(tenantId);
  if (!settings) {
    res.status(404).json({ message: "Business not found" });
    return;
  }

  const updates: Partial<typeof sosSettingsTable.$inferInsert> = { updatedAt: new Date() };
  if (body.capacityThreshold !== undefined) {
    updates.capacityThreshold = body.capacityThreshold;
  }
  if (body.manualStatus !== undefined) {
    if (body.manualStatus == null) {
      // Back to automatic.
      updates.capacityStatusOverride = "";
      updates.capacityOverrideExpiresAt = null;
    } else {
      if (!(CAPACITY_STATUSES as readonly string[]).includes(body.manualStatus)) {
        res.status(400).json({ message: "Invalid status" });
        return;
      }
      updates.capacityStatusOverride = body.manualStatus as CapacityStatus;
      updates.capacityOverrideExpiresAt =
        body.overrideMinutes != null && body.overrideMinutes > 0
          ? new Date(Date.now() + body.overrideMinutes * 60_000)
          : null;
    }
  }
  await db.update(sosSettingsTable).set(updates).where(eq(sosSettingsTable.id, settings.id));
  res.json(UpdateCoopCapacityResponse.parse(await capacityPayload(tenantId)));
});

// ── Surge rules ──────────────────────────────────────────────────────────────

function serializeRule(
  r: CoopSurgeRule,
  partnerName: string,
  perkTitle: string,
  liveActivation: CoopSurgeActivation | null,
) {
  return {
    id: r.id,
    partnershipId: r.partnershipId,
    ownerTenantId: r.ownerTenantId,
    partnerName,
    perkTitle,
    triggerType: r.triggerType,
    waitThresholdMinutes: r.waitThresholdMinutes,
    baseDiscountPercent: r.baseDiscountPercent,
    boostedDiscountPercent: r.boostedDiscountPercent,
    boostDurationMinutes: r.boostDurationMinutes,
    windowStartHour: r.windowStartHour,
    windowEndHour: r.windowEndHour,
    isActive: r.isActive,
    liveBoostExpiresAt: liveActivation ? liveActivation.expiresAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

async function ruleWithNames(ruleId: number, viewerTenantId: number) {
  const hostTenant = alias(tenantsTable, "rule_host_tenant");
  const partnerTenant = alias(tenantsTable, "rule_partner_tenant");
  const [row] = await db
    .select({
      rule: coopSurgeRulesTable,
      partnership: merchantCoopPartnershipsTable,
      hostName: hostTenant.brandName,
      partnerName: partnerTenant.brandName,
    })
    .from(coopSurgeRulesTable)
    .innerJoin(
      merchantCoopPartnershipsTable,
      eq(coopSurgeRulesTable.partnershipId, merchantCoopPartnershipsTable.id),
    )
    .innerJoin(hostTenant, eq(merchantCoopPartnershipsTable.hostTenantId, hostTenant.id))
    .innerJoin(partnerTenant, eq(merchantCoopPartnershipsTable.partnerTenantId, partnerTenant.id))
    .where(eq(coopSurgeRulesTable.id, ruleId));
  if (!row) return null;
  const counterpartName =
    row.partnership.hostTenantId === viewerTenantId ? row.partnerName : row.hostName;
  return { ...row, counterpartName };
}

function validateRuleShape(body: {
  triggerType: string;
  waitThresholdMinutes?: number | null;
  baseDiscountPercent: number;
  boostedDiscountPercent: number;
  boostDurationMinutes: number;
  windowStartHour?: number | null;
  windowEndHour?: number | null;
}): string | null {
  if (!["wait_minutes", "at_capacity"].includes(body.triggerType)) return "Invalid trigger type";
  if (body.triggerType === "wait_minutes") {
    if (body.waitThresholdMinutes == null || body.waitThresholdMinutes < 5)
      return "A wait threshold of at least 5 minutes is required";
  }
  if (body.boostedDiscountPercent <= body.baseDiscountPercent)
    return "The boosted discount must be higher than the base discount";
  if (body.baseDiscountPercent < 0 || body.boostedDiscountPercent > 100)
    return "Discounts must be between 0 and 100 percent";
  if (body.boostDurationMinutes < 15 || body.boostDurationMinutes > 24 * 60)
    return "Boost duration must be between 15 minutes and 24 hours";
  const hasStart = body.windowStartHour != null;
  const hasEnd = body.windowEndHour != null;
  if (hasStart !== hasEnd) return "Provide both window hours or neither";
  if (hasStart && hasEnd) {
    for (const h of [body.windowStartHour!, body.windowEndHour!]) {
      if (!Number.isInteger(h) || h < 0 || h > 23) return "Window hours must be 0-23";
    }
  }
  return null;
}

// ── GET /coop/surge-rules — the scoped tenant's routing rules ───────────────
router.get("/coop/surge-rules", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const hostTenant = alias(tenantsTable, "rules_host_tenant");
  const partnerTenant = alias(tenantsTable, "rules_partner_tenant");
  const rows = await db
    .select({
      rule: coopSurgeRulesTable,
      partnership: merchantCoopPartnershipsTable,
      hostName: hostTenant.brandName,
      partnerName: partnerTenant.brandName,
    })
    .from(coopSurgeRulesTable)
    .innerJoin(
      merchantCoopPartnershipsTable,
      eq(coopSurgeRulesTable.partnershipId, merchantCoopPartnershipsTable.id),
    )
    .innerJoin(hostTenant, eq(merchantCoopPartnershipsTable.hostTenantId, hostTenant.id))
    .innerJoin(partnerTenant, eq(merchantCoopPartnershipsTable.partnerTenantId, partnerTenant.id))
    .where(eq(coopSurgeRulesTable.ownerTenantId, tenantId))
    .orderBy(desc(coopSurgeRulesTable.createdAt), desc(coopSurgeRulesTable.id));

  const live = await db
    .select()
    .from(coopSurgeActivationsTable)
    .where(isNull(coopSurgeActivationsTable.endedAt));
  const liveByRule = new Map(live.map((a) => [a.ruleId, a]));

  res.json(
    ListCoopSurgeRulesResponse.parse(
      rows.map((r) =>
        serializeRule(
          r.rule,
          r.partnership.hostTenantId === tenantId ? r.partnerName : r.hostName,
          r.partnership.perkTitle,
          liveByRule.get(r.rule.id) ?? null,
        ),
      ),
    ),
  );
});

// ── POST /coop/surge-rules — create a routing rule on a partnership ─────────
router.post("/coop/surge-rules", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const body = CreateCoopSurgeRuleBody.parse(req.body);
  const shapeError = validateRuleShape(body);
  if (shapeError) {
    res.status(400).json({ message: shapeError });
    return;
  }

  const [partnership] = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.id, body.partnershipId));
  if (!partnership) {
    res.status(404).json({ message: "Partnership not found" });
    return;
  }
  if (partnership.hostTenantId !== tenantId && partnership.partnerTenantId !== tenantId) {
    res.status(403).json({ message: "You are not a party to this partnership" });
    return;
  }
  if (!partnershipServesPerk(partnership)) {
    res.status(400).json({
      message: "Traffic-routing rules can only be set on accepted, active partnerships",
    });
    return;
  }
  // Industry-barrier backstop: competitors never appear in routing rules.
  const otherTenantId =
    partnership.hostTenantId === tenantId
      ? partnership.partnerTenantId
      : partnership.hostTenantId;
  const [profiles, isolated] = await Promise.all([
    loadCoopProfiles([tenantId, otherTenantId]),
    isolationPartnersOf(tenantId),
  ]);
  const mine = profiles.get(tenantId);
  const theirs = profiles.get(otherTenantId);
  if (mine && theirs && isBlockedPair(mine, theirs, isolated.has(otherTenantId))) {
    res.status(403).json({
      message: "Same-industry pairings are restricted by platform guidelines.",
    });
    return;
  }

  const [created] = await db
    .insert(coopSurgeRulesTable)
    .values({
      partnershipId: partnership.id,
      ownerTenantId: tenantId,
      triggerType: body.triggerType,
      waitThresholdMinutes:
        body.triggerType === "wait_minutes" ? (body.waitThresholdMinutes ?? null) : null,
      baseDiscountPercent: body.baseDiscountPercent,
      boostedDiscountPercent: body.boostedDiscountPercent,
      boostDurationMinutes: body.boostDurationMinutes,
      windowStartHour: body.windowStartHour ?? null,
      windowEndHour: body.windowEndHour ?? null,
    })
    .returning();
  const row = await ruleWithNames(created.id, tenantId);
  res
    .status(201)
    .json(
      CreateCoopSurgeRuleResponse.parse(
        serializeRule(created, row?.counterpartName ?? "", row?.partnership.perkTitle ?? "", null),
      ),
    );
});

// ── PATCH /coop/surge-rules/:id — edit or pause a rule ──────────────────────
router.patch("/coop/surge-rules/:id", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  const body = UpdateCoopSurgeRuleBody.parse(req.body);
  const [existing] = await db
    .select()
    .from(coopSurgeRulesTable)
    .where(and(eq(coopSurgeRulesTable.id, id), eq(coopSurgeRulesTable.ownerTenantId, tenantId)));
  if (!existing) {
    res.status(404).json({ message: "Rule not found" });
    return;
  }
  const merged = {
    triggerType: body.triggerType ?? existing.triggerType,
    waitThresholdMinutes:
      body.waitThresholdMinutes !== undefined
        ? body.waitThresholdMinutes
        : existing.waitThresholdMinutes,
    baseDiscountPercent: body.baseDiscountPercent ?? existing.baseDiscountPercent,
    boostedDiscountPercent: body.boostedDiscountPercent ?? existing.boostedDiscountPercent,
    boostDurationMinutes: body.boostDurationMinutes ?? existing.boostDurationMinutes,
    windowStartHour:
      body.windowStartHour !== undefined ? body.windowStartHour : existing.windowStartHour,
    windowEndHour: body.windowEndHour !== undefined ? body.windowEndHour : existing.windowEndHour,
  };
  const shapeError = validateRuleShape(merged);
  if (shapeError) {
    res.status(400).json({ message: shapeError });
    return;
  }
  const [updated] = await db
    .update(coopSurgeRulesTable)
    .set({
      ...merged,
      waitThresholdMinutes:
        merged.triggerType === "wait_minutes" ? merged.waitThresholdMinutes : null,
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      updatedAt: new Date(),
    })
    .where(eq(coopSurgeRulesTable.id, id))
    .returning();
  const [live] = await db
    .select()
    .from(coopSurgeActivationsTable)
    .where(
      and(eq(coopSurgeActivationsTable.ruleId, id), isNull(coopSurgeActivationsTable.endedAt)),
    )
    .limit(1);
  const row = await ruleWithNames(id, tenantId);
  res.json(
    UpdateCoopSurgeRuleResponse.parse(
      serializeRule(
        updated,
        row?.counterpartName ?? "",
        row?.partnership.perkTitle ?? "",
        live ?? null,
      ),
    ),
  );
});

// ── DELETE /coop/surge-rules/:id ─────────────────────────────────────────────
router.delete("/coop/surge-rules/:id", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  // Cascade removes the rule's activations too — any live boost reverts
  // immediately because its activation row is gone.
  const [deleted] = await db
    .delete(coopSurgeRulesTable)
    .where(and(eq(coopSurgeRulesTable.id, id), eq(coopSurgeRulesTable.ownerTenantId, tenantId)))
    .returning({ id: coopSurgeRulesTable.id });
  if (!deleted) {
    res.status(404).json({ message: "Rule not found" });
    return;
  }
  res.json(DeleteCoopSurgeRuleResponse.parse({ deleted: true }));
});

// ── GET /coop/surge-activations — live boosts + recent history ──────────────
router.get("/coop/surge-activations", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const rows = await surgeActivationsForTenant(tenantId);
  res.json(
    ListCoopSurgeActivationsResponse.parse(
      rows.map((r) => ({
        id: r.activation.id,
        ruleId: r.activation.ruleId,
        partnershipId: r.activation.partnershipId,
        ownerTenantId: r.activation.ownerTenantId,
        perkTitle: r.partnership.perkTitle,
        partnerName:
          r.partnership.hostTenantId === tenantId ? r.partnerTenantName : r.hostTenantName,
        baseDiscountPercent: r.activation.baseDiscountPercent,
        boostedDiscountPercent: r.activation.boostedDiscountPercent,
        triggerReason: r.activation.triggerReason,
        activatedAt: r.activation.activatedAt.toISOString(),
        expiresAt: r.activation.expiresAt.toISOString(),
        endedAt: iso(r.activation.endedAt),
        endReason: r.activation.endReason,
        isLive:
          r.activation.endedAt == null && r.activation.expiresAt.getTime() > Date.now(),
      })),
    ),
  );
});

export default router;
