import { Router, type Request, type IRouter } from "express";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  merchantCoopPartnershipsTable,
  coopRetailItemsTable,
  coopRetailStockMovementsTable,
  coopRetailLedgerEntriesTable,
  type CoopRetailItem,
} from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import {
  ListCoopRetailItemsResponse,
  CreateCoopRetailItemBody,
  CreateCoopRetailItemResponse,
  UpdateCoopRetailItemBody,
  UpdateCoopRetailItemResponse,
  AdjustCoopRetailStockBody,
  AdjustCoopRetailStockResponse,
  RecordCoopRetailSaleBody,
  RecordCoopRetailSaleResponse,
  GetCoopRetailLedgerResponse,
} from "@workspace/api-zod";
import { sendMessageSafe } from "../lib/messaging";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Co-Op Shelf-Space Inventory Tracker — /api/coop/retail
//
// Consigned/cross-promotional retail inventory a HOST business stocks for an
// ORIGINATING partner in an accepted co-op partnership. The host records POS
// sales (stock decrements atomically with a conditional-update concurrency
// guard) and both tenants get attributed ledger entries computed from the
// consignment split. Low-stock alerts fire once per episode to both sides via
// the unified SMS/simulated-SMS message pipeline. All routes are tenant-
// scoped via the x-tenant-id convention; only the two partnership parties can
// see an item, and only the host can mutate it.
// ---------------------------------------------------------------------------

/** Tenant scope from the x-tenant-id header (same convention as /api/coop). */
function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function money(n: number): string {
  return n.toFixed(2);
}

function serializeItem(
  item: CoopRetailItem,
  hostTenantName: string,
  ownerTenantName: string
) {
  return {
    id: item.id,
    partnershipId: item.partnershipId,
    hostTenantId: item.hostTenantId,
    hostTenantName,
    ownerTenantId: item.ownerTenantId,
    ownerTenantName,
    name: item.name,
    quantityOnShelf: item.quantityOnShelf,
    unitPrice: parseFloat(item.unitPrice),
    ownerSharePercent: item.ownerSharePercent,
    lowStockThreshold: item.lowStockThreshold,
    lowStock: item.quantityOnShelf <= item.lowStockThreshold,
    isActive: item.isActive,
    createdAt: item.createdAt.toISOString(),
  };
}

function itemAliases() {
  return {
    hostTenant: alias(tenantsTable, "retail_host_tenant"),
    ownerTenant: alias(tenantsTable, "retail_owner_tenant"),
  };
}

/** Item + both party names, or null. Optionally restrict to a given host. */
async function loadItem(id: number): Promise<{
  item: CoopRetailItem;
  hostTenantName: string;
  ownerTenantName: string;
} | null> {
  const { hostTenant, ownerTenant } = itemAliases();
  const [row] = await db
    .select({
      item: coopRetailItemsTable,
      hostTenantName: hostTenant.brandName,
      ownerTenantName: ownerTenant.brandName,
    })
    .from(coopRetailItemsTable)
    .innerJoin(hostTenant, eq(coopRetailItemsTable.hostTenantId, hostTenant.id))
    .innerJoin(ownerTenant, eq(coopRetailItemsTable.ownerTenantId, ownerTenant.id))
    .where(eq(coopRetailItemsTable.id, id));
  return row ?? null;
}

/**
 * Once-per-episode low-stock alerting. When the quantity is at/below the
 * threshold, atomically claim the episode (set lowStockAlertedAt only while
 * it is NULL) and — only if this call won the claim — alert BOTH businesses
 * through the unified message pipeline. A restock above the threshold clears
 * the episode (handled in the adjust route). Returns true when alerts were
 * dispatched by this call.
 */
async function maybeSendLowStockAlerts(
  item: CoopRetailItem,
  hostName: string,
  ownerName: string
): Promise<boolean> {
  if (item.quantityOnShelf > item.lowStockThreshold) return false;
  const [claimed] = await db
    .update(coopRetailItemsTable)
    .set({ lowStockAlertedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(coopRetailItemsTable.id, item.id),
        sql`${coopRetailItemsTable.lowStockAlertedAt} is null`
      )
    )
    .returning({ id: coopRetailItemsTable.id });
  if (!claimed) return false; // episode already alerted

  const settings = await db
    .select({ tenantId: sosSettingsTable.tenantId, publicPhone: sosSettingsTable.publicPhone })
    .from(sosSettingsTable)
    .where(inArray(sosSettingsTable.tenantId, [item.hostTenantId, item.ownerTenantId]));
  const phoneOf = (tenantId: number) =>
    settings.find((s) => s.tenantId === tenantId)?.publicPhone?.trim() || null;

  const body = (roleLine: string) =>
    `Low stock alert: "${item.name}" is down to ${item.quantityOnShelf} on the shelf at ${hostName} (threshold ${item.lowStockThreshold}). ${roleLine}`;
  await sendMessageSafe({
    tenantId: item.hostTenantId,
    origin: "operational",
    kind: "retail_low_stock",
    toNumber: phoneOf(item.hostTenantId),
    body: body(`Restock with ${ownerName} to keep selling.`),
    context: { itemId: item.id, partnershipId: item.partnershipId },
  });
  await sendMessageSafe({
    tenantId: item.ownerTenantId,
    origin: "operational",
    kind: "retail_low_stock",
    toNumber: phoneOf(item.ownerTenantId),
    body: body(`Coordinate a restock with ${hostName}.`),
    context: { itemId: item.id, partnershipId: item.partnershipId },
  });
  return true;
}

// ── GET /coop/retail/items — hosted + placed items for the scoped tenant ────

router.get("/coop/retail/items", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const { hostTenant, ownerTenant } = itemAliases();
  const rows = await db
    .select({
      item: coopRetailItemsTable,
      hostTenantName: hostTenant.brandName,
      ownerTenantName: ownerTenant.brandName,
    })
    .from(coopRetailItemsTable)
    .innerJoin(hostTenant, eq(coopRetailItemsTable.hostTenantId, hostTenant.id))
    .innerJoin(ownerTenant, eq(coopRetailItemsTable.ownerTenantId, ownerTenant.id))
    .where(
      or(
        eq(coopRetailItemsTable.hostTenantId, tenantId),
        eq(coopRetailItemsTable.ownerTenantId, tenantId)
      )
    )
    .orderBy(desc(coopRetailItemsTable.createdAt));
  const serialize = (r: (typeof rows)[number]) =>
    serializeItem(r.item, r.hostTenantName, r.ownerTenantName);
  res.json(
    ListCoopRetailItemsResponse.parse({
      hosted: rows.filter((r) => r.item.hostTenantId === tenantId).map(serialize),
      placed: rows
        .filter((r) => r.item.ownerTenantId === tenantId && r.item.hostTenantId !== tenantId)
        .map(serialize),
    })
  );
});

// ── POST /coop/retail/items — host adds a consigned item ────────────────────

router.post("/coop/retail/items", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const body = CreateCoopRetailItemBody.parse(req.body);

  const [p] = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.id, body.partnershipId));
  if (!p) {
    res.status(404).json({ message: "Partnership not found" });
    return;
  }
  if (p.hostTenantId !== tenantId && p.partnerTenantId !== tenantId) {
    res.status(403).json({ message: "Your business is not part of this partnership" });
    return;
  }
  if (p.status !== "accepted" || !p.isActive || p.bannedAt != null) {
    res.status(409).json({
      message: "Retail items can only be added to accepted, active partnerships",
    });
    return;
  }
  // The scoped tenant is the HOST (it stocks the item); the other party of
  // the partnership is the originating owner.
  const ownerTenantId = p.hostTenantId === tenantId ? p.partnerTenantId : p.hostTenantId;

  const [item] = await db
    .insert(coopRetailItemsTable)
    .values({
      partnershipId: p.id,
      hostTenantId: tenantId,
      ownerTenantId,
      name: body.name.trim(),
      quantityOnShelf: body.quantityOnShelf,
      unitPrice: money(body.unitPrice),
      ownerSharePercent: body.ownerSharePercent,
      lowStockThreshold: body.lowStockThreshold ?? 3,
    })
    .returning();

  // Audit the initial shelf load as a restock movement.
  if (item.quantityOnShelf > 0) {
    await db.insert(coopRetailStockMovementsTable).values({
      itemId: item.id,
      movementType: "restock",
      quantityDelta: item.quantityOnShelf,
      note: "Initial shelf stock",
      recordedByTenantId: tenantId,
    });
  }

  const loaded = await loadItem(item.id);
  res.status(201).json(
    CreateCoopRetailItemResponse.parse(
      serializeItem(item, loaded?.hostTenantName ?? "", loaded?.ownerTenantName ?? "")
    )
  );
});

// ── PATCH /coop/retail/items/:id — edit/deactivate (host only) ──────────────

router.patch("/coop/retail/items/:id", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  const body = UpdateCoopRetailItemBody.parse(req.body);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name != null) updates.name = body.name.trim();
  if (body.unitPrice != null) updates.unitPrice = money(body.unitPrice);
  if (body.ownerSharePercent != null) updates.ownerSharePercent = body.ownerSharePercent;
  if (body.lowStockThreshold != null) updates.lowStockThreshold = body.lowStockThreshold;
  if (body.isActive != null) updates.isActive = body.isActive;

  const [item] = await db
    .update(coopRetailItemsTable)
    .set(updates)
    .where(
      and(eq(coopRetailItemsTable.id, id), eq(coopRetailItemsTable.hostTenantId, tenantId))
    )
    .returning();
  if (!item) {
    res.status(404).json({ message: "Item not found" });
    return;
  }
  const loaded = await loadItem(item.id);
  res.json(
    UpdateCoopRetailItemResponse.parse(
      serializeItem(item, loaded?.hostTenantName ?? "", loaded?.ownerTenantName ?? "")
    )
  );
});

// ── POST /coop/retail/items/:id/adjust — restock / shrinkage (host only) ────

router.post("/coop/retail/items/:id/adjust", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  const body = AdjustCoopRetailStockBody.parse(req.body);
  if (body.quantityDelta === 0) {
    res.status(400).json({ message: "quantityDelta must not be zero" });
    return;
  }
  if (body.reason === "restock" && body.quantityDelta < 0) {
    res.status(400).json({ message: "A restock must increase stock" });
    return;
  }

  const existing = await loadItem(id);
  if (!existing || existing.item.hostTenantId !== tenantId) {
    res.status(404).json({ message: "Item not found" });
    return;
  }

  // Single transaction: the conditional stock update (which also guards
  // against concurrent adjustments pushing stock negative) and its audit
  // movement commit or roll back together.
  const item = await db.transaction(async (tx) => {
    const conditions = [
      eq(coopRetailItemsTable.id, id),
      eq(coopRetailItemsTable.hostTenantId, tenantId),
    ];
    if (body.quantityDelta < 0) {
      conditions.push(gte(coopRetailItemsTable.quantityOnShelf, -body.quantityDelta));
    }
    const [updated] = await tx
      .update(coopRetailItemsTable)
      .set({
        quantityOnShelf: sql`${coopRetailItemsTable.quantityOnShelf} + ${body.quantityDelta}`,
        updatedAt: new Date(),
      })
      .where(and(...conditions))
      .returning();
    if (!updated) return null;
    await tx.insert(coopRetailStockMovementsTable).values({
      itemId: updated.id,
      movementType: body.reason === "restock" ? "restock" : "adjustment",
      quantityDelta: body.quantityDelta,
      note: body.note ?? body.reason,
      recordedByTenantId: tenantId,
    });
    return updated;
  });
  if (!item) {
    res.status(409).json({ message: "Adjustment would take shelf stock below zero" });
    return;
  }

  let finalItem = item;
  if (item.quantityOnShelf > item.lowStockThreshold && item.lowStockAlertedAt != null) {
    // Restocked above the threshold: close the low-stock episode so the next
    // dip alerts again.
    const [cleared] = await db
      .update(coopRetailItemsTable)
      .set({ lowStockAlertedAt: null, updatedAt: new Date() })
      .where(eq(coopRetailItemsTable.id, item.id))
      .returning();
    finalItem = cleared ?? item;
  } else {
    // A negative adjustment can also start a low-stock episode.
    await maybeSendLowStockAlerts(item, existing.hostTenantName, existing.ownerTenantName);
  }

  res.json(
    AdjustCoopRetailStockResponse.parse(
      serializeItem(finalItem, existing.hostTenantName, existing.ownerTenantName)
    )
  );
});

// ── POST /coop/retail/items/:id/sale — record a POS retail sale ─────────────

router.post("/coop/retail/items/:id/sale", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  const body = RecordCoopRetailSaleBody.parse(req.body);

  const existing = await loadItem(id);
  if (!existing || existing.item.hostTenantId !== tenantId) {
    res.status(404).json({ message: "Item not found" });
    return;
  }
  if (!existing.item.isActive) {
    res.status(409).json({ message: "This item is deactivated" });
    return;
  }

  // One transaction for the whole sale: conditional stock decrement (the
  // concurrency guard — the row only updates when enough stock remains, so
  // two concurrent sales can never oversell), the audit movement, and BOTH
  // attributed ledger rows. Any failure rolls everything back, so inventory
  // can never be decremented without matching ledger entries.
  const saleResult = await db.transaction(async (tx) => {
    const [item] = await tx
      .update(coopRetailItemsTable)
      .set({
        quantityOnShelf: sql`${coopRetailItemsTable.quantityOnShelf} - ${body.quantity}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(coopRetailItemsTable.id, id),
          eq(coopRetailItemsTable.hostTenantId, tenantId),
          eq(coopRetailItemsTable.isActive, true),
          gte(coopRetailItemsTable.quantityOnShelf, body.quantity)
        )
      )
      .returning();
    if (!item) return null;

    const [movement] = await tx
      .insert(coopRetailStockMovementsTable)
      .values({
        itemId: item.id,
        movementType: "sale",
        quantityDelta: -body.quantity,
        recordedByTenantId: tenantId,
      })
      .returning();

    // Attribution math from the recorded split: owner share is rounded to
    // cents; the host keeps the exact remainder so the two always sum to gross.
    const gross = Math.round(parseFloat(item.unitPrice) * body.quantity * 100) / 100;
    const ownerShare = Math.round(((gross * item.ownerSharePercent) / 100) * 100) / 100;
    const hostShare = Math.round((gross - ownerShare) * 100) / 100;

    await tx.insert(coopRetailLedgerEntriesTable).values([
      {
        itemId: item.id,
        partnershipId: item.partnershipId,
        movementId: movement.id,
        tenantId: item.hostTenantId,
        counterpartyTenantId: item.ownerTenantId,
        role: "host",
        unitsSold: body.quantity,
        grossAmount: money(gross),
        shareAmount: money(hostShare),
      },
      {
        itemId: item.id,
        partnershipId: item.partnershipId,
        movementId: movement.id,
        tenantId: item.ownerTenantId,
        counterpartyTenantId: item.hostTenantId,
        role: "owner",
        unitsSold: body.quantity,
        grossAmount: money(gross),
        shareAmount: money(ownerShare),
      },
    ]);
    return { item, gross, ownerShare, hostShare };
  });
  if (!saleResult) {
    res.status(409).json({ message: "Not enough stock on the shelf" });
    return;
  }
  const { item, gross, ownerShare, hostShare } = saleResult;

  const lowStockAlertSent = await maybeSendLowStockAlerts(
    item,
    existing.hostTenantName,
    existing.ownerTenantName
  );

  res.status(201).json(
    RecordCoopRetailSaleResponse.parse({
      item: serializeItem(item, existing.hostTenantName, existing.ownerTenantName),
      unitsSold: body.quantity,
      grossAmount: gross,
      hostShareAmount: hostShare,
      ownerShareAmount: ownerShare,
      lowStockAlertSent,
    })
  );
});

// ── GET /coop/retail/ledger — per-partner totals + recent entries ────────────

const LEDGER_ENTRY_LIMIT = 50;

router.get("/coop/retail/ledger", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }

  const counterparty = alias(tenantsTable, "retail_ledger_counterparty");
  const [totals, entries] = await Promise.all([
    db
      .select({
        partnerTenantId: coopRetailLedgerEntriesTable.counterpartyTenantId,
        partnerName: counterparty.brandName,
        unitsSold: sql<number>`coalesce(sum(${coopRetailLedgerEntriesTable.unitsSold}), 0)::int`,
        grossRevenue: sql<string>`coalesce(sum(${coopRetailLedgerEntriesTable.grossAmount}), 0)`,
        myShare: sql<string>`coalesce(sum(${coopRetailLedgerEntriesTable.shareAmount}), 0)`,
      })
      .from(coopRetailLedgerEntriesTable)
      .innerJoin(
        counterparty,
        eq(coopRetailLedgerEntriesTable.counterpartyTenantId, counterparty.id)
      )
      .where(eq(coopRetailLedgerEntriesTable.tenantId, tenantId))
      .groupBy(coopRetailLedgerEntriesTable.counterpartyTenantId, counterparty.brandName),
    db
      .select({
        entry: coopRetailLedgerEntriesTable,
        itemName: coopRetailItemsTable.name,
        counterpartyName: counterparty.brandName,
      })
      .from(coopRetailLedgerEntriesTable)
      .innerJoin(
        coopRetailItemsTable,
        eq(coopRetailLedgerEntriesTable.itemId, coopRetailItemsTable.id)
      )
      .innerJoin(
        counterparty,
        eq(coopRetailLedgerEntriesTable.counterpartyTenantId, counterparty.id)
      )
      .where(eq(coopRetailLedgerEntriesTable.tenantId, tenantId))
      .orderBy(desc(coopRetailLedgerEntriesTable.createdAt), desc(coopRetailLedgerEntriesTable.id))
      .limit(LEDGER_ENTRY_LIMIT),
  ]);

  res.json(
    GetCoopRetailLedgerResponse.parse({
      partners: totals.map((t) => ({
        partnerTenantId: t.partnerTenantId,
        partnerName: t.partnerName,
        unitsSold: t.unitsSold,
        grossRevenue: parseFloat(t.grossRevenue),
        myShare: parseFloat(t.myShare),
      })),
      entries: entries.map(({ entry, itemName, counterpartyName }) => ({
        id: entry.id,
        itemId: entry.itemId,
        itemName,
        partnershipId: entry.partnershipId,
        counterpartyTenantId: entry.counterpartyTenantId,
        counterpartyName,
        role: entry.role,
        unitsSold: entry.unitsSold,
        grossAmount: parseFloat(entry.grossAmount),
        shareAmount: parseFloat(entry.shareAmount),
        createdAt: entry.createdAt.toISOString(),
      })),
    })
  );
});

export default router;
