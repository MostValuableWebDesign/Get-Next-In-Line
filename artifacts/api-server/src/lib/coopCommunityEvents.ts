import { randomBytes } from "crypto";
import {
  db,
  tenantsTable,
  sosCustomersTable,
  coopCommunityEventsTable,
  coopCommunityEventParticipantsTable,
  coopCommunityEventExpensesTable,
  coopCommunityEventCheckinsTable,
  type CoopCommunityEvent,
  type CoopCommunityEventParticipant,
  type CoopCommunityEventExpense,
} from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";
import { sendMessageSafe } from "./messaging";
import { normalizeToE164 } from "./sms";
import { logger } from "./logger";

// ── Co-op community events & sponsorship sync ────────────────────────────────
// Shared logic for the /coop/events routes: event serialization, expense
// split math (even or proportional by host-set weights), settlement
// summaries, check-in passes, attendance attribution, and the one-time joint
// announcement broadcast that fans out through each accepted participant's
// own messaging channel. The ledger is internal only — no money moves.

export type EventPhase = "upcoming" | "live" | "ended";

export function eventPhase(
  e: Pick<CoopCommunityEvent, "startsAt" | "endsAt">,
  now: Date,
): EventPhase {
  if (now < e.startsAt) return "upcoming";
  if (now >= e.endsAt) return "ended";
  return "live";
}

/** Unified event check-in code (community-level attribution). */
export function newUnifiedEventCode(): string {
  return `EVT-${randomBytes(5).toString("hex").toUpperCase()}`;
}

/** Per-storefront check-in code — assigned only when a participant is accepted. */
export function newStorefrontCode(): string {
  return `EVS-${randomBytes(5).toString("hex").toUpperCase()}`;
}

export interface EventRow {
  event: CoopCommunityEvent;
  participants: Array<CoopCommunityEventParticipant & { tenantName: string }>;
}

/** Load events (with joined participant names) for a set of event ids. */
export async function loadEventRows(eventIds: number[]): Promise<EventRow[]> {
  if (eventIds.length === 0) return [];
  const [events, parts] = await Promise.all([
    db
      .select()
      .from(coopCommunityEventsTable)
      .where(inArray(coopCommunityEventsTable.id, eventIds))
      .orderBy(desc(coopCommunityEventsTable.startsAt), desc(coopCommunityEventsTable.id)),
    db
      .select({
        participant: coopCommunityEventParticipantsTable,
        tenantName: tenantsTable.brandName,
      })
      .from(coopCommunityEventParticipantsTable)
      .innerJoin(tenantsTable, eq(coopCommunityEventParticipantsTable.tenantId, tenantsTable.id))
      .where(inArray(coopCommunityEventParticipantsTable.eventId, eventIds)),
  ]);
  return events.map((event) => ({
    event,
    participants: parts
      .filter((p) => p.participant.eventId === event.id)
      .map((p) => ({ ...p.participant, tenantName: p.tenantName })),
  }));
}

type ParticipantStatus = "invited" | "accepted" | "declined";

export function serializeEvent(row: EventRow, viewerTenantId: number, now: Date = new Date()) {
  const mine = row.participants.find((p) => p.tenantId === viewerTenantId);
  const host = row.participants.find((p) => p.tenantId === row.event.hostTenantId);
  return {
    id: row.event.id,
    name: row.event.name,
    description: row.event.description ?? null,
    location: row.event.location ?? null,
    startsAt: row.event.startsAt.toISOString(),
    endsAt: row.event.endsAt.toISOString(),
    hostTenantId: row.event.hostTenantId,
    hostTenantName: host?.tenantName ?? "Unknown business",
    phase: eventPhase(row.event, now),
    broadcastTriggeredAt: row.event.broadcastTriggeredAt
      ? row.event.broadcastTriggeredAt.toISOString()
      : null,
    myStatus: (mine?.status ?? "invited") as ParticipantStatus,
    isHost: row.event.hostTenantId === viewerTenantId,
    participants: row.participants.map((p) => ({
      tenantId: p.tenantId,
      tenantName: p.tenantName,
      status: p.status as ParticipantStatus,
      shareWeight: Number(p.shareWeight),
      respondedAt: p.respondedAt ? p.respondedAt.toISOString() : null,
    })),
    acceptedCount: row.participants.filter((p) => p.status === "accepted").length,
    createdAt: row.event.createdAt.toISOString(),
  };
}

// ── Expense split math ───────────────────────────────────────────────────────
// Splits are computed at read time in integer cents across the participants
// accepted at that moment, so settlement always reflects the current roster.
// Even split: floor(total/n) each, leftover cents go one apiece to the
// lowest tenant ids (deterministic). Proportional: floor(total·wᵢ/W) each,
// leftover cents by largest fractional remainder (ties → lower tenant id).
// Either way the shares always sum exactly to the expense amount.

export interface AcceptedShareholder {
  tenantId: number;
  tenantName: string;
  weight: number;
}

export function splitExpenseCents(
  totalCents: number,
  method: string,
  holders: AcceptedShareholder[],
): Map<number, number> {
  const out = new Map<number, number>();
  if (holders.length === 0) return out;
  const ordered = [...holders].sort((a, b) => a.tenantId - b.tenantId);
  const weightSum = ordered.reduce((s, h) => s + h.weight, 0);
  const proportional = method === "proportional" && weightSum > 0;
  if (!proportional) {
    const base = Math.floor(totalCents / ordered.length);
    let remainder = totalCents - base * ordered.length;
    for (const h of ordered) {
      out.set(h.tenantId, base + (remainder > 0 ? 1 : 0));
      if (remainder > 0) remainder--;
    }
    return out;
  }
  const raw = ordered.map((h) => {
    const exact = (totalCents * h.weight) / weightSum;
    const floor = Math.floor(exact);
    return { tenantId: h.tenantId, floor, frac: exact - floor };
  });
  let remainder = totalCents - raw.reduce((s, r) => s + r.floor, 0);
  // Largest fractional remainder first; ties break to the lower tenant id.
  const order = [...raw].sort((a, b) => b.frac - a.frac || a.tenantId - b.tenantId);
  const extra = new Set(order.slice(0, remainder).map((r) => r.tenantId));
  for (const r of raw) out.set(r.tenantId, r.floor + (extra.has(r.tenantId) ? 1 : 0));
  return out;
}

const toDollars = (cents: number) => Math.round(cents) / 100;
export const toCents = (amount: number) => Math.round(amount * 100);

export interface ExpenseWithPayerName extends CoopCommunityEventExpense {
  paidByTenantName: string;
}

/** Serialize the ledger: each expense with computed shares, plus settlement. */
export function buildLedger(
  expenses: ExpenseWithPayerName[],
  accepted: AcceptedShareholder[],
) {
  const nameOf = new Map(accepted.map((h) => [h.tenantId, h.tenantName]));
  const paidCents = new Map<number, number>();
  const owesCents = new Map<number, number>();
  for (const h of accepted) {
    paidCents.set(h.tenantId, 0);
    owesCents.set(h.tenantId, 0);
  }
  const serializedExpenses = expenses.map((exp) => {
    const totalCents = toCents(Number(exp.amount));
    const shares = splitExpenseCents(totalCents, exp.splitMethod, accepted);
    if (paidCents.has(exp.paidByTenantId)) {
      paidCents.set(exp.paidByTenantId, (paidCents.get(exp.paidByTenantId) ?? 0) + totalCents);
    }
    for (const [tenantId, cents] of shares) {
      owesCents.set(tenantId, (owesCents.get(tenantId) ?? 0) + cents);
    }
    return {
      id: exp.id,
      description: exp.description,
      amount: toDollars(totalCents),
      splitMethod: exp.splitMethod as "even" | "proportional",
      paidByTenantId: exp.paidByTenantId,
      paidByTenantName: exp.paidByTenantName,
      shares: [...shares.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([tenantId, cents]) => ({
          tenantId,
          tenantName: nameOf.get(tenantId) ?? "Unknown business",
          amount: toDollars(cents),
        })),
      createdAt: exp.createdAt.toISOString(),
    };
  });
  const settlement = [...accepted]
    .sort((a, b) => a.tenantId - b.tenantId)
    .map((h) => {
      const paid = paidCents.get(h.tenantId) ?? 0;
      const owes = owesCents.get(h.tenantId) ?? 0;
      return {
        tenantId: h.tenantId,
        tenantName: h.tenantName,
        paid: toDollars(paid),
        owes: toDollars(owes),
        net: toDollars(paid - owes),
      };
    });
  return { expenses: serializedExpenses, settlement };
}

/** Accepted participants of an event row, as split shareholders. */
export function acceptedShareholders(row: EventRow): AcceptedShareholder[] {
  return row.participants
    .filter((p) => p.status === "accepted")
    .map((p) => ({ tenantId: p.tenantId, tenantName: p.tenantName, weight: Number(p.shareWeight) }));
}

/** Full detail payload for a participant viewer: ledger, passes, attendance. */
export async function serializeEventDetail(
  row: EventRow,
  viewerTenantId: number,
  now: Date = new Date(),
) {
  const accepted = acceptedShareholders(row);
  const [expenseRows, checkins] = await Promise.all([
    db
      .select({ expense: coopCommunityEventExpensesTable, paidByTenantName: tenantsTable.brandName })
      .from(coopCommunityEventExpensesTable)
      .innerJoin(tenantsTable, eq(coopCommunityEventExpensesTable.paidByTenantId, tenantsTable.id))
      .where(eq(coopCommunityEventExpensesTable.eventId, row.event.id))
      .orderBy(desc(coopCommunityEventExpensesTable.createdAt), desc(coopCommunityEventExpensesTable.id)),
    db
      .select({
        attributedTenantId: coopCommunityEventCheckinsTable.attributedTenantId,
      })
      .from(coopCommunityEventCheckinsTable)
      .where(eq(coopCommunityEventCheckinsTable.eventId, row.event.id)),
  ]);
  const { expenses, settlement } = buildLedger(
    expenseRows.map((r) => ({ ...r.expense, paidByTenantName: r.paidByTenantName })),
    accepted,
  );
  // Passes: only accepted storefronts ever hold a live code. The host sees
  // every storefront's pass (it prints/distributes materials); a partner sees
  // its own pass plus the unified event pass.
  const isHost = row.event.hostTenantId === viewerTenantId;
  const acceptedParts = row.participants.filter(
    (p) => p.status === "accepted" && p.checkinCode != null,
  );
  const passes = [
    ...acceptedParts
      .filter((p) => isHost || p.tenantId === viewerTenantId)
      .sort((a, b) => a.tenantId - b.tenantId)
      .map((p) => ({ tenantId: p.tenantId, tenantName: p.tenantName, code: p.checkinCode! })),
    { tenantId: null, tenantName: null, code: row.event.unifiedCode },
  ];
  const byStorefrontCounts = new Map<number, number>();
  let unified = 0;
  for (const c of checkins) {
    if (c.attributedTenantId == null) unified++;
    else byStorefrontCounts.set(c.attributedTenantId, (byStorefrontCounts.get(c.attributedTenantId) ?? 0) + 1);
  }
  const attendance = {
    totalCheckins: checkins.length,
    unifiedCheckins: unified,
    byStorefront: acceptedParts
      .sort((a, b) => a.tenantId - b.tenantId)
      .map((p) => ({
        tenantId: p.tenantId,
        tenantName: p.tenantName,
        checkins: byStorefrontCounts.get(p.tenantId) ?? 0,
      })),
  };
  return { ...serializeEvent(row, viewerTenantId, now), expenses, settlement, passes, attendance };
}

// ── Joint announcement broadcast ─────────────────────────────────────────────

export interface EventBroadcastSummary {
  sent: number;
  skipped: number;
  totalCandidates: number;
  perTenant: Array<{
    tenantId: number;
    tenantName: string;
    sent: number;
    skipped: number;
    totalCandidates: number;
  }>;
}

/**
 * Fan the joint initiative announcement out through EACH accepted
 * participant's own messaging channel to its own opted-in customers. The
 * caller must have already stamped broadcast_triggered_at (send-once lock).
 * Shared customers of two participating businesses are texted once.
 */
export async function runEventBroadcast(
  eventId: number,
  now: Date = new Date(),
): Promise<EventBroadcastSummary> {
  const [row] = await loadEventRows([eventId]);
  if (!row) return { sent: 0, skipped: 0, totalCandidates: 0, perTenant: [] };
  const accepted = row.participants.filter((p) => p.status === "accepted");
  const names = accepted.map((p) => p.tenantName);
  const when = row.event.startsAt.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const where = row.event.location ? ` at ${row.event.location}` : "";

  const summary: EventBroadcastSummary = { sent: 0, skipped: 0, totalCandidates: 0, perTenant: [] };
  const seenPhones = new Set<string>();
  for (const participant of accepted) {
    const per = {
      tenantId: participant.tenantId,
      tenantName: participant.tenantName,
      sent: 0,
      skipped: 0,
      totalCandidates: 0,
    };
    const customers = await db
      .select({
        id: sosCustomersTable.id,
        phone: sosCustomersTable.phone,
        smsOptIn: sosCustomersTable.smsOptIn,
      })
      .from(sosCustomersTable)
      .where(eq(sosCustomersTable.tenantId, participant.tenantId));
    for (const customer of customers) {
      per.totalCandidates++;
      const phone = normalizeToE164(customer.phone);
      if (!customer.smsOptIn || !phone || seenPhones.has(phone)) {
        per.skipped++;
        continue;
      }
      seenPhones.add(phone);
      await sendMessageSafe({
        tenantId: participant.tenantId,
        origin: "marketing",
        kind: "coop_event_broadcast",
        customerId: customer.id,
        toNumber: phone,
        body:
          `${participant.tenantName}: Join us for "${row.event.name}"${where} on ${when}! ` +
          `A neighborhood event with ${names.join(", ")}. Reply STOP to opt out.`,
        context: { coopCommunityEventId: row.event.id },
      });
      per.sent++;
    }
    summary.sent += per.sent;
    summary.skipped += per.skipped;
    summary.totalCandidates += per.totalCandidates;
    summary.perTenant.push(per);
  }
  logger.info(
    { eventId, sent: summary.sent, skipped: summary.skipped, total: summary.totalCandidates },
    "Co-op community event broadcast completed",
  );
  return summary;
}
