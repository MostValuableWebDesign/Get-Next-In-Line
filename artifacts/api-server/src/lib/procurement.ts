import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  procurementVendorsTable,
  procurementVendorItemsTable,
  procurementGroupBuysTable,
  procurementGroupBuyParticipantsTable,
  procurementLedgerEntriesTable,
  procurementSupplyItemsTable,
  type ProcurementBulkTier,
  type ProcurementGroupBuy,
  type ProcurementVendorItem,
  type ProcurementVendor,
  type ProcurementLedgerEntry,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { logger } from "./logger";

// ── Co-Op Supplier & Procurement Marketplace helpers ─────────────────────────

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Normalize + sort bulk tiers ascending by minQty. */
export function normalizeTiers(tiers: ProcurementBulkTier[]): ProcurementBulkTier[] {
  return [...tiers]
    .map((t) => ({ minQty: t.minQty, unitPrice: round2(t.unitPrice) }))
    .sort((a, b) => a.minQty - b.minQty);
}

/** Highest tier whose minQty the pooled quantity reaches (null = base pricing). */
export function tierFor(
  tiers: ProcurementBulkTier[],
  totalQty: number
): ProcurementBulkTier | null {
  let reached: ProcurementBulkTier | null = null;
  for (const t of normalizeTiers(tiers)) {
    if (totalQty >= t.minQty) reached = t;
  }
  return reached;
}

/** Cheapest next tier the pool has not reached yet (null = top tier reached). */
export function nextTierFor(
  tiers: ProcurementBulkTier[],
  totalQty: number
): ProcurementBulkTier | null {
  for (const t of normalizeTiers(tiers)) {
    if (totalQty < t.minQty) return t;
  }
  return null;
}

/**
 * Co-op network membership: the tenant participates in at least one accepted,
 * non-banned partnership. Group-buy participation is limited to connected
 * co-op merchants — a business with no partnerships isn't in the network yet.
 */
export async function isCoopNetworkTenant(tenantId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: merchantCoopPartnershipsTable.id })
    .from(merchantCoopPartnershipsTable)
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        isNull(merchantCoopPartnershipsTable.bannedAt),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
        )
      )
    )
    .limit(1);
  return row != null;
}

export type GroupBuyRow = {
  groupBuy: ProcurementGroupBuy;
  item: ProcurementVendorItem;
  vendor: ProcurementVendor;
  organizerName: string;
  participants: { tenantId: number; tenantName: string; quantity: number }[];
};

/** Load group buys (with item, vendor, organizer, participants) by id. */
export async function loadGroupBuyRows(ids: number[]): Promise<GroupBuyRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      groupBuy: procurementGroupBuysTable,
      item: procurementVendorItemsTable,
      vendor: procurementVendorsTable,
      organizerName: tenantsTable.brandName,
    })
    .from(procurementGroupBuysTable)
    .innerJoin(
      procurementVendorItemsTable,
      eq(procurementGroupBuysTable.vendorItemId, procurementVendorItemsTable.id)
    )
    .innerJoin(
      procurementVendorsTable,
      eq(procurementVendorItemsTable.vendorId, procurementVendorsTable.id)
    )
    .innerJoin(tenantsTable, eq(procurementGroupBuysTable.organizerTenantId, tenantsTable.id))
    .where(inArray(procurementGroupBuysTable.id, ids))
    .orderBy(desc(procurementGroupBuysTable.createdAt), desc(procurementGroupBuysTable.id));

  const participants = await db
    .select({
      groupBuyId: procurementGroupBuyParticipantsTable.groupBuyId,
      tenantId: procurementGroupBuyParticipantsTable.tenantId,
      quantity: procurementGroupBuyParticipantsTable.quantity,
      tenantName: tenantsTable.brandName,
    })
    .from(procurementGroupBuyParticipantsTable)
    .innerJoin(tenantsTable, eq(procurementGroupBuyParticipantsTable.tenantId, tenantsTable.id))
    .where(inArray(procurementGroupBuyParticipantsTable.groupBuyId, ids))
    .orderBy(procurementGroupBuyParticipantsTable.id);

  return rows.map((r) => ({
    ...r,
    participants: participants
      .filter((p) => p.groupBuyId === r.groupBuy.id)
      .map(({ tenantId, tenantName, quantity }) => ({ tenantId, tenantName, quantity })),
  }));
}

/** Serialize a group buy for the API, with live tier progress for the viewer. */
export function serializeGroupBuy(row: GroupBuyRow, viewerTenantId: number | null) {
  const { groupBuy: gb, item, vendor, organizerName, participants } = row;
  const totalQuantity = participants.reduce((s, p) => s + p.quantity, 0);
  const tiers = normalizeTiers(item.bulkTiers ?? []);
  const basePrice = parseFloat(item.basePrice);
  const isClosed = gb.status === "closed";
  const liveTier = tierFor(tiers, totalQuantity);
  const currentTier = isClosed
    ? gb.achievedTierMinQty != null
      ? (tiers.find((t) => t.minQty === gb.achievedTierMinQty) ?? null)
      : null
    : liveTier;
  const currentUnitPrice = isClosed
    ? gb.achievedUnitPrice != null
      ? parseFloat(gb.achievedUnitPrice)
      : basePrice
    : (liveTier?.unitPrice ?? basePrice);
  const mine = viewerTenantId == null
    ? null
    : (participants.find((p) => p.tenantId === viewerTenantId) ?? null);
  return {
    id: gb.id,
    status: gb.status,
    vendorItemId: item.id,
    itemName: item.name,
    unit: item.unit,
    vendorId: vendor.id,
    vendorName: vendor.name,
    basePrice,
    bulkTiers: tiers,
    organizerTenantId: gb.organizerTenantId,
    organizerTenantName: organizerName,
    totalQuantity,
    currentTier,
    nextTier: isClosed ? null : nextTierFor(tiers, totalQuantity),
    currentUnitPrice: round2(currentUnitPrice),
    participants: participants.map((p) => ({
      tenantId: p.tenantId,
      tenantName: p.tenantName,
      quantity: p.quantity,
      isOrganizer: p.tenantId === gb.organizerTenantId,
    })),
    myQuantity: mine ? mine.quantity : null,
    achievedTierMinQty: gb.achievedTierMinQty,
    achievedUnitPrice: gb.achievedUnitPrice != null ? parseFloat(gb.achievedUnitPrice) : null,
    closedAt: gb.closedAt ? gb.closedAt.toISOString() : null,
    createdAt: gb.createdAt.toISOString(),
  };
}

export function serializeLedgerEntry(
  e: ProcurementLedgerEntry,
  tenantName: string,
  itemName: string,
  vendorName: string
) {
  return {
    id: e.id,
    groupBuyId: e.groupBuyId,
    tenantId: e.tenantId,
    tenantName,
    itemName,
    vendorName,
    quantity: e.quantity,
    unitPrice: parseFloat(e.unitPrice),
    baseUnitPrice: parseFloat(e.baseUnitPrice),
    shareAmount: parseFloat(e.shareAmount),
    savingsAmount: parseFloat(e.savingsAmount),
    createdAt: e.createdAt.toISOString(),
  };
}

/**
 * Close a group buy atomically: in a single transaction, a conditional
 * open→closed claim is the close-once lock, then the achieved tier is frozen
 * and the immutable cost-split ledger rows are generated (quantity × achieved
 * price; savings vs. solo base price). Any failure — DB error, numeric
 * overflow, crash — rolls the whole close back, so the buy stays open and the
 * close can safely be retried; a closed buy always has its full ledger.
 * Returns false when the group buy was not open (already closed / cancelled).
 */
export async function closeGroupBuy(groupBuyId: number, now: Date = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(procurementGroupBuysTable)
      .set({ status: "closed", closedAt: now, updatedAt: now })
      .where(
        and(
          eq(procurementGroupBuysTable.id, groupBuyId),
          eq(procurementGroupBuysTable.status, "open")
        )
      )
      .returning();
    if (!claimed) return false;

    const [item] = await tx
      .select()
      .from(procurementVendorItemsTable)
      .where(eq(procurementVendorItemsTable.id, claimed.vendorItemId));
    const participants = await tx
      .select()
      .from(procurementGroupBuyParticipantsTable)
      .where(eq(procurementGroupBuyParticipantsTable.groupBuyId, groupBuyId));

    const totalQty = participants.reduce((s, p) => s + p.quantity, 0);
    const tiers = normalizeTiers(item?.bulkTiers ?? []);
    const achieved = tierFor(tiers, totalQty);
    const basePrice = parseFloat(item?.basePrice ?? "0");
    const unitPrice = round2(achieved?.unitPrice ?? basePrice);

    await tx
      .update(procurementGroupBuysTable)
      .set({
        achievedTierMinQty: achieved?.minQty ?? null,
        achievedUnitPrice: unitPrice.toFixed(2),
        updatedAt: now,
      })
      .where(eq(procurementGroupBuysTable.id, groupBuyId));

    if (participants.length > 0) {
      await tx
        .insert(procurementLedgerEntriesTable)
        .values(
          participants.map((p) => ({
            groupBuyId,
            tenantId: p.tenantId,
            quantity: p.quantity,
            unitPrice: unitPrice.toFixed(2),
            baseUnitPrice: basePrice.toFixed(2),
            shareAmount: round2(p.quantity * unitPrice).toFixed(2),
            savingsAmount: round2(p.quantity * (basePrice - unitPrice)).toFixed(2),
          }))
        )
        .onConflictDoNothing();
    }
    return true;
  });
}

/**
 * Find an open group buy on a vendor item, or open one with the tenant as
 * organizer. Joining an existing pool adds `quantity` on top of any quantity
 * the tenant already pooled. Returns the group buy id and what happened.
 */
export async function createOrJoinGroupBuy(
  tenantId: number,
  vendorItemId: number,
  quantity: number
): Promise<{ action: "created" | "joined"; groupBuyId: number }> {
  const [open] = await db
    .select({ id: procurementGroupBuysTable.id })
    .from(procurementGroupBuysTable)
    .where(
      and(
        eq(procurementGroupBuysTable.vendorItemId, vendorItemId),
        eq(procurementGroupBuysTable.status, "open")
      )
    )
    .orderBy(procurementGroupBuysTable.id)
    .limit(1);

  if (open) {
    await db
      .insert(procurementGroupBuyParticipantsTable)
      .values({ groupBuyId: open.id, tenantId, quantity })
      .onConflictDoUpdate({
        target: [
          procurementGroupBuyParticipantsTable.groupBuyId,
          procurementGroupBuyParticipantsTable.tenantId,
        ],
        set: {
          quantity: sql`${procurementGroupBuyParticipantsTable.quantity} + ${quantity}`,
          updatedAt: new Date(),
        },
      });
    return { action: "joined", groupBuyId: open.id };
  }

  const [created] = await db
    .insert(procurementGroupBuysTable)
    .values({ vendorItemId, organizerTenantId: tenantId })
    .returning({ id: procurementGroupBuysTable.id });
  await db
    .insert(procurementGroupBuyParticipantsTable)
    .values({ groupBuyId: created.id, tenantId, quantity })
    .onConflictDoNothing();
  return { action: "created", groupBuyId: created.id };
}

// ── Low-stock reorder sweep (concierge tick) ─────────────────────────────────

/** Don't re-remind / re-request for the same low item more often than this. */
export const REORDER_REMINDER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Flag supply items that dropped below their low-stock threshold: stamp the
 * reorder reminder (surfaced in the marketplace UI), and — when auto-request
 * is enabled and the supply is linked to a vendor item — create or join an
 * open group-buy replenishment request for the shortfall automatically.
 * The lastReorderRemindedAt stamp (with a cooldown) is the once-per-episode
 * lock, so running on every tick never spams or double-orders. Idempotent.
 */
export async function sweepSupplyReorders(
  now: Date = new Date()
): Promise<{ reminded: number; autoRequested: number }> {
  const cutoff = new Date(now.getTime() - REORDER_REMINDER_COOLDOWN_MS);
  const lowItems = await db
    .select()
    .from(procurementSupplyItemsTable)
    .where(
      and(
        lt(procurementSupplyItemsTable.onHandQty, procurementSupplyItemsTable.lowStockThreshold),
        or(
          isNull(procurementSupplyItemsTable.lastReorderRemindedAt),
          lt(procurementSupplyItemsTable.lastReorderRemindedAt, cutoff)
        )
      )
    );

  let reminded = 0;
  let autoRequested = 0;
  for (const item of lowItems) {
    // Claim first — exactly one worker stamps the reminder per episode.
    const [claimed] = await db
      .update(procurementSupplyItemsTable)
      .set({ lastReorderRemindedAt: now, updatedAt: now })
      .where(
        and(
          eq(procurementSupplyItemsTable.id, item.id),
          or(
            isNull(procurementSupplyItemsTable.lastReorderRemindedAt),
            lt(procurementSupplyItemsTable.lastReorderRemindedAt, cutoff)
          )
        )
      )
      .returning({ id: procurementSupplyItemsTable.id });
    if (!claimed) continue;
    reminded++;

    if (!item.autoRequestEnabled || item.vendorItemId == null) continue;
    // Auto-replenish is a network feature — skip tenants outside the co-op.
    if (!(await isCoopNetworkTenant(item.tenantId))) continue;
    // Only request against vendor items that are still orderable (active,
    // verified vendor).
    const [orderable] = await db
      .select({ id: procurementVendorItemsTable.id })
      .from(procurementVendorItemsTable)
      .innerJoin(
        procurementVendorsTable,
        eq(procurementVendorItemsTable.vendorId, procurementVendorsTable.id)
      )
      .where(
        and(
          eq(procurementVendorItemsTable.id, item.vendorItemId),
          eq(procurementVendorItemsTable.isActive, true),
          eq(procurementVendorsTable.isVerified, true),
          eq(procurementVendorsTable.isActive, true)
        )
      );
    if (!orderable) continue;

    const shortfall = Math.max(item.lowStockThreshold - item.onHandQty, 1);
    const { action, groupBuyId } = await createOrJoinGroupBuy(
      item.tenantId,
      item.vendorItemId,
      shortfall
    );
    autoRequested++;
    logger.info(
      { supplyItemId: item.id, tenantId: item.tenantId, groupBuyId, action, quantity: shortfall },
      "Auto-replenish: low-stock supply pooled into a group buy"
    );
  }
  return { reminded, autoRequested };
}
