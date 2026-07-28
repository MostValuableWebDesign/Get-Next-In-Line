import { Router, type IRouter } from "express";
import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  coopPerkRedemptionsTable,
  coopObligationLedgerTable,
  coopSettlementCyclesTable,
  coopSettlementStatementsTable,
  platformLedgerEntriesTable,
  sosAppointmentsTable,
  type CoopObligationLedgerEntry,
  type CoopSettlementCycle,
  type CoopSettlementStatement,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import {
  GetMasterOverviewResponse,
  PreviewSettlementCycleResponse,
  RunSettlementBody,
  RunSettlementResponse,
  ListSettlementCyclesResponse,
  GetSettlementCycleResponse,
  GetSettlementStatementResponse,
} from "@workspace/api-zod";
import {
  previewSettlement,
  runSettlementCycle,
  entriesForCycleTenant,
  type NettedStatement,
} from "../lib/coopSettlement";

// ---------------------------------------------------------------------------
// Master Overview & Settlement Clearinghouse — /api/agency/*
//
// Admin-only by path convention (all /agency routes are platform-admin-gated
// by authorizeTenantAccess). Read surfaces aggregate persisted per-event
// amounts; the settlement run is the only write, and past cycles have no
// mutation routes — they can be viewed but never altered.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

const num = (v: string | null | undefined) => parseFloat(v ?? "0");
const round2 = (n: number) => Math.round(n * 100) / 100;

function monthWindow(period: "this_month" | "last_month", now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth() + (period === "last_month" ? -1 : 0), 1);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  return { start, end };
}

router.get("/agency/master-overview", async (req, res): Promise<void> => {
  const period = req.query.period === "last_month" ? "last_month" : "this_month";
  const { start, end } = monthWindow(period);
  const inWindow = (col: typeof sosAppointmentsTable.createdAt) =>
    and(gte(col, start), lt(col, end));

  const [tenants, [bookings], [ledger], partnerships, [redemptions], flows, [unsettled]] =
    await Promise.all([
      db.select({ status: tenantsTable.status }).from(tenantsTable),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(sosAppointmentsTable)
        .where(inWindow(sosAppointmentsTable.createdAt)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          volume: sql<string>`coalesce(sum(${platformLedgerEntriesTable.amount}), 0)`,
        })
        .from(platformLedgerEntriesTable)
        .where(and(gte(platformLedgerEntriesTable.occurredAt, start), lt(platformLedgerEntriesTable.occurredAt, end))),
      db
        .select({
          status: merchantCoopPartnershipsTable.status,
          isActive: merchantCoopPartnershipsTable.isActive,
          createdAt: merchantCoopPartnershipsTable.createdAt,
        })
        .from(merchantCoopPartnershipsTable)
        // HQ template perks are self-paired rows, not real cross-business pacts.
        .where(ne(merchantCoopPartnershipsTable.hostTenantId, merchantCoopPartnershipsTable.partnerTenantId)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(coopPerkRedemptionsTable)
        .where(and(gte(coopPerkRedemptionsTable.redeemedAt, start), lt(coopPerkRedemptionsTable.redeemedAt, end))),
      db
        .select({
          kind: coopObligationLedgerTable.kind,
          total: sql<string>`coalesce(sum(${coopObligationLedgerTable.amount}), 0)`,
          count: sql<number>`count(*)::int`,
        })
        .from(coopObligationLedgerTable)
        .where(and(gte(coopObligationLedgerTable.occurredAt, start), lt(coopObligationLedgerTable.occurredAt, end)))
        .groupBy(coopObligationLedgerTable.kind),
      db
        .select({ total: sql<string>`coalesce(sum(${coopObligationLedgerTable.amount}), 0)` })
        .from(coopObligationLedgerTable)
        .where(isNull(coopObligationLedgerTable.settlementCycleId)),
    ]);

  res.json(
    GetMasterOverviewResponse.parse({
      periodLabel: period === "this_month" ? "This month" : "Last month",
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      activeTenants: tenants.filter((t) => t.status === "active").length,
      suspendedTenants: tenants.filter((t) => t.status === "suspended").length,
      totalTenants: tenants.length,
      bookingsCount: bookings?.count ?? 0,
      transactionCount: ledger?.count ?? 0,
      transactionVolume: round2(num(ledger?.volume)),
      partnershipsActive: partnerships.filter((p) => p.status === "accepted" && p.isActive).length,
      partnershipsTotal: partnerships.length,
      newPartnerships: partnerships.filter((p) => p.createdAt >= start && p.createdAt < end).length,
      perkRedemptions: redemptions?.count ?? 0,
      obligationVolume: round2(flows.reduce((s, f) => s + num(f.total), 0)),
      unsettledBalance: round2(num(unsettled?.total)),
      flowsByKind: flows.map((f) => ({ kind: f.kind, total: round2(num(f.total)), count: f.count })),
    }),
  );
});

// ── Serialization helpers ────────────────────────────────────────────────────

async function tenantNameMap(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(inArray(tenantsTable.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.brandName]));
}

const nameOf = (names: Map<number, string>, id: number) => names.get(id) ?? `Business #${id}`;

function serializeEntry(e: CoopObligationLedgerEntry, names: Map<number, string>) {
  return {
    id: e.id,
    debtorTenantId: e.debtorTenantId,
    debtorTenantName: nameOf(names, e.debtorTenantId),
    creditorTenantId: e.creditorTenantId,
    creditorTenantName: nameOf(names, e.creditorTenantId),
    kind: e.kind,
    amount: num(e.amount),
    sourceRef: e.sourceRef,
    partnershipId: e.partnershipId,
    description: e.description,
    occurredAt: e.occurredAt.toISOString(),
    settlementCycleId: e.settlementCycleId,
  };
}

function serializeCycle(c: CoopSettlementCycle) {
  return {
    id: c.id,
    periodStart: c.periodStart.toISOString(),
    periodEnd: c.periodEnd.toISOString(),
    status: c.status,
    entryCount: c.entryCount,
    grossVolume: num(c.grossVolume),
    executedAt: c.executedAt.toISOString(),
  };
}

function serializeStatementRow(s: CoopSettlementStatement, names: Map<number, string>) {
  return {
    tenantId: s.tenantId,
    tenantName: nameOf(names, s.tenantId),
    totalOwedToOthers: num(s.totalOwedToOthers),
    totalOwedByOthers: num(s.totalOwedByOthers),
    netAmount: num(s.netAmount),
    lines: s.lines,
  };
}

function serializeNetted(s: NettedStatement, names: Map<number, string>) {
  return {
    tenantId: s.tenantId,
    tenantName: nameOf(names, s.tenantId),
    totalOwedToOthers: round2(s.totalOwedToOthers),
    totalOwedByOthers: round2(s.totalOwedByOthers),
    netAmount: round2(s.netAmount),
    lines: s.lines,
  };
}

function parseWindow(startRaw: unknown, endRaw: unknown): { start: Date; end: Date } | null {
  if (typeof startRaw !== "string" || typeof endRaw !== "string") return null;
  const start = new Date(startRaw);
  const end = new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return null;
  return { start, end };
}

// ── Settlement preview ───────────────────────────────────────────────────────

router.get("/agency/settlement/preview", async (req, res): Promise<void> => {
  const window = parseWindow(req.query.periodStart, req.query.periodEnd);
  if (!window) {
    res.status(400).json({ message: "periodStart and periodEnd must be valid dates with periodStart < periodEnd" });
    return;
  }
  const preview = await previewSettlement(window.start, window.end);
  res.json(
    PreviewSettlementCycleResponse.parse({
      periodStart: window.start.toISOString(),
      periodEnd: window.end.toISOString(),
      entryCount: preview.entries.length,
      grossVolume: round2(preview.grossVolume),
      entries: preview.entries.map((e) => serializeEntry(e, preview.tenantNames)),
      statements: preview.statements.map((s) => serializeNetted(s, preview.tenantNames)),
    }),
  );
});

// ── Settlement execution ─────────────────────────────────────────────────────

router.post("/agency/settlement/run", async (req, res): Promise<void> => {
  const parsed = RunSettlementBody.safeParse(req.body);
  const window = parsed.success ? parseWindow(parsed.data.periodStart, parsed.data.periodEnd) : null;
  if (!window) {
    res.status(400).json({ message: "periodStart and periodEnd must be valid dates with periodStart < periodEnd" });
    return;
  }
  const result = await runSettlementCycle(window.start, window.end);
  if (!result.ok) {
    if (result.reason === "concurrent") {
      res.status(409).json({ message: "Another settlement run is already in progress. Try again shortly." });
    } else {
      res.status(400).json({ message: "No unsettled obligations in this window — nothing to settle." });
    }
    return;
  }
  const names = await tenantNameMap(result.statements.map((s) => s.tenantId));
  res.status(201).json(
    RunSettlementResponse.parse({
      cycle: serializeCycle(result.cycle),
      statements: result.statements.map((s) => serializeStatementRow(s, names)),
    }),
  );
});

// ── Cycle history ────────────────────────────────────────────────────────────

router.get("/agency/settlement/cycles", async (_req, res): Promise<void> => {
  const cycles = await db
    .select()
    .from(coopSettlementCyclesTable)
    .orderBy(desc(coopSettlementCyclesTable.executedAt), desc(coopSettlementCyclesTable.id));
  res.json(ListSettlementCyclesResponse.parse(cycles.map(serializeCycle)));
});

router.get("/agency/settlement/cycles/:cycleId", async (req, res): Promise<void> => {
  const cycleId = Number(req.params.cycleId);
  const [cycle] = await db
    .select()
    .from(coopSettlementCyclesTable)
    .where(eq(coopSettlementCyclesTable.id, cycleId));
  if (!cycle) {
    res.status(404).json({ message: "Settlement cycle not found" });
    return;
  }
  const statements = await db
    .select()
    .from(coopSettlementStatementsTable)
    .where(eq(coopSettlementStatementsTable.cycleId, cycle.id))
    .orderBy(coopSettlementStatementsTable.tenantId);
  const names = await tenantNameMap(statements.map((s) => s.tenantId));
  res.json(
    GetSettlementCycleResponse.parse({
      cycle: serializeCycle(cycle),
      statements: statements.map((s) => serializeStatementRow(s, names)),
    }),
  );
});

router.get(
  "/agency/settlement/cycles/:cycleId/statements/:tenantId",
  async (req, res): Promise<void> => {
    const cycleId = Number(req.params.cycleId);
    const tenantId = Number(req.params.tenantId);
    const [cycle] = await db
      .select()
      .from(coopSettlementCyclesTable)
      .where(eq(coopSettlementCyclesTable.id, cycleId));
    const [statement] = cycle
      ? await db
          .select()
          .from(coopSettlementStatementsTable)
          .where(
            and(
              eq(coopSettlementStatementsTable.cycleId, cycleId),
              eq(coopSettlementStatementsTable.tenantId, tenantId),
            ),
          )
      : [];
    if (!cycle || !statement) {
      res.status(404).json({ message: "Settlement statement not found" });
      return;
    }
    const entries = await entriesForCycleTenant(cycleId, tenantId);
    const names = await tenantNameMap([
      tenantId,
      ...entries.flatMap((e) => [e.debtorTenantId, e.creditorTenantId]),
    ]);
    res.json(
      GetSettlementStatementResponse.parse({
        cycle: serializeCycle(cycle),
        statement: serializeStatementRow(statement, names),
        entries: entries.map((e) => serializeEntry(e, names)),
      }),
    );
  },
);

export default router;
