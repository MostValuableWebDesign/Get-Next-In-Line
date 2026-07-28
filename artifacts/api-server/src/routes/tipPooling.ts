import { Router, type Request, type IRouter } from "express";
import {
  db,
  sosTipPoolRulesTable,
  sosTipPoolRuleParticipantsTable,
  sosVisitBundlesTable,
  sosTipPoolLedgerTable,
  sosVisitsTable,
  sosStaffMembersTable,
  merchantCoopPartnershipsTable,
  tenantsTable,
  type SosTipPoolRule,
  type SosTipPoolRuleParticipant,
  type MerchantCoopPartnership,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  ListTipPoolRulesResponse,
  CreateTipPoolRuleBody,
  CreateTipPoolRuleResponse,
  UpdateTipPoolRuleBody,
  UpdateTipPoolRuleResponse,
  ListTipPoolPartnerStaffResponse,
  CreateTipPoolBundleBody,
  CreateTipPoolBundleResponse,
  AttachTipPoolBundleVisitBody,
  AttachTipPoolBundleVisitResponse,
  GetTipSplitPreviewResponse,
  ListGratuityLedgerResponse,
  GetGratuityShiftReportResponse,
} from "@workspace/api-zod";
import { planTipAllocation, describeAllocations } from "../lib/tipPooling";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Co-Op Automated Tip-Pooling — /api/sos/tip-pooling
//
// Merchant-defined tip-splitting rules (per active co-op partnership or for
// the tenant's own multi-staff group events), shared-appointment bundles,
// a read-only split preview for checkout, and the itemized gratuity ledger
// (distribution history + end-of-shift report). Ledger accounting only — no
// money movement.
// ---------------------------------------------------------------------------

/** Tenant scope from the x-tenant-id header (same convention as /api/sos). */
function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Strict per-row tenant match (tenant rows vs legacy NULL rows only). */
function tenantMatch(column: PgColumn, tenantId: number | null) {
  return tenantId == null ? isNull(column) : eq(column, tenantId);
}

function isLivePartnership(p: MerchantCoopPartnership): boolean {
  return p.status === "accepted" && p.isActive && !p.disputeSuspended && p.bannedAt == null;
}

async function getPartnership(id: number): Promise<MerchantCoopPartnership | null> {
  const [p] = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.id, id));
  return p ?? null;
}

type ParticipantInput = {
  tenantId?: number;
  staffId: number;
  role?: string;
  percent?: number;
  weight?: number;
};

/**
 * Validate a rule's participants against its method and scope. Returns the
 * normalized participant rows to insert, or an error string.
 */
async function validateParticipants(
  scope: string,
  splitMethod: string,
  participants: ParticipantInput[],
  callerTenantId: number | null,
  partnership: MerchantCoopPartnership | null,
): Promise<{ rows: Omit<SosTipPoolRuleParticipant, "id" | "ruleId">[] } | { error: string }> {
  const allowedTenantIds =
    scope === "partnership" && partnership
      ? new Set([partnership.hostTenantId, partnership.partnerTenantId])
      : null;

  const normalized = participants.map((p) => ({
    tenantId: p.tenantId ?? callerTenantId,
    staffId: p.staffId,
    role: p.role ?? null,
    percent: p.percent ?? null,
    weight: p.weight ?? null,
  }));

  for (const p of normalized) {
    if (allowedTenantIds) {
      if (p.tenantId == null || !allowedTenantIds.has(p.tenantId))
        return { error: "Every participant must belong to one of the two partnered businesses" };
    } else if (p.tenantId !== callerTenantId && !(p.tenantId == null && callerTenantId == null)) {
      return { error: "Group-event rule participants must belong to your own business" };
    }
  }

  // Method-specific terms.
  if (splitMethod === "percentage") {
    const total = normalized.reduce((a, p) => a + (p.percent ?? 0), 0);
    if (normalized.some((p) => p.percent == null || p.percent <= 0))
      return { error: "Every participant needs a positive percent for a percentage split" };
    if (total !== 100) return { error: `Percentages must total exactly 100 (got ${total})` };
  } else if (splitMethod === "role_weighted") {
    if (normalized.some((p) => p.weight == null || p.weight <= 0))
      return { error: "Every participant needs a positive weight for a role-weighted split" };
  } else {
    // equal — weights/percents don't apply.
    for (const p of normalized) {
      p.percent = null;
      p.weight = null;
    }
  }

  // No duplicate staff, and each staff member must exist in the claimed
  // business (active staff only).
  const staffIds = normalized.map((p) => p.staffId);
  if (new Set(staffIds).size !== staffIds.length)
    return { error: "A staff member can appear only once in a rule" };
  const staff = await db
    .select({
      id: sosStaffMembersTable.id,
      tenantId: sosStaffMembersTable.tenantId,
      isActive: sosStaffMembersTable.isActive,
    })
    .from(sosStaffMembersTable)
    .where(inArray(sosStaffMembersTable.id, staffIds));
  const byId = new Map(staff.map((s) => [s.id, s]));
  for (const p of normalized) {
    const s = byId.get(p.staffId);
    if (!s || s.tenantId !== p.tenantId)
      return { error: `Staff member ${p.staffId} not found in the specified business` };
    if (!s.isActive) return { error: `Staff member ${p.staffId} is deactivated` };
  }

  return { rows: normalized };
}

async function serializeRules(
  rules: SosTipPoolRule[],
  callerTenantId: number | null,
) {
  if (rules.length === 0) return [];
  const ruleIds = rules.map((r) => r.id);
  const participants = await db
    .select({
      p: sosTipPoolRuleParticipantsTable,
      staffName: sosStaffMembersTable.name,
      tenantName: tenantsTable.brandName,
    })
    .from(sosTipPoolRuleParticipantsTable)
    .innerJoin(
      sosStaffMembersTable,
      eq(sosTipPoolRuleParticipantsTable.staffId, sosStaffMembersTable.id),
    )
    .leftJoin(tenantsTable, eq(sosTipPoolRuleParticipantsTable.tenantId, tenantsTable.id))
    .where(inArray(sosTipPoolRuleParticipantsTable.ruleId, ruleIds))
    .orderBy(sosTipPoolRuleParticipantsTable.id);

  const partnershipIds = [
    ...new Set(rules.map((r) => r.partnershipId).filter((x): x is number => x != null)),
  ];
  const partnerNameByPartnership = new Map<number, string | null>();
  if (partnershipIds.length > 0) {
    const hostTenant = sql`coop_tip_host`;
    void hostTenant;
    const partnerships = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(inArray(merchantCoopPartnershipsTable.id, partnershipIds));
    const tenantIds = [
      ...new Set(partnerships.flatMap((p) => [p.hostTenantId, p.partnerTenantId])),
    ];
    const names = tenantIds.length
      ? await db
          .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
          .from(tenantsTable)
          .where(inArray(tenantsTable.id, tenantIds))
      : [];
    const nameById = new Map(names.map((n) => [n.id, n.brandName]));
    for (const p of partnerships) {
      // "The OTHER business" from the caller's point of view.
      const otherId =
        callerTenantId != null && p.hostTenantId === callerTenantId
          ? p.partnerTenantId
          : p.hostTenantId;
      partnerNameByPartnership.set(p.id, nameById.get(otherId) ?? null);
    }
  }

  return rules.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    scope: r.scope,
    partnershipId: r.partnershipId,
    partnerTenantName:
      r.partnershipId == null ? null : (partnerNameByPartnership.get(r.partnershipId) ?? null),
    splitMethod: r.splitMethod,
    isActive: r.isActive,
    participants: participants
      .filter((row) => row.p.ruleId === r.id)
      .map((row) => ({
        id: row.p.id,
        tenantId: row.p.tenantId,
        tenantName: row.tenantName,
        staffId: row.p.staffId,
        staffName: row.staffName,
        role: row.p.role,
        percent: row.p.percent,
        weight: row.p.weight,
      })),
    createdAt: r.createdAt.toISOString(),
  }));
}

// ── rules CRUD ───────────────────────────────────────────────────────────────

router.get("/sos/tip-pooling/rules", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  // Own rules, plus shared partnership rules where the caller is either side.
  const conditions = [tenantMatch(sosTipPoolRulesTable.tenantId, tenantId)];
  if (tenantId != null) {
    const partnerships = await db
      .select({ id: merchantCoopPartnershipsTable.id })
      .from(merchantCoopPartnershipsTable)
      .where(
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId),
        ),
      );
    if (partnerships.length > 0)
      conditions.push(
        inArray(
          sosTipPoolRulesTable.partnershipId,
          partnerships.map((p) => p.id),
        ),
      );
  }
  const rules = await db
    .select()
    .from(sosTipPoolRulesTable)
    .where(or(...conditions))
    .orderBy(desc(sosTipPoolRulesTable.id));
  res.json(ListTipPoolRulesResponse.parse(await serializeRules(rules, tenantId)));
});

router.post("/sos/tip-pooling/rules", async (req, res): Promise<void> => {
  const body = CreateTipPoolRuleBody.parse(req.body);
  const tenantId = tenantIdFrom(req);

  let partnership: MerchantCoopPartnership | null = null;
  if (body.scope === "partnership") {
    if (body.partnershipId == null) {
      res.status(400).json({ message: "partnershipId is required for a partnership rule" });
      return;
    }
    partnership = await getPartnership(body.partnershipId);
    if (!partnership) {
      res.status(404).json({ message: "Partnership not found" });
      return;
    }
    if (
      tenantId == null ||
      (partnership.hostTenantId !== tenantId && partnership.partnerTenantId !== tenantId)
    ) {
      res.status(403).json({ message: "You are not a participant of this partnership" });
      return;
    }
    if (!isLivePartnership(partnership)) {
      res
        .status(409)
        .json({ message: "Cross-business tip rules require an accepted, active partnership" });
      return;
    }
  }

  const validated = await validateParticipants(
    body.scope,
    body.splitMethod,
    body.participants,
    tenantId,
    partnership,
  );
  if ("error" in validated) {
    res.status(400).json({ message: validated.error });
    return;
  }

  const rule = await db.transaction(async (tx) => {
    const [r] = await tx
      .insert(sosTipPoolRulesTable)
      .values({
        tenantId,
        scope: body.scope,
        partnershipId: body.scope === "partnership" ? body.partnershipId! : null,
        splitMethod: body.splitMethod,
      })
      .returning();
    await tx
      .insert(sosTipPoolRuleParticipantsTable)
      .values(validated.rows.map((p) => ({ ...p, ruleId: r.id })));
    return r;
  });

  res
    .status(201)
    .json(CreateTipPoolRuleResponse.parse((await serializeRules([rule], tenantId))[0]));
});

router.patch("/sos/tip-pooling/rules/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const body = UpdateTipPoolRuleBody.parse(req.body);
  const tenantId = tenantIdFrom(req);

  // Owner business only (both partners can VIEW a shared rule; only its
  // creator edits it).
  const [existing] = await db
    .select()
    .from(sosTipPoolRulesTable)
    .where(and(eq(sosTipPoolRulesTable.id, id), tenantMatch(sosTipPoolRulesTable.tenantId, tenantId)));
  if (!existing) {
    res.status(404).json({ message: "Rule not found" });
    return;
  }

  const nextMethod = body.splitMethod ?? existing.splitMethod;
  let partnership: MerchantCoopPartnership | null = null;
  if (existing.partnershipId != null) partnership = await getPartnership(existing.partnershipId);

  const updated = await db.transaction(async (tx) => {
    if (body.participants) {
      const validated = await validateParticipants(
        existing.scope,
        nextMethod,
        body.participants,
        tenantId,
        partnership,
      );
      if ("error" in validated) return { error: validated.error };
      await tx
        .delete(sosTipPoolRuleParticipantsTable)
        .where(eq(sosTipPoolRuleParticipantsTable.ruleId, id));
      await tx
        .insert(sosTipPoolRuleParticipantsTable)
        .values(validated.rows.map((p) => ({ ...p, ruleId: id })));
    } else if (body.splitMethod && body.splitMethod !== existing.splitMethod) {
      // Changing method without re-supplying participants would leave stale
      // terms behind — require the full participant list.
      return { error: "participants are required when changing the split method" };
    }
    const [r] = await tx
      .update(sosTipPoolRulesTable)
      .set({
        splitMethod: nextMethod,
        isActive: body.isActive ?? existing.isActive,
        updatedAt: new Date(),
      })
      .where(eq(sosTipPoolRulesTable.id, id))
      .returning();
    return { rule: r };
  });
  if ("error" in updated) {
    res.status(400).json({ message: updated.error });
    return;
  }
  res.json(UpdateTipPoolRuleResponse.parse((await serializeRules([updated.rule!], tenantId))[0]));
});

router.delete("/sos/tip-pooling/rules/:id", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  const [deleted] = await db
    .delete(sosTipPoolRulesTable)
    .where(
      and(
        eq(sosTipPoolRulesTable.id, Number(req.params.id)),
        tenantMatch(sosTipPoolRulesTable.tenantId, tenantId),
      ),
    )
    .returning({ id: sosTipPoolRulesTable.id });
  if (!deleted) {
    res.status(404).json({ message: "Rule not found" });
    return;
  }
  res.status(204).end();
});

// ── partner staff lookup (for building shared rules) ────────────────────────

router.get("/sos/tip-pooling/partner-staff", async (req, res): Promise<void> => {
  const partnershipId = Number(req.query.partnershipId);
  const tenantId = tenantIdFrom(req);
  if (!Number.isInteger(partnershipId) || partnershipId <= 0) {
    res.status(400).json({ message: "partnershipId is required" });
    return;
  }
  const partnership = await getPartnership(partnershipId);
  if (!partnership) {
    res.status(404).json({ message: "Partnership not found" });
    return;
  }
  if (
    tenantId == null ||
    (partnership.hostTenantId !== tenantId && partnership.partnerTenantId !== tenantId)
  ) {
    res.status(403).json({ message: "You are not a participant of this partnership" });
    return;
  }
  const otherTenantId =
    partnership.hostTenantId === tenantId ? partnership.partnerTenantId : partnership.hostTenantId;
  const staff = await db
    .select({ id: sosStaffMembersTable.id, name: sosStaffMembersTable.name })
    .from(sosStaffMembersTable)
    .where(
      and(eq(sosStaffMembersTable.tenantId, otherTenantId), eq(sosStaffMembersTable.isActive, true)),
    )
    .orderBy(sosStaffMembersTable.name);
  res.json(ListTipPoolPartnerStaffResponse.parse(staff));
});

// ── shared-appointment bundles ───────────────────────────────────────────────

async function serializeBundle(bundleId: number) {
  const [bundle] = await db
    .select()
    .from(sosVisitBundlesTable)
    .where(eq(sosVisitBundlesTable.id, bundleId));
  const visits = await db
    .select({ id: sosVisitsTable.id })
    .from(sosVisitsTable)
    .where(eq(sosVisitsTable.bundleId, bundleId))
    .orderBy(sosVisitsTable.id);
  return {
    id: bundle.id,
    partnershipId: bundle.partnershipId,
    visitIds: visits.map((v) => v.id),
    createdAt: bundle.createdAt.toISOString(),
  };
}

/**
 * Link the caller's own, not-yet-checked-out, unbundled visit into a bundle.
 * Conditional update = the concurrency guard against double-bundling.
 */
async function claimVisitIntoBundle(
  visitId: number,
  bundleId: number,
  tenantId: number | null,
): Promise<"ok" | "not_found" | "conflict"> {
  const [visit] = await db
    .select({ id: sosVisitsTable.id, status: sosVisitsTable.status, bundleId: sosVisitsTable.bundleId })
    .from(sosVisitsTable)
    .where(and(eq(sosVisitsTable.id, visitId), tenantMatch(sosVisitsTable.tenantId, tenantId)));
  if (!visit) return "not_found";
  if (visit.status === "checked_out" || visit.bundleId != null) return "conflict";
  const [claimed] = await db
    .update(sosVisitsTable)
    .set({ bundleId })
    .where(and(eq(sosVisitsTable.id, visitId), isNull(sosVisitsTable.bundleId)))
    .returning({ id: sosVisitsTable.id });
  return claimed ? "ok" : "conflict";
}

router.post("/sos/tip-pooling/bundles", async (req, res): Promise<void> => {
  const body = CreateTipPoolBundleBody.parse(req.body);
  const tenantId = tenantIdFrom(req);
  const partnership = await getPartnership(body.partnershipId);
  if (!partnership) {
    res.status(404).json({ message: "Partnership not found" });
    return;
  }
  if (
    tenantId == null ||
    (partnership.hostTenantId !== tenantId && partnership.partnerTenantId !== tenantId)
  ) {
    res.status(403).json({ message: "You are not a participant of this partnership" });
    return;
  }
  if (!isLivePartnership(partnership)) {
    res.status(409).json({ message: "Bundles require an accepted, active partnership" });
    return;
  }
  const [bundle] = await db
    .insert(sosVisitBundlesTable)
    .values({ partnershipId: partnership.id, createdByTenantId: tenantId })
    .returning();
  const outcome = await claimVisitIntoBundle(body.visitId, bundle.id, tenantId);
  if (outcome !== "ok") {
    await db.delete(sosVisitBundlesTable).where(eq(sosVisitBundlesTable.id, bundle.id));
    if (outcome === "not_found") res.status(404).json({ message: "Visit not found" });
    else res.status(409).json({ message: "Visit is already checked out or already bundled" });
    return;
  }
  res.status(201).json(CreateTipPoolBundleResponse.parse(await serializeBundle(bundle.id)));
});

router.post("/sos/tip-pooling/bundles/:id/visits", async (req, res): Promise<void> => {
  const bundleId = Number(req.params.id);
  const body = AttachTipPoolBundleVisitBody.parse(req.body);
  const tenantId = tenantIdFrom(req);
  const [bundle] = await db
    .select()
    .from(sosVisitBundlesTable)
    .where(eq(sosVisitBundlesTable.id, bundleId));
  if (!bundle) {
    res.status(404).json({ message: "Bundle not found" });
    return;
  }
  const partnership = await getPartnership(bundle.partnershipId);
  if (
    !partnership ||
    tenantId == null ||
    (partnership.hostTenantId !== tenantId && partnership.partnerTenantId !== tenantId)
  ) {
    res.status(403).json({ message: "You are not a participant of this bundle's partnership" });
    return;
  }
  const outcome = await claimVisitIntoBundle(body.visitId, bundleId, tenantId);
  if (outcome === "not_found") {
    res.status(404).json({ message: "Visit not found" });
    return;
  }
  if (outcome === "conflict") {
    res.status(409).json({ message: "Visit is already checked out or already bundled" });
    return;
  }
  res.json(AttachTipPoolBundleVisitResponse.parse(await serializeBundle(bundleId)));
});

// ── split preview (read-only) ────────────────────────────────────────────────

router.get("/sos/tip-pooling/preview", async (req, res): Promise<void> => {
  const visitId = Number(req.query.visitId);
  const tipAmount = Number(req.query.tipAmount);
  const tenantId = tenantIdFrom(req);
  if (!Number.isFinite(tipAmount) || tipAmount <= 0) {
    res.status(400).json({ message: "tipAmount must be a positive number" });
    return;
  }
  const [visit] = await db
    .select()
    .from(sosVisitsTable)
    .where(and(eq(sosVisitsTable.id, visitId), tenantMatch(sosVisitsTable.tenantId, tenantId)));
  if (!visit) {
    res.status(404).json({ message: "Visit not found" });
    return;
  }
  const { resolved, allocations } = await planTipAllocation(visit, tipAmount, visit.staffId);
  res.json(
    GetTipSplitPreviewResponse.parse({
      ruleId: resolved?.rule.id ?? null,
      splitMethod: resolved?.rule.splitMethod ?? null,
      allocations: await describeAllocations(allocations),
    }),
  );
});

// ── distribution history & shift report ─────────────────────────────────────

router.get("/sos/tip-pooling/ledger", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
  const conditions = [
    or(
      tenantMatch(sosTipPoolLedgerTable.recipientTenantId, tenantId),
      tenantMatch(sosTipPoolLedgerTable.sourceTenantId, tenantId),
    ),
  ];
  if (from && !isNaN(from.getTime())) conditions.push(gte(sosTipPoolLedgerTable.createdAt, from));
  if (to && !isNaN(to.getTime()))
    conditions.push(sql`${sosTipPoolLedgerTable.createdAt} < ${to}`);

  const sourceTenant = tenantsTable;
  const rows = await db
    .select({
      entry: sosTipPoolLedgerTable,
      staffName: sosStaffMembersTable.name,
      sourceTenantName: sourceTenant.brandName,
      serviceType: sosVisitsTable.serviceType,
    })
    .from(sosTipPoolLedgerTable)
    .innerJoin(
      sosStaffMembersTable,
      eq(sosTipPoolLedgerTable.recipientStaffId, sosStaffMembersTable.id),
    )
    .innerJoin(sosVisitsTable, eq(sosTipPoolLedgerTable.visitId, sosVisitsTable.id))
    .leftJoin(sourceTenant, eq(sosTipPoolLedgerTable.sourceTenantId, sourceTenant.id))
    .where(and(...conditions))
    .orderBy(desc(sosTipPoolLedgerTable.createdAt), desc(sosTipPoolLedgerTable.id))
    .limit(500);

  res.json(
    ListGratuityLedgerResponse.parse(
      rows.map((r) => ({
        id: r.entry.id,
        visitId: r.entry.visitId,
        serviceType: r.serviceType,
        sourceTenantId: r.entry.sourceTenantId,
        sourceTenantName: r.sourceTenantName,
        recipientTenantId: r.entry.recipientTenantId,
        recipientStaffId: r.entry.recipientStaffId,
        recipientStaffName: r.staffName,
        grossTip: parseFloat(r.entry.grossTip),
        allocatedShare: parseFloat(r.entry.allocatedShare),
        ruleId: r.entry.ruleId,
        origin:
          (r.entry.sourceTenantId ?? null) === (r.entry.recipientTenantId ?? null)
            ? "own"
            : "partner",
        createdAt: r.entry.createdAt.toISOString(),
      })),
    ),
  );
});

router.get("/sos/tip-pooling/shift-report", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  const date = typeof req.query.date === "string" ? req.query.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ message: "date must be YYYY-MM-DD" });
    return;
  }
  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      entry: sosTipPoolLedgerTable,
      staffName: sosStaffMembersTable.name,
    })
    .from(sosTipPoolLedgerTable)
    .innerJoin(
      sosStaffMembersTable,
      eq(sosTipPoolLedgerTable.recipientStaffId, sosStaffMembersTable.id),
    )
    .where(
      and(
        tenantMatch(sosTipPoolLedgerTable.recipientTenantId, tenantId),
        gte(sosTipPoolLedgerTable.createdAt, dayStart),
        sql`${sosTipPoolLedgerTable.createdAt} < ${dayEnd}`,
      ),
    );

  const byStaff = new Map<
    number,
    { staffId: number; staffName: string; ownCents: number; partnerCents: number; entries: number }
  >();
  for (const r of rows) {
    const cur =
      byStaff.get(r.entry.recipientStaffId) ??
      { staffId: r.entry.recipientStaffId, staffName: r.staffName, ownCents: 0, partnerCents: 0, entries: 0 };
    const shareCents = Math.round(parseFloat(r.entry.allocatedShare) * 100);
    const own = (r.entry.sourceTenantId ?? null) === (r.entry.recipientTenantId ?? null);
    if (own) cur.ownCents += shareCents;
    else cur.partnerCents += shareCents;
    cur.entries += 1;
    byStaff.set(r.entry.recipientStaffId, cur);
  }

  res.json(
    GetGratuityShiftReportResponse.parse(
      [...byStaff.values()]
        .sort((a, b) => a.staffId - b.staffId)
        .map((s) => ({
          staffId: s.staffId,
          staffName: s.staffName,
          ownTips: s.ownCents / 100,
          partnerTips: s.partnerCents / 100,
          totalTips: (s.ownCents + s.partnerCents) / 100,
          entries: s.entries,
        })),
    ),
  );
});

export default router;
