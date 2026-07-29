import { Router, type Request, type IRouter } from "express";
import { randomUUID } from "crypto";
import {
  db,
  coopTaxSettingsTable,
  coopComplianceLedgerTable,
  coopPartnerPayoutsTable,
  tenantsTable,
  sosVisitsTable,
  sosCustomersTable,
  sosPlanTransactionsTable,
  type CoopComplianceLedgerEntry,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, isNull, isNotNull, lt } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  GetCoopComplianceSettingsResponse,
  UpdateCoopComplianceSettingsBody,
  UpdateCoopComplianceSettingsResponse,
  ListCoopComplianceLedgerResponse,
  ListCoopComplianceLedgerQueryParams,
  CreateCoopComplianceEntryBody,
  CreateCoopComplianceEntryResponse,
  GetCoopComplianceSummaryResponse,
  ListCoopPartnerPayoutsResponse,
} from "@workspace/api-zod";
import {
  getCoopTaxSettings,
  recordCoopComplianceEventsSafe,
  parseCompliancePeriod,
  payoutPayeeKey,
  COOP_COMPLIANCE_CATEGORIES,
  type CoopComplianceCategory,
} from "../lib/coopCompliance";

/**
 * Co-Op Automated Tax & Revenue Compliance Ledger — merchant-facing routes.
 * Tenant scope comes from the x-tenant-id header (validated upstream by the
 * tenant-access middleware, same as the other /coop routes). All tax figures
 * are merchant-configured ESTIMATES — the UI carries the "consult your
 * accountant" disclaimer, and exports are files only (no filing APIs).
 */

const router: IRouter = Router();

const DISCLAIMER =
  "All tax figures are estimates computed from your configured rates — not tax advice. Consult your accountant before filing.";

/** Tenant scope from the x-tenant-id header (same convention as /api/sos). */
function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const num = (v: string | null | undefined): number => (v == null ? 0 : parseFloat(v));
const round2 = (n: number): number => Math.round(n * 100) / 100;

function tenantScope(col: AnyPgColumn, tenantId: number | null) {
  return tenantId == null ? isNull(col) : eq(col, tenantId);
}

function serializeSettings(s: {
  stateRatePercent: string;
  localRatePercent: string;
  salesRatePercent: string;
  threshold1099: string;
  updatedAt: Date;
}) {
  return {
    stateRatePercent: num(s.stateRatePercent),
    localRatePercent: num(s.localRatePercent),
    salesRatePercent: num(s.salesRatePercent),
    threshold1099: num(s.threshold1099),
    updatedAt: s.updatedAt.toISOString(),
  };
}

async function serializeEntries(rows: CoopComplianceLedgerEntry[]) {
  const counterpartIds = [
    ...new Set(rows.map((r) => r.counterpartTenantId).filter((id): id is number => id != null)),
  ];
  const names = new Map<number, string>();
  if (counterpartIds.length > 0) {
    const tenants = await db
      .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
      .from(tenantsTable)
      .where(inArray(tenantsTable.id, counterpartIds));
    for (const t of tenants) names.set(t.id, t.brandName);
  }
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    direction: r.direction,
    counterpartTenantId: r.counterpartTenantId,
    counterpartTenantName:
      r.counterpartTenantId != null ? (names.get(r.counterpartTenantId) ?? null) : null,
    payeeName: r.payeeName,
    description: r.description,
    grossAmount: num(r.grossAmount),
    stateRatePercent: num(r.stateRatePercent),
    localRatePercent: num(r.localRatePercent),
    salesRatePercent: num(r.salesRatePercent),
    estimatedTaxAmount: num(r.estimatedTaxAmount),
    sourceRef: r.sourceRef,
    occurredAt: r.occurredAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));
}

// ── GET /coop/compliance/settings ────────────────────────────────────────────
router.get("/coop/compliance/settings", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const settings = await getCoopTaxSettings(tenantId);
  res.json(GetCoopComplianceSettingsResponse.parse(serializeSettings(settings)));
});

// ── PATCH /coop/compliance/settings ──────────────────────────────────────────
// Rate changes only affect entries going forward — existing ledger rows keep
// their rate snapshot.
router.patch("/coop/compliance/settings", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = UpdateCoopComplianceSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  await getCoopTaxSettings(tenantId); // ensure the row exists
  const updates: Partial<typeof coopTaxSettingsTable.$inferInsert> = { updatedAt: new Date() };
  if (parsed.data.stateRatePercent !== undefined)
    updates.stateRatePercent = parsed.data.stateRatePercent.toFixed(2);
  if (parsed.data.localRatePercent !== undefined)
    updates.localRatePercent = parsed.data.localRatePercent.toFixed(2);
  if (parsed.data.salesRatePercent !== undefined)
    updates.salesRatePercent = parsed.data.salesRatePercent.toFixed(2);
  if (parsed.data.threshold1099 !== undefined)
    updates.threshold1099 = parsed.data.threshold1099.toFixed(2);
  const [updated] = await db
    .update(coopTaxSettingsTable)
    .set(updates)
    .where(eq(coopTaxSettingsTable.tenantId, tenantId))
    .returning();
  res.json(UpdateCoopComplianceSettingsResponse.parse(serializeSettings(updated)));
});

// ── GET /coop/compliance/ledger?period= ──────────────────────────────────────
router.get("/coop/compliance/ledger", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const query = ListCoopComplianceLedgerQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ message: "Invalid query", errors: query.error.flatten() });
    return;
  }
  const period = parseCompliancePeriod(query.data.period);
  if (!period) {
    res.status(400).json({ message: "Invalid period: use YYYY, YYYY-MM, or YYYY-Qn" });
    return;
  }
  const rows = await db
    .select()
    .from(coopComplianceLedgerTable)
    .where(
      and(
        tenantScope(coopComplianceLedgerTable.tenantId, tenantId),
        gte(coopComplianceLedgerTable.occurredAt, period.from),
        lt(coopComplianceLedgerTable.occurredAt, period.to),
      ),
    )
    .orderBy(desc(coopComplianceLedgerTable.occurredAt), desc(coopComplianceLedgerTable.id))
    .limit(query.data.limit ?? 100)
    .offset(query.data.offset ?? 0);
  res.json(ListCoopComplianceLedgerResponse.parse(await serializeEntries(rows)));
});

// ── POST /coop/compliance/entries — manual entry ─────────────────────────────
// Sponsorships, shared event expenses, and referral commissions that don't
// flow through an automated pipeline yet are logged here.
router.post("/coop/compliance/entries", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateCoopComplianceEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const occurredAt = parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    res.status(400).json({ message: "Invalid occurredAt" });
    return;
  }
  if (parsed.data.counterpartTenantId != null) {
    const [t] = await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, parsed.data.counterpartTenantId));
    if (!t) {
      res.status(400).json({ message: "Counterpart tenant not found" });
      return;
    }
  }
  const [created] = await recordCoopComplianceEventsSafe([
    {
      tenantId,
      category: parsed.data.category as CoopComplianceCategory,
      direction: parsed.data.direction as "income" | "expense",
      counterpartTenantId: parsed.data.counterpartTenantId ?? null,
      payeeName: parsed.data.payeeName ?? null,
      description: parsed.data.description,
      grossAmount: parsed.data.grossAmount,
      sourceRef: `manual:${randomUUID()}`,
      occurredAt,
    },
  ]);
  if (!created) {
    res.status(500).json({ message: "Failed to record ledger entry" });
    return;
  }
  res.status(201).json(CreateCoopComplianceEntryResponse.parse((await serializeEntries([created]))[0]));
});

// ── period aggregation helpers ───────────────────────────────────────────────

interface SectionAgg {
  grossIncome: number;
  grossExpense: number;
  estimatedTax: number;
  entryCount: number;
}

async function ledgerRowsForPeriod(tenantId: number | null, from: Date, to: Date) {
  return db
    .select()
    .from(coopComplianceLedgerTable)
    .where(
      and(
        tenantScope(coopComplianceLedgerTable.tenantId, tenantId),
        gte(coopComplianceLedgerTable.occurredAt, from),
        lt(coopComplianceLedgerTable.occurredAt, to),
      ),
    );
}

/**
 * Direct service revenue (visit checkouts + plan purchases/renewals) for the
 * period, with estimated tax at the tenant's CURRENT rates (there is no
 * historical rate snapshot for non-ledgered revenue — it is an estimate).
 */
async function directRevenueForPeriod(
  tenantId: number | null,
  from: Date,
  to: Date,
): Promise<{ gross: number; count: number }> {
  const visits = await db
    .select({ amount: sosVisitsTable.paymentAmount })
    .from(sosVisitsTable)
    .where(
      and(
        tenantScope(sosVisitsTable.tenantId, tenantId),
        isNotNull(sosVisitsTable.paymentAmount),
        isNotNull(sosVisitsTable.checkedOutAt),
        gte(sosVisitsTable.checkedOutAt, from),
        lt(sosVisitsTable.checkedOutAt, to),
      ),
    );
  const planTx = await db
    .select({ amount: sosPlanTransactionsTable.amount })
    .from(sosPlanTransactionsTable)
    .innerJoin(sosCustomersTable, eq(sosPlanTransactionsTable.customerId, sosCustomersTable.id))
    .where(
      and(
        tenantScope(sosCustomersTable.tenantId, tenantId),
        inArray(sosPlanTransactionsTable.transactionType, ["purchase", "renewal"]),
        isNotNull(sosPlanTransactionsTable.amount),
        gte(sosPlanTransactionsTable.createdAt, from),
        lt(sosPlanTransactionsTable.createdAt, to),
      ),
    );
  let gross = 0;
  let count = 0;
  for (const v of visits) {
    if (v.amount != null) {
      gross += num(v.amount);
      count++;
    }
  }
  for (const t of planTx) {
    if (t.amount != null) {
      gross += num(t.amount);
      count++;
    }
  }
  return { gross: round2(gross), count };
}

const SECTION_LABELS: Record<string, string> = {
  direct_revenue: "Direct service revenue",
  perk_redemption: "Co-op perk redemptions",
  referral_commission: "Cross-network referral commissions",
  sponsorship: "Sponsorship income/expense",
  shared_expense: "Shared event expenses",
};

// ── GET /coop/compliance/summary?period= ─────────────────────────────────────
router.get("/coop/compliance/summary", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const period = parseCompliancePeriod(
    typeof req.query.period === "string" ? req.query.period : undefined,
  );
  if (!period) {
    res.status(400).json({ message: "Invalid period: use YYYY, YYYY-MM, or YYYY-Qn" });
    return;
  }

  const [rows, direct, settings] = await Promise.all([
    ledgerRowsForPeriod(tenantId, period.from, period.to),
    directRevenueForPeriod(tenantId, period.from, period.to),
    getCoopTaxSettings(tenantId),
  ]);

  const byCategory = new Map<string, SectionAgg>();
  for (const cat of COOP_COMPLIANCE_CATEGORIES) {
    byCategory.set(cat, { grossIncome: 0, grossExpense: 0, estimatedTax: 0, entryCount: 0 });
  }
  for (const r of rows) {
    const agg = byCategory.get(r.category);
    if (!agg) continue;
    const gross = num(r.grossAmount);
    if (r.direction === "income") agg.grossIncome += gross;
    else agg.grossExpense += gross;
    // Estimated tax accrues on the income side; expense entries carry their
    // snapshot for audit but don't add tax due.
    if (r.direction === "income") agg.estimatedTax += num(r.estimatedTaxAmount);
    agg.entryCount++;
  }

  const currentRate =
    num(settings.stateRatePercent) + num(settings.localRatePercent) + num(settings.salesRatePercent);
  const directTax = round2((direct.gross * currentRate) / 100);

  const sections = [
    {
      key: "direct_revenue",
      label: SECTION_LABELS.direct_revenue,
      grossIncome: direct.gross,
      grossExpense: 0,
      net: direct.gross,
      estimatedTax: directTax,
      entryCount: direct.count,
    },
    ...COOP_COMPLIANCE_CATEGORIES.map((cat) => {
      const agg = byCategory.get(cat)!;
      return {
        key: cat,
        label: SECTION_LABELS[cat],
        grossIncome: round2(agg.grossIncome),
        grossExpense: round2(agg.grossExpense),
        net: round2(agg.grossIncome - agg.grossExpense),
        estimatedTax: round2(agg.estimatedTax),
        entryCount: agg.entryCount,
      };
    }),
  ];

  res.json(
    GetCoopComplianceSummaryResponse.parse({
      period: period.label,
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      sections,
      totalEstimatedTax: round2(sections.reduce((s, x) => s + x.estimatedTax, 0)),
      disclaimer: DISCLAIMER,
    }),
  );
});

// ── GET /coop/compliance/payouts?year= ───────────────────────────────────────
router.get("/coop/compliance/payouts", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const year = Number(req.query.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    res.status(400).json({ message: "Invalid year" });
    return;
  }
  const settings = await getCoopTaxSettings(tenantId);
  const threshold = num(settings.threshold1099);
  const rows = await db
    .select()
    .from(coopPartnerPayoutsTable)
    .where(
      and(
        tenantScope(coopPartnerPayoutsTable.tenantId, tenantId),
        eq(coopPartnerPayoutsTable.calendarYear, year),
      ),
    );
  const payouts = rows
    .map((r) => {
      const total = num(r.totalPaid);
      const crossed = total >= threshold;
      const counterpartTenantId = r.payeeKey.startsWith("tenant:")
        ? Number(r.payeeKey.slice("tenant:".length))
        : null;
      const missingFields: string[] = [];
      if (!r.payeeName || r.payeeName === "Unknown payee") missingFields.push("payeeName");
      if (counterpartTenantId == null && r.payeeKey.startsWith("name:")) {
        missingFields.push("taxIdOnFile");
      }
      return {
        payeeKey: r.payeeKey,
        payeeName: r.payeeName,
        counterpartTenantId,
        calendarYear: r.calendarYear,
        totalPaid: total,
        threshold1099: threshold,
        thresholdCrossed: crossed,
        remainingBeforeThreshold: crossed ? 0 : round2(threshold - total),
        form1099Ready: crossed && missingFields.length === 0,
        missingFields,
      };
    })
    .sort((a, b) => b.totalPaid - a.totalPaid);
  res.json(ListCoopPartnerPayoutsResponse.parse({ year, threshold1099: threshold, payouts }));
});

// ── CSV export ───────────────────────────────────────────────────────────────

function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

type Serialized = Awaited<ReturnType<typeof serializeEntries>>[number];

/** QuickBooks general-journal CSV layout (importable via journal entry CSV). */
function quickbooksLedgerCsv(rows: Serialized[]): string[] {
  const lines = ["JournalNo,JournalDate,Memo,AccountName,Debits,Credits,Name"];
  rows.forEach((r, i) => {
    const date = r.occurredAt.slice(0, 10);
    const memo = csvEscape(r.description ?? r.category);
    const name = csvEscape(r.counterpartTenantName ?? r.payeeName ?? "");
    const account = csvEscape(SECTION_LABELS[r.category] ?? r.category);
    const amount = r.grossAmount.toFixed(2);
    if (r.direction === "income") {
      lines.push(`${i + 1},${date},${memo},${account},,${amount},${name}`);
      lines.push(`${i + 1},${date},${memo},Undeposited Funds,${amount},,${name}`);
    } else {
      lines.push(`${i + 1},${date},${memo},${account},${amount},,${name}`);
      lines.push(`${i + 1},${date},${memo},Accounts Payable,,${amount},${name}`);
    }
  });
  return lines;
}

/** Xero bank-statement CSV layout (Date, Amount, Payee, Description, Reference). */
function xeroLedgerCsv(rows: Serialized[]): string[] {
  const lines = ["Date,Amount,Payee,Description,Reference"];
  for (const r of rows) {
    const signed = (r.direction === "income" ? r.grossAmount : -r.grossAmount).toFixed(2);
    lines.push(
      [
        r.occurredAt.slice(0, 10),
        signed,
        csvEscape(r.counterpartTenantName ?? r.payeeName ?? ""),
        csvEscape(r.description ?? r.category),
        csvEscape(r.sourceRef),
      ].join(","),
    );
  }
  return lines;
}

/** Plain audit CSV — every column, including the immutable rate snapshot. */
function auditLedgerCsv(rows: Serialized[]): string[] {
  const lines = [
    "Entry ID,Category,Direction,Counterpart,Payee,Description,Gross Amount,State Rate %,Local Rate %,Sales Rate %,Estimated Tax,Source Reference,Occurred At,Recorded At",
  ];
  for (const r of rows) {
    lines.push(
      [
        String(r.id),
        r.category,
        r.direction,
        csvEscape(r.counterpartTenantName ?? ""),
        csvEscape(r.payeeName ?? ""),
        csvEscape(r.description ?? ""),
        r.grossAmount.toFixed(2),
        r.stateRatePercent.toFixed(2),
        r.localRatePercent.toFixed(2),
        r.salesRatePercent.toFixed(2),
        r.estimatedTaxAmount.toFixed(2),
        csvEscape(r.sourceRef),
        r.occurredAt,
        r.createdAt,
      ].join(","),
    );
  }
  return lines;
}

interface PayoutRow {
  payeeName: string;
  payeeKey: string;
  totalPaid: number;
  threshold: number;
  crossed: boolean;
  year: number;
}

function payoutsCsv(rows: PayoutRow[], layout: string): string[] {
  if (layout === "xero") {
    const lines = ["Date,Amount,Payee,Description,Reference"];
    for (const r of rows) {
      lines.push(
        [
          `${r.year}-12-31`,
          (-r.totalPaid).toFixed(2),
          csvEscape(r.payeeName),
          csvEscape(`Calendar-year ${r.year} co-op payouts total`),
          csvEscape(`1099:${r.payeeKey}:${r.year}`),
        ].join(","),
      );
    }
    return lines;
  }
  if (layout === "quickbooks") {
    const lines = ["Vendor,TaxYear,TotalPayments,1099Threshold,Meets1099Threshold"];
    for (const r of rows) {
      lines.push(
        [
          csvEscape(r.payeeName),
          String(r.year),
          r.totalPaid.toFixed(2),
          r.threshold.toFixed(2),
          r.crossed ? "Yes" : "No",
        ].join(","),
      );
    }
    return lines;
  }
  const lines = ["Payee,Payee Key,Calendar Year,Total Paid,1099 Threshold,Threshold Crossed"];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.payeeName),
        csvEscape(r.payeeKey),
        String(r.year),
        r.totalPaid.toFixed(2),
        r.threshold.toFixed(2),
        r.crossed ? "Yes" : "No",
      ].join(","),
    );
  }
  return lines;
}

// ── GET /coop/compliance/export?period=&layout=&dataset= ─────────────────────
router.get("/coop/compliance/export", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const period = parseCompliancePeriod(
    typeof req.query.period === "string" ? req.query.period : undefined,
  );
  if (!period) {
    res.status(400).json({ message: "Invalid period: use YYYY, YYYY-MM, or YYYY-Qn" });
    return;
  }
  const layout = typeof req.query.layout === "string" ? req.query.layout : "";
  if (!["quickbooks", "xero", "audit"].includes(layout)) {
    res.status(400).json({ message: "Invalid layout: use quickbooks, xero, or audit" });
    return;
  }
  const dataset = typeof req.query.dataset === "string" ? req.query.dataset : "ledger";
  if (!["ledger", "payouts"].includes(dataset)) {
    res.status(400).json({ message: "Invalid dataset: use ledger or payouts" });
    return;
  }

  let lines: string[];
  if (dataset === "ledger") {
    const rows = await serializeEntries(
      (await ledgerRowsForPeriod(tenantId, period.from, period.to)).sort(
        (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
      ),
    );
    lines =
      layout === "quickbooks"
        ? quickbooksLedgerCsv(rows)
        : layout === "xero"
          ? xeroLedgerCsv(rows)
          : auditLedgerCsv(rows);
  } else {
    const year = period.from.getUTCFullYear();
    const settings = await getCoopTaxSettings(tenantId);
    const threshold = num(settings.threshold1099);
    const rows = await db
      .select()
      .from(coopPartnerPayoutsTable)
      .where(
        and(
          tenantScope(coopPartnerPayoutsTable.tenantId, tenantId),
          eq(coopPartnerPayoutsTable.calendarYear, year),
        ),
      );
    lines = payoutsCsv(
      rows
        .map((r) => ({
          payeeName: r.payeeName,
          payeeKey: r.payeeKey,
          totalPaid: num(r.totalPaid),
          threshold,
          crossed: num(r.totalPaid) >= threshold,
          year,
        }))
        .sort((a, b) => b.totalPaid - a.totalPaid),
      layout,
    );
  }

  res
    .status(200)
    .setHeader("Content-Type", "text/csv; charset=utf-8")
    .setHeader(
      "Content-Disposition",
      `attachment; filename="coop-${dataset}-${layout}-${period.label}.csv"`,
    )
    .send(lines.join("\r\n") + "\r\n");
});

export { payoutPayeeKey };
export default router;
