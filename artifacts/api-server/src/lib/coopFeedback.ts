import {
  db,
  coopFeedbackTable,
  coopPerkRedemptionsTable,
  coopSentimentReportsTable,
  merchantCoopPartnershipsTable,
  perkPassesTable,
  tenantsTable,
  type CoopFeedback,
  type CoopSentimentRankingRow,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { sendMessageSafe } from "./messaging";
import { normalizeToE164 } from "./sms";
import { analyzeFeedbackSentiment } from "./coopSentiment";
import { logger } from "./logger";

// ── Co-op post-redemption feedback & sentiment analytics ────────────────────
// After a co-op perk redemption we text the customer (existing messaging
// pipeline) for a quick 1-5 rating, a Y/N "would you recommend", and optional
// comments. Replies are parsed deterministically, run through sentiment
// analysis at ingestion time, and stored tied to the redemption and
// partnership. Aggregates and periodic insight reports are tenant-scoped to
// accepted partnerships the merchant participates in — raw customer
// identities never cross tenants.

/** Replies older than this no longer match an open feedback request. */
export const FEEDBACK_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface RequestCoopFeedbackArgs {
  partnershipId: number;
  redemptionId: number;
  /** Business the perk was redeemed AT (the business being rated). */
  redeemedByTenantId: number;
  customerPhone: string | null | undefined;
  customerName?: string | null;
  perkTitle: string;
  businessName?: string | null;
}

/**
 * Record a feedback request for a counted redemption and send the follow-up
 * SMS through the existing messaging pipeline. Idempotent per redemption
 * (unique redemption_id) and best-effort: never throws, never blocks the
 * redemption flow. No-op when the customer's phone is unknown.
 */
export async function requestCoopFeedbackSafe(args: RequestCoopFeedbackArgs): Promise<void> {
  try {
    const phone = normalizeToE164(args.customerPhone) ?? args.customerPhone?.trim();
    if (!phone) return;
    const [inserted] = await db
      .insert(coopFeedbackTable)
      .values({
        partnershipId: args.partnershipId,
        redemptionId: args.redemptionId,
        tenantId: args.redeemedByTenantId,
        customerPhone: phone,
        customerName: args.customerName ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: coopFeedbackTable.id });
    // Only the insert that created the row sends the request — a replayed
    // redemption event can never double-text the customer.
    if (!inserted) return;

    const at = args.businessName?.trim() ? ` at ${args.businessName.trim()}` : "";
    await sendMessageSafe({
      tenantId: args.redeemedByTenantId,
      toNumber: phone,
      kind: "coop_feedback_request",
      body: `${args.customerName ? args.customerName + ", thanks" : "Thanks"} for redeeming "${args.perkTitle}"${at}! How was it? Reply with a rating 1-5, Y or N if you'd recommend us, and any comments — e.g. "5 Y loved it".`,
      context: { coopFeedbackId: inserted.id, partnershipId: args.partnershipId, redemptionId: args.redemptionId },
    });
  } catch (err) {
    logger.error({ err, redemptionId: args.redemptionId }, "requestCoopFeedbackSafe failed; redemption flow unaffected");
  }
}

export interface ParsedFeedbackReply {
  rating: number;
  wouldRecommend: boolean | null;
  text: string | null;
}

/**
 * Deterministically parse a feedback reply of the form
 * "<1-5> [Y|N] [comments...]". Returns null when the message doesn't start
 * with a standalone 1-5 rating — such messages are never treated as feedback
 * (so STOP/YES/etc. keep their existing meanings).
 */
export function parseFeedbackReply(body: string | null | undefined): ParsedFeedbackReply | null {
  if (!body) return null;
  const m = body.trim().match(/^([1-5])\b[\s,.:;-]*(?:\b(y|yes|n|no)\b[\s,.:;-]*)?([\s\S]*)$/i);
  if (!m) return null;
  const rating = Number(m[1]);
  const rec = m[2]?.toLowerCase();
  const text = m[3]?.trim() || null;
  return {
    rating,
    wouldRecommend: rec == null ? null : rec.startsWith("y"),
    text,
  };
}

/**
 * Try to consume an inbound SMS as a co-op feedback reply: matches the
 * sender's newest open ("requested") feedback request within the reply
 * window, parses the rating/recommend/comments, runs sentiment analysis at
 * ingestion time, and completes the row. Returns true when the message was
 * handled as feedback (callers should stop further keyword processing).
 */
export async function handleInboundCoopFeedback(
  fromNumber: string | null,
  body: string,
  now: Date = new Date(),
): Promise<boolean> {
  const phone = normalizeToE164(fromNumber) ?? fromNumber;
  if (!phone) return false;
  const parsed = parseFeedbackReply(body);
  if (!parsed) return false;

  const since = new Date(now.getTime() - FEEDBACK_REPLY_WINDOW_MS);
  const [open] = await db
    .select()
    .from(coopFeedbackTable)
    .where(
      and(
        eq(coopFeedbackTable.customerPhone, phone),
        eq(coopFeedbackTable.status, "requested"),
        gte(coopFeedbackTable.requestedAt, since),
      ),
    )
    .orderBy(desc(coopFeedbackTable.requestedAt), desc(coopFeedbackTable.id))
    .limit(1);
  if (!open) return false;

  const sentiment = parsed.text ? await analyzeFeedbackSentiment(parsed.text) : null;

  // Conditional update on status = requested: exactly one concurrent webhook
  // delivery completes the row.
  const [updated] = await db
    .update(coopFeedbackTable)
    .set({
      status: "completed",
      rating: parsed.rating,
      wouldRecommend: parsed.wouldRecommend,
      feedbackText: parsed.text,
      sentimentLabel: sentiment?.label ?? null,
      sentimentScore: sentiment ? sentiment.score.toFixed(3) : null,
      themes: sentiment?.themes ?? [],
      sentimentUsedAi: sentiment?.usedAi ?? false,
      respondedAt: now,
    })
    .where(and(eq(coopFeedbackTable.id, open.id), eq(coopFeedbackTable.status, "requested")))
    .returning({ id: coopFeedbackTable.id });
  if (updated) {
    logger.info(
      { coopFeedbackId: open.id, rating: parsed.rating, sentiment: sentiment?.label ?? null },
      "Recorded co-op feedback reply",
    );
  }
  return true;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/** NPS-style score from recommend answers: %yes − %no, in [-100, 100]. */
export function npsFrom(yes: number, no: number): number | null {
  const answered = yes + no;
  if (answered === 0) return null;
  return Math.round(((yes - no) / answered) * 100);
}

/** Accepted partnerships the tenant participates in (either side). */
async function acceptedPartnershipsOf(tenantId: number) {
  return db
    .select({
      id: merchantCoopPartnershipsTable.id,
      hostTenantId: merchantCoopPartnershipsTable.hostTenantId,
      partnerTenantId: merchantCoopPartnershipsTable.partnerTenantId,
      perkTitle: merchantCoopPartnershipsTable.perkTitle,
    })
    .from(merchantCoopPartnershipsTable)
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId),
        ),
      ),
    );
}

export interface PartnershipSentimentRow extends CoopSentimentRankingRow {
  partnerTenantId: number;
}

export interface SentimentSummary {
  totalResponses: number;
  networkAvgRating: number | null;
  networkNps: number | null;
  positive: number;
  neutral: number;
  negative: number;
  /** Recurring themes across the tenant's network, most frequent first. */
  praiseThemes: string[];
  frictionThemes: string[];
  partnerships: PartnershipSentimentRow[];
}

interface PeriodBounds {
  from?: Date;
  to?: Date;
}

/**
 * Completed feedback rows visible to a tenant: feedback on any accepted
 * partnership the tenant participates in (both sides see network aggregates
 * for their shared partnerships — never raw identities of the other side's
 * customers; identities are dropped before serialization).
 */
async function feedbackForPartnerships(partnershipIds: number[], bounds: PeriodBounds) {
  if (partnershipIds.length === 0) return [];
  const conds = [
    inArray(coopFeedbackTable.partnershipId, partnershipIds),
    eq(coopFeedbackTable.status, "completed"),
  ];
  if (bounds.from) conds.push(gte(coopFeedbackTable.respondedAt, bounds.from));
  if (bounds.to) conds.push(lt(coopFeedbackTable.respondedAt, bounds.to));
  return db
    .select()
    .from(coopFeedbackTable)
    .where(and(...conds));
}

/**
 * Repeat-visit rate per partnership, computed from redemption history per
 * customer pass: for redemptions whose pass resolves to a wallet customer
 * phone, the share of distinct customers with more than one redemption
 * across that partnership's history. Null when no customers resolved.
 */
async function repeatVisitRates(partnershipIds: number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  for (const id of partnershipIds) out.set(id, null);
  if (partnershipIds.length === 0) return out;
  const rows = await db
    .select({
      partnershipId: coopPerkRedemptionsTable.partnershipId,
      customers: sql<number>`count(distinct ${perkPassesTable.customerPhone})::int`,
      repeats: sql<number>`count(distinct ${perkPassesTable.customerPhone}) filter (where ${perkPassesTable.customerPhone} in (
        select p2.customer_phone from coop_perk_redemptions r2
        join perk_passes p2 on p2.token = r2.pass_code
        where r2.partnership_id = ${coopPerkRedemptionsTable.partnershipId}
        group by p2.customer_phone having count(*) > 1
      ))::int`,
    })
    .from(coopPerkRedemptionsTable)
    .innerJoin(perkPassesTable, eq(perkPassesTable.token, coopPerkRedemptionsTable.passCode))
    .where(inArray(coopPerkRedemptionsTable.partnershipId, partnershipIds))
    .groupBy(coopPerkRedemptionsTable.partnershipId);
  for (const r of rows) {
    out.set(r.partnershipId, r.customers > 0 ? Math.round((r.repeats / r.customers) * 100) / 100 : null);
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Cross-network sentiment summary for a tenant, restricted to accepted
 * partnerships they participate in. Optional bounds restrict by response
 * time (used for report periods).
 */
export async function sentimentSummaryForTenant(
  tenantId: number,
  bounds: PeriodBounds = {},
): Promise<SentimentSummary> {
  const partnerships = await acceptedPartnershipsOf(tenantId);
  const ids = partnerships.map((p) => p.id);
  const [rows, repeatRates] = await Promise.all([
    feedbackForPartnerships(ids, bounds),
    repeatVisitRates(ids),
  ]);

  const otherIds = [...new Set(partnerships.map((p) => (p.hostTenantId === tenantId ? p.partnerTenantId : p.hostTenantId)))];
  const names = otherIds.length
    ? await db
        .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
        .from(tenantsTable)
        .where(inArray(tenantsTable.id, otherIds))
    : [];
  const nameById = new Map(names.map((n) => [n.id, n.brandName]));

  const themeCounts = new Map<string, { praise: number; friction: number }>();
  let ratingSum = 0;
  let ratingCount = 0;
  let yes = 0;
  let no = 0;
  let positive = 0;
  let neutral = 0;
  let negative = 0;

  const byPartnership = new Map<number, CoopFeedback[]>();
  for (const f of rows) {
    const list = byPartnership.get(f.partnershipId) ?? [];
    list.push(f);
    byPartnership.set(f.partnershipId, list);
    if (f.rating != null) {
      ratingSum += f.rating;
      ratingCount++;
    }
    if (f.wouldRecommend === true) yes++;
    if (f.wouldRecommend === false) no++;
    if (f.sentimentLabel === "positive") positive++;
    else if (f.sentimentLabel === "negative") negative++;
    else if (f.sentimentLabel === "neutral") neutral++;
    for (const theme of f.themes ?? []) {
      const entry = themeCounts.get(theme) ?? { praise: 0, friction: 0 };
      if (f.sentimentLabel === "negative") entry.friction++;
      else entry.praise++;
      themeCounts.set(theme, entry);
    }
  }

  const partnershipRows: PartnershipSentimentRow[] = partnerships.map((p) => {
    const list = byPartnership.get(p.id) ?? [];
    const rated = list.filter((f) => f.rating != null);
    const pYes = list.filter((f) => f.wouldRecommend === true).length;
    const pNo = list.filter((f) => f.wouldRecommend === false).length;
    const partnerTenantId = p.hostTenantId === tenantId ? p.partnerTenantId : p.hostTenantId;
    return {
      partnershipId: p.id,
      partnerTenantId,
      partnerName: nameById.get(partnerTenantId) ?? "Unknown business",
      perkTitle: p.perkTitle,
      responses: list.length,
      avgRating: rated.length ? round1(rated.reduce((s, f) => s + f.rating!, 0) / rated.length) : null,
      nps: npsFrom(pYes, pNo),
      repeatVisitRate: repeatRates.get(p.id) ?? null,
      positive: list.filter((f) => f.sentimentLabel === "positive").length,
      neutral: list.filter((f) => f.sentimentLabel === "neutral").length,
      negative: list.filter((f) => f.sentimentLabel === "negative").length,
    };
  });

  const sortedThemes = [...themeCounts.entries()];
  const praiseThemes = sortedThemes
    .filter(([, c]) => c.praise > 0 && c.praise >= c.friction)
    .sort((a, b) => b[1].praise - a[1].praise)
    .map(([t]) => t)
    .slice(0, 5);
  const frictionThemes = sortedThemes
    .filter(([, c]) => c.friction > 0)
    .sort((a, b) => b[1].friction - a[1].friction)
    .map(([t]) => t)
    .slice(0, 5);

  return {
    totalResponses: rows.length,
    networkAvgRating: ratingCount ? round1(ratingSum / ratingCount) : null,
    networkNps: npsFrom(yes, no),
    positive,
    neutral,
    negative,
    praiseThemes,
    frictionThemes,
    partnerships: partnershipRows,
  };
}

// ── Periodic insight reports ─────────────────────────────────────────────────

/** ISO week key "YYYY-Www" of the week containing `d` (UTC, Monday-based). */
export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** [start, end) UTC bounds of the ISO week containing `d`. */
export function isoWeekBounds(d: Date): { start: Date; end: Date } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  const start = new Date(date);
  start.setUTCDate(date.getUTCDate() - (day - 1));
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { start, end };
}

/** Prior ISO week (the week before the one containing `now`). */
export function priorWeek(now: Date): { key: string; start: Date; end: Date } {
  const { start } = isoWeekBounds(now);
  const prevMid = new Date(start.getTime() - 3.5 * 24 * 60 * 60 * 1000);
  const bounds = isoWeekBounds(prevMid);
  return { key: isoWeekKey(prevMid), start: bounds.start, end: bounds.end };
}

/** Prior calendar month of `now` (UTC): key "YYYY-MM" and [start, end). */
export function priorMonth(now: Date): { key: string; start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`, start, end };
}

function periodLabel(periodType: string, periodKey: string): string {
  if (periodType === "monthly") {
    return new Date(`${periodKey}-01T00:00:00Z`).toLocaleString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return `week ${periodKey}`;
}

/** Plain-language recommendation text for a report's ranked partnerships. */
export function buildReportSummary(
  periodType: string,
  periodKey: string,
  rankings: CoopSentimentRankingRow[],
): string {
  const label = periodLabel(periodType, periodKey);
  const responded = rankings.filter((r) => r.responses > 0);
  if (responded.length === 0) {
    return `No customer feedback was collected across your co-op network in ${label}. Encourage partners to keep perks active — feedback requests go out automatically after each redemption.`;
  }
  const parts: string[] = [];
  const top = responded[0];
  parts.push(
    `In ${label}, your strongest pairing was with ${top.partnerName} ("${top.perkTitle}"): ${top.responses} response${top.responses === 1 ? "" : "s"}${top.avgRating != null ? `, averaging ${top.avgRating}/5` : ""}${top.nps != null ? ` with an NPS of ${top.nps}` : ""}${top.repeatVisitRate != null ? ` and a ${Math.round(top.repeatVisitRate * 100)}% repeat-visit rate` : ""}. Keep investing in this pairing — it drives your strongest retention and sentiment.`,
  );
  const struggling = [...responded]
    .reverse()
    .find((r) => r !== top && ((r.avgRating != null && r.avgRating < 3.5) || (r.nps != null && r.nps < 0) || r.negative > r.positive));
  if (struggling) {
    parts.push(
      `Your pairing with ${struggling.partnerName} is underperforming${strugglingDetail(struggling)} — consider refreshing the perk terms or checking in with the partner.`,
    );
  }
  const totalResponses = responded.reduce((s, r) => s + r.responses, 0);
  parts.push(`${totalResponses} customer${totalResponses === 1 ? "" : "s"} shared feedback across ${responded.length} partnership${responded.length === 1 ? "" : "s"}.`);
  return parts.join(" ");
}

function strugglingDetail(r: CoopSentimentRankingRow): string {
  if (r.avgRating != null && r.avgRating < 3.5) return ` (average rating ${r.avgRating}/5)`;
  if (r.nps != null && r.nps < 0) return ` (NPS ${r.nps})`;
  return " (more negative than positive comments)";
}

/** Sort key: satisfaction first (rating, then NPS, then repeat rate). */
function rankRows(rows: PartnershipSentimentRow[]): CoopSentimentRankingRow[] {
  return [...rows]
    .sort((a, b) => {
      if (b.responses === 0 !== (a.responses === 0)) return a.responses === 0 ? 1 : -1;
      const ar = a.avgRating ?? -1;
      const br = b.avgRating ?? -1;
      if (br !== ar) return br - ar;
      const an = a.nps ?? -101;
      const bn = b.nps ?? -101;
      if (bn !== an) return bn - an;
      return (b.repeatVisitRate ?? -1) - (a.repeatVisitRate ?? -1);
    })
    .map(({ partnerTenantId: _drop, ...row }) => row);
}

export interface SentimentReportRunResult {
  created: number;
}

/**
 * Generate weekly and monthly co-op sentiment insight reports for every
 * tenant that participates in an accepted partnership, for the prior ISO
 * week and prior calendar month. Idempotent per (tenant, periodType,
 * periodKey) via the unique constraint + onConflictDoNothing — safe on every
 * worker tick. Reports are only generated when the tenant's network recorded
 * at least one completed feedback in the period (no empty-report spam).
 */
export async function generateCoopSentimentReports(now: Date = new Date()): Promise<SentimentReportRunResult> {
  const periods = [
    { periodType: "weekly", ...priorWeek(now) },
    { periodType: "monthly", ...priorMonth(now) },
  ];

  const partRows = await db
    .select({
      hostTenantId: merchantCoopPartnershipsTable.hostTenantId,
      partnerTenantId: merchantCoopPartnershipsTable.partnerTenantId,
    })
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.status, "accepted"));
  const tenantIds = new Set<number>();
  for (const r of partRows) {
    tenantIds.add(r.hostTenantId);
    tenantIds.add(r.partnerTenantId);
  }
  if (tenantIds.size === 0) return { created: 0 };

  let created = 0;
  for (const period of periods) {
    // Fast path: skip tenants that already have this period's report.
    const existing = await db
      .select({ tenantId: coopSentimentReportsTable.tenantId })
      .from(coopSentimentReportsTable)
      .where(
        and(
          eq(coopSentimentReportsTable.periodType, period.periodType),
          eq(coopSentimentReportsTable.periodKey, period.key),
          inArray(coopSentimentReportsTable.tenantId, [...tenantIds]),
        ),
      );
    const done = new Set(existing.map((r) => r.tenantId));

    for (const tenantId of tenantIds) {
      if (done.has(tenantId)) continue;
      const summary = await sentimentSummaryForTenant(tenantId, {
        from: period.start,
        to: period.end,
      });
      if (summary.totalResponses === 0) continue;
      const rankings = rankRows(summary.partnerships);
      try {
        const [inserted] = await db
          .insert(coopSentimentReportsTable)
          .values({
            tenantId,
            periodType: period.periodType,
            periodKey: period.key,
            rankings,
            summary: buildReportSummary(period.periodType, period.key, rankings),
          })
          .onConflictDoNothing()
          .returning({ id: coopSentimentReportsTable.id });
        if (inserted) created++;
      } catch (err) {
        const pgCode =
          (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
        if (pgCode === "23503") continue; // tenant deleted mid-run
        throw err;
      }
    }
  }
  if (created > 0) {
    logger.info({ created }, "Generated co-op sentiment insight reports");
  }
  return { created };
}
