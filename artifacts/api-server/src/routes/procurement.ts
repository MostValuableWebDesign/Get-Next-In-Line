import { Router, type Request, type IRouter } from "express";
import {
  db,
  procurementVendorsTable,
  procurementVendorItemsTable,
  procurementGroupBuysTable,
  procurementGroupBuyParticipantsTable,
  procurementLedgerEntriesTable,
  procurementSupplyItemsTable,
  tenantsTable,
  type ProcurementVendor,
  type ProcurementVendorItem,
  type ProcurementBulkTier,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  CreateProcurementVendorBody,
  UpdateProcurementVendorBody,
  CreateProcurementVendorItemBody,
  UpdateProcurementVendorItemBody,
  CreateProcurementGroupBuyBody,
  JoinProcurementGroupBuyBody,
  CreateProcurementSupplyBody,
  UpdateProcurementSupplyBody,
  ReplenishProcurementSupplyBody,
  ListAdminProcurementVendorsResponse,
  CreateProcurementVendorResponse,
  UpdateProcurementVendorResponse,
  CreateProcurementVendorItemResponse,
  UpdateProcurementVendorItemResponse,
  GetAdminProcurementOverviewResponse,
  ListProcurementVendorsResponse,
  ListProcurementGroupBuysResponse,
  CreateProcurementGroupBuyResponse,
  JoinProcurementGroupBuyResponse,
  CloseProcurementGroupBuyResponse,
  GetProcurementGroupBuyLedgerResponse,
  ListProcurementLedgerResponse,
  ListProcurementSuppliesResponse,
  CreateProcurementSupplyResponse,
  UpdateProcurementSupplyResponse,
  ReplenishProcurementSupplyResponse,
} from "@workspace/api-zod";
import {
  closeGroupBuy,
  createOrJoinGroupBuy,
  isCoopNetworkTenant,
  loadGroupBuyRows,
  normalizeTiers,
  round2,
  serializeGroupBuy,
  serializeLedgerEntry,
} from "../lib/procurement";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Co-Op Supplier & Procurement Marketplace
//
// Admin surface (/admin/procurement/*): curate the verified regional B2B
// vendor directory (vendors + supply items with bulk pricing tiers) and view
// network-wide group-buy activity and cumulative savings. Admin-only via the
// path-based tenantAccess policy — never tenant-facing.
//
// Merchant surface (/coop/procurement/*): verified vendor directory, group
// buying with live volume-discount tier progress, cost-split ledgers, and
// per-tenant supply inventory with low-stock replenishment. All requests are
// scoped strictly by x-tenant-id (no admin bypass on visibility — the same
// convention as the rest of /coop).
// ---------------------------------------------------------------------------

/** Tenant scope from the x-tenant-id header (same convention as /api/coop). */
function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export const NOT_IN_COOP_NETWORK_MESSAGE =
  "Group buying is a co-op network feature — form at least one accepted partnership to pool orders with other merchants.";

function serializeVendor(v: ProcurementVendor, items: ProcurementVendorItem[]) {
  return {
    id: v.id,
    name: v.name,
    category: v.category,
    region: v.region,
    contactEmail: v.contactEmail,
    notes: v.notes,
    isVerified: v.isVerified,
    isActive: v.isActive,
    items: items.map((i) => ({
      id: i.id,
      vendorId: i.vendorId,
      name: i.name,
      unit: i.unit,
      basePrice: parseFloat(i.basePrice),
      bulkTiers: normalizeTiers(i.bulkTiers ?? []),
      isActive: i.isActive,
    })),
    createdAt: v.createdAt.toISOString(),
  };
}

async function itemsForVendors(vendorIds: number[], activeOnly: boolean) {
  if (vendorIds.length === 0) return [] as ProcurementVendorItem[];
  return db
    .select()
    .from(procurementVendorItemsTable)
    .where(
      activeOnly
        ? and(
            inArray(procurementVendorItemsTable.vendorId, vendorIds),
            eq(procurementVendorItemsTable.isActive, true)
          )
        : inArray(procurementVendorItemsTable.vendorId, vendorIds)
    )
    .orderBy(procurementVendorItemsTable.name, procurementVendorItemsTable.id);
}

/** Validate bulk tiers: positive prices, strictly increasing qty, decreasing price. */
function tierProblem(tiers: ProcurementBulkTier[], basePrice: number): string | null {
  const sorted = normalizeTiers(tiers);
  let prevQty = 0;
  let prevPrice = basePrice;
  for (const t of sorted) {
    if (t.minQty <= prevQty) return "Bulk tiers must have strictly increasing minimum quantities";
    if (t.unitPrice > prevPrice)
      return "Bulk tier prices must not increase — larger pools can never cost more per unit";
    prevQty = t.minQty;
    prevPrice = t.unitPrice;
  }
  return null;
}

// ── Admin: vendor directory CRUD ─────────────────────────────────────────────

router.get("/admin/procurement/vendors", async (_req, res): Promise<void> => {
  const vendors = await db
    .select()
    .from(procurementVendorsTable)
    .orderBy(procurementVendorsTable.name, procurementVendorsTable.id);
  const items = await itemsForVendors(vendors.map((v) => v.id), false);
  res.json(
    ListAdminProcurementVendorsResponse.parse(
      vendors.map((v) => serializeVendor(v, items.filter((i) => i.vendorId === v.id)))
    )
  );
});

router.post("/admin/procurement/vendors", async (req, res): Promise<void> => {
  const parsed = CreateProcurementVendorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const [vendor] = await db
    .insert(procurementVendorsTable)
    .values({
      name: parsed.data.name,
      category: parsed.data.category,
      region: parsed.data.region,
      contactEmail: parsed.data.contactEmail ?? null,
      notes: parsed.data.notes ?? null,
      isVerified: parsed.data.isVerified ?? false,
    })
    .returning();
  res.status(201).json(CreateProcurementVendorResponse.parse(serializeVendor(vendor, [])));
});

router.patch("/admin/procurement/vendors/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const parsed = UpdateProcurementVendorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const updates: Partial<typeof procurementVendorsTable.$inferInsert> = { updatedAt: new Date() };
  if (parsed.data.name != null) updates.name = parsed.data.name;
  if (parsed.data.category != null) updates.category = parsed.data.category;
  if (parsed.data.region != null) updates.region = parsed.data.region;
  if ("contactEmail" in parsed.data) updates.contactEmail = parsed.data.contactEmail ?? null;
  if ("notes" in parsed.data) updates.notes = parsed.data.notes ?? null;
  if (parsed.data.isVerified != null) updates.isVerified = parsed.data.isVerified;
  if (parsed.data.isActive != null) updates.isActive = parsed.data.isActive;

  const [vendor] = await db
    .update(procurementVendorsTable)
    .set(updates)
    .where(eq(procurementVendorsTable.id, id))
    .returning();
  if (!vendor) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const items = await itemsForVendors([id], false);
  res.json(UpdateProcurementVendorResponse.parse(serializeVendor(vendor, items)));
});

router.post("/admin/procurement/vendors/:id/items", async (req, res): Promise<void> => {
  const vendorId = Number(req.params.id);
  if (!Number.isInteger(vendorId)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const parsed = CreateProcurementVendorItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const [vendor] = await db
    .select({ id: procurementVendorsTable.id })
    .from(procurementVendorsTable)
    .where(eq(procurementVendorsTable.id, vendorId));
  if (!vendor) {
    res.status(404).json({ message: "Vendor not found" });
    return;
  }
  const tiers = normalizeTiers(parsed.data.bulkTiers ?? []);
  const problem = tierProblem(tiers, parsed.data.basePrice);
  if (problem) {
    res.status(400).json({ message: problem });
    return;
  }
  const [item] = await db
    .insert(procurementVendorItemsTable)
    .values({
      vendorId,
      name: parsed.data.name,
      unit: parsed.data.unit,
      basePrice: round2(parsed.data.basePrice).toFixed(2),
      bulkTiers: tiers,
    })
    .returning();
  res.status(201).json(
    CreateProcurementVendorItemResponse.parse({
      id: item.id,
      vendorId: item.vendorId,
      name: item.name,
      unit: item.unit,
      basePrice: parseFloat(item.basePrice),
      bulkTiers: item.bulkTiers,
      isActive: item.isActive,
    })
  );
});

router.patch("/admin/procurement/vendor-items/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const parsed = UpdateProcurementVendorItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const [existing] = await db
    .select()
    .from(procurementVendorItemsTable)
    .where(eq(procurementVendorItemsTable.id, id));
  if (!existing) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const basePrice = parsed.data.basePrice ?? parseFloat(existing.basePrice);
  const tiers = normalizeTiers(parsed.data.bulkTiers ?? existing.bulkTiers ?? []);
  const problem = tierProblem(tiers, basePrice);
  if (problem) {
    res.status(400).json({ message: problem });
    return;
  }
  const updates: Partial<typeof procurementVendorItemsTable.$inferInsert> = { bulkTiers: tiers };
  if (parsed.data.name != null) updates.name = parsed.data.name;
  if (parsed.data.unit != null) updates.unit = parsed.data.unit;
  if (parsed.data.basePrice != null) updates.basePrice = round2(parsed.data.basePrice).toFixed(2);
  if (parsed.data.isActive != null) updates.isActive = parsed.data.isActive;
  const [item] = await db
    .update(procurementVendorItemsTable)
    .set(updates)
    .where(eq(procurementVendorItemsTable.id, id))
    .returning();
  res.json(
    UpdateProcurementVendorItemResponse.parse({
      id: item.id,
      vendorId: item.vendorId,
      name: item.name,
      unit: item.unit,
      basePrice: parseFloat(item.basePrice),
      bulkTiers: item.bulkTiers,
      isActive: item.isActive,
    })
  );
});

// ── Admin: network-wide marketplace overview ─────────────────────────────────

router.get("/admin/procurement/overview", async (_req, res): Promise<void> => {
  const vendors = await db
    .select({ id: procurementVendorsTable.id, isVerified: procurementVendorsTable.isVerified })
    .from(procurementVendorsTable);
  const openIds = await db
    .select({ id: procurementGroupBuysTable.id })
    .from(procurementGroupBuysTable)
    .where(eq(procurementGroupBuysTable.status, "open"));
  const [closedCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(procurementGroupBuysTable)
    .where(eq(procurementGroupBuysTable.status, "closed"));
  const openRows = await loadGroupBuyRows(openIds.map((r) => r.id));

  const savingsRows = await db
    .select({
      tenantId: procurementLedgerEntriesTable.tenantId,
      tenantName: tenantsTable.brandName,
      savings: sql<string>`coalesce(sum(${procurementLedgerEntriesTable.savingsAmount}), 0)`,
    })
    .from(procurementLedgerEntriesTable)
    .innerJoin(tenantsTable, eq(procurementLedgerEntriesTable.tenantId, tenantsTable.id))
    .groupBy(procurementLedgerEntriesTable.tenantId, tenantsTable.brandName);
  const savingsByTenant = savingsRows
    .map((r) => ({ tenantId: r.tenantId, tenantName: r.tenantName, savings: round2(parseFloat(r.savings)) }))
    .sort((a, b) => b.savings - a.savings);

  res.json(
    GetAdminProcurementOverviewResponse.parse({
      vendorCount: vendors.length,
      verifiedVendorCount: vendors.filter((v) => v.isVerified).length,
      openGroupBuys: openRows.map((r) => serializeGroupBuy(r, null)),
      closedGroupBuyCount: closedCount?.n ?? 0,
      totalSavings: round2(savingsByTenant.reduce((s, t) => s + t.savings, 0)),
      savingsByTenant,
    })
  );
});

// ── Merchant: verified vendor directory ──────────────────────────────────────

router.get("/coop/procurement/vendors", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  // Merchants only ever see verified, active vendors — unverified drafts and
  // retired vendors stay admin-console-only.
  const vendors = await db
    .select()
    .from(procurementVendorsTable)
    .where(
      and(eq(procurementVendorsTable.isVerified, true), eq(procurementVendorsTable.isActive, true))
    )
    .orderBy(procurementVendorsTable.name, procurementVendorsTable.id);
  const items = await itemsForVendors(vendors.map((v) => v.id), true);
  res.json(
    ListProcurementVendorsResponse.parse(
      vendors.map((v) => serializeVendor(v, items.filter((i) => i.vendorId === v.id)))
    )
  );
});

// ── Merchant: group buys ─────────────────────────────────────────────────────

/** A vendor item that merchants may order against (active + verified vendor). */
async function orderableVendorItem(vendorItemId: number) {
  const [row] = await db
    .select({ item: procurementVendorItemsTable })
    .from(procurementVendorItemsTable)
    .innerJoin(
      procurementVendorsTable,
      eq(procurementVendorItemsTable.vendorId, procurementVendorsTable.id)
    )
    .where(
      and(
        eq(procurementVendorItemsTable.id, vendorItemId),
        eq(procurementVendorItemsTable.isActive, true),
        eq(procurementVendorsTable.isVerified, true),
        eq(procurementVendorsTable.isActive, true)
      )
    );
  return row?.item ?? null;
}

router.get("/coop/procurement/group-buys", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  // Every open pool is visible network-wide (that's the point of pooling);
  // closed/cancelled ones only where this tenant participated.
  const mine = await db
    .select({ groupBuyId: procurementGroupBuyParticipantsTable.groupBuyId })
    .from(procurementGroupBuyParticipantsTable)
    .where(eq(procurementGroupBuyParticipantsTable.tenantId, tenantId));
  const open = await db
    .select({ id: procurementGroupBuysTable.id })
    .from(procurementGroupBuysTable)
    .where(eq(procurementGroupBuysTable.status, "open"));
  const ids = [...new Set([...open.map((r) => r.id), ...mine.map((r) => r.groupBuyId)])];
  const rows = await loadGroupBuyRows(ids);
  res.json(
    ListProcurementGroupBuysResponse.parse(
      rows
        .filter((r) => r.groupBuy.status === "open" || r.participants.some((p) => p.tenantId === tenantId))
        .map((r) => serializeGroupBuy(r, tenantId))
    )
  );
});

router.post("/coop/procurement/group-buys", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateProcurementGroupBuyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  if (!(await isCoopNetworkTenant(tenantId))) {
    res.status(403).json({ message: NOT_IN_COOP_NETWORK_MESSAGE });
    return;
  }
  const item = await orderableVendorItem(parsed.data.vendorItemId);
  if (!item) {
    res.status(404).json({ message: "Vendor item not found or not orderable" });
    return;
  }
  const [gb] = await db
    .insert(procurementGroupBuysTable)
    .values({ vendorItemId: item.id, organizerTenantId: tenantId })
    .returning({ id: procurementGroupBuysTable.id });
  await db
    .insert(procurementGroupBuyParticipantsTable)
    .values({ groupBuyId: gb.id, tenantId, quantity: parsed.data.quantity });
  const [row] = await loadGroupBuyRows([gb.id]);
  res.status(201).json(CreateProcurementGroupBuyResponse.parse(serializeGroupBuy(row, tenantId)));
});

router.post("/coop/procurement/group-buys/:id/join", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const parsed = JoinProcurementGroupBuyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const [gb] = await db
    .select()
    .from(procurementGroupBuysTable)
    .where(eq(procurementGroupBuysTable.id, id));
  if (!gb) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (gb.status !== "open") {
    res.status(409).json({ message: "This group buy is no longer open" });
    return;
  }
  if (!(await isCoopNetworkTenant(tenantId))) {
    res.status(403).json({ message: NOT_IN_COOP_NETWORK_MESSAGE });
    return;
  }
  const quantity = parsed.data.quantity;
  if (quantity === 0) {
    if (tenantId === gb.organizerTenantId) {
      res.status(400).json({
        message: "The organizer can't leave their own group buy — close it instead.",
      });
      return;
    }
    await db
      .delete(procurementGroupBuyParticipantsTable)
      .where(
        and(
          eq(procurementGroupBuyParticipantsTable.groupBuyId, id),
          eq(procurementGroupBuyParticipantsTable.tenantId, tenantId)
        )
      );
  } else {
    // Idempotent upsert: joining again SETS the tenant's pooled quantity.
    await db
      .insert(procurementGroupBuyParticipantsTable)
      .values({ groupBuyId: id, tenantId, quantity })
      .onConflictDoUpdate({
        target: [
          procurementGroupBuyParticipantsTable.groupBuyId,
          procurementGroupBuyParticipantsTable.tenantId,
        ],
        set: { quantity, updatedAt: new Date() },
      });
  }
  const [row] = await loadGroupBuyRows([id]);
  res.json(JoinProcurementGroupBuyResponse.parse(serializeGroupBuy(row, tenantId)));
});

router.post("/coop/procurement/group-buys/:id/close", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const [gb] = await db
    .select()
    .from(procurementGroupBuysTable)
    .where(eq(procurementGroupBuysTable.id, id));
  if (!gb) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (gb.organizerTenantId !== tenantId) {
    res.status(403).json({ message: "Only the organizer can close a group buy" });
    return;
  }
  const closed = await closeGroupBuy(id);
  if (!closed) {
    res.status(409).json({ message: "This group buy is already closed" });
    return;
  }
  const [row] = await loadGroupBuyRows([id]);
  res.json(CloseProcurementGroupBuyResponse.parse(serializeGroupBuy(row, tenantId)));
});

// ── Merchant: cost-split ledgers ─────────────────────────────────────────────

function ledgerJoinRows() {
  return db
    .select({
      entry: procurementLedgerEntriesTable,
      tenantName: tenantsTable.brandName,
      itemName: procurementVendorItemsTable.name,
      vendorName: procurementVendorsTable.name,
    })
    .from(procurementLedgerEntriesTable)
    .innerJoin(tenantsTable, eq(procurementLedgerEntriesTable.tenantId, tenantsTable.id))
    .innerJoin(
      procurementGroupBuysTable,
      eq(procurementLedgerEntriesTable.groupBuyId, procurementGroupBuysTable.id)
    )
    .innerJoin(
      procurementVendorItemsTable,
      eq(procurementGroupBuysTable.vendorItemId, procurementVendorItemsTable.id)
    )
    .innerJoin(
      procurementVendorsTable,
      eq(procurementVendorItemsTable.vendorId, procurementVendorsTable.id)
    );
}

router.get("/coop/procurement/group-buys/:id/ledger", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const [row] = await loadGroupBuyRows([id]);
  if (!row) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  // Strict participant scoping: the caller tenant must have a line in this
  // pool. (Coop convention: no admin bypass once x-tenant-id is present.)
  const participates = row.participants.some((p) => p.tenantId === tenantId);
  if (!participates) {
    res.status(403).json({ message: "Your business did not participate in this group buy" });
    return;
  }
  if (row.groupBuy.status !== "closed") {
    res.status(409).json({ message: "This group buy is still open — the ledger is generated when it closes" });
    return;
  }
  const all = await ledgerJoinRows()
    .where(eq(procurementLedgerEntriesTable.groupBuyId, id))
    .orderBy(procurementLedgerEntriesTable.id);
  // The organizer sees every participant's line; participants see their own.
  const visible =
    tenantId === row.groupBuy.organizerTenantId
      ? all
      : all.filter((r) => r.entry.tenantId === tenantId);
  res.json(
    GetProcurementGroupBuyLedgerResponse.parse({
      groupBuy: serializeGroupBuy(row, tenantId),
      entries: visible.map((r) =>
        serializeLedgerEntry(r.entry, r.tenantName, r.itemName, r.vendorName)
      ),
      totals: {
        quantity: visible.reduce((s, r) => s + r.entry.quantity, 0),
        amount: round2(visible.reduce((s, r) => s + parseFloat(r.entry.shareAmount), 0)),
        savings: round2(visible.reduce((s, r) => s + parseFloat(r.entry.savingsAmount), 0)),
      },
    })
  );
});

router.get("/coop/procurement/ledger", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const rows = await ledgerJoinRows()
    .where(eq(procurementLedgerEntriesTable.tenantId, tenantId))
    .orderBy(desc(procurementLedgerEntriesTable.createdAt), desc(procurementLedgerEntriesTable.id));
  res.json(
    ListProcurementLedgerResponse.parse(
      rows.map((r) => serializeLedgerEntry(r.entry, r.tenantName, r.itemName, r.vendorName))
    )
  );
});

// ── Merchant: supply inventory & replenishment ───────────────────────────────

async function serializeSupplies(tenantId: number) {
  const supplies = await db
    .select()
    .from(procurementSupplyItemsTable)
    .where(eq(procurementSupplyItemsTable.tenantId, tenantId))
    .orderBy(procurementSupplyItemsTable.name, procurementSupplyItemsTable.id);
  const linkedItemIds = [...new Set(supplies.flatMap((s) => (s.vendorItemId != null ? [s.vendorItemId] : [])))];
  const linked = linkedItemIds.length
    ? await db
        .select({
          item: procurementVendorItemsTable,
          vendorName: procurementVendorsTable.name,
        })
        .from(procurementVendorItemsTable)
        .innerJoin(
          procurementVendorsTable,
          eq(procurementVendorItemsTable.vendorId, procurementVendorsTable.id)
        )
        .where(inArray(procurementVendorItemsTable.id, linkedItemIds))
    : [];
  const openBuys = linkedItemIds.length
    ? await db
        .select({
          id: procurementGroupBuysTable.id,
          vendorItemId: procurementGroupBuysTable.vendorItemId,
        })
        .from(procurementGroupBuysTable)
        .where(
          and(
            inArray(procurementGroupBuysTable.vendorItemId, linkedItemIds),
            eq(procurementGroupBuysTable.status, "open")
          )
        )
        .orderBy(procurementGroupBuysTable.id)
    : [];
  const linkById = new Map(linked.map((l) => [l.item.id, l]));
  return supplies.map((s) => {
    const link = s.vendorItemId != null ? linkById.get(s.vendorItemId) : undefined;
    const openBuy = s.vendorItemId != null
      ? openBuys.find((b) => b.vendorItemId === s.vendorItemId)
      : undefined;
    return {
      id: s.id,
      name: s.name,
      unit: s.unit,
      onHandQty: s.onHandQty,
      lowStockThreshold: s.lowStockThreshold,
      vendorItemId: s.vendorItemId,
      vendorItemName: link?.item.name ?? null,
      vendorName: link?.vendorName ?? null,
      autoRequestEnabled: s.autoRequestEnabled,
      autoRestockEnabled: s.autoRestockEnabled,
      belowThreshold: s.onHandQty < s.lowStockThreshold,
      openGroupBuyId: openBuy?.id ?? null,
      lastReorderRemindedAt: s.lastReorderRemindedAt
        ? s.lastReorderRemindedAt.toISOString()
        : null,
      createdAt: s.createdAt.toISOString(),
    };
  });
}

router.get("/coop/procurement/supplies", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  res.json(ListProcurementSuppliesResponse.parse(await serializeSupplies(tenantId)));
});

router.post("/coop/procurement/supplies", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateProcurementSupplyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  if (parsed.data.vendorItemId != null && !(await orderableVendorItem(parsed.data.vendorItemId))) {
    res.status(404).json({ message: "Vendor item not found or not orderable" });
    return;
  }
  const [created] = await db
    .insert(procurementSupplyItemsTable)
    .values({
      tenantId,
      name: parsed.data.name,
      unit: parsed.data.unit ?? "unit",
      onHandQty: parsed.data.onHandQty ?? 0,
      lowStockThreshold: parsed.data.lowStockThreshold ?? 0,
      vendorItemId: parsed.data.vendorItemId ?? null,
      autoRequestEnabled: parsed.data.autoRequestEnabled ?? false,
      autoRestockEnabled: parsed.data.autoRestockEnabled ?? true,
    })
    .returning({ id: procurementSupplyItemsTable.id });
  const all = await serializeSupplies(tenantId);
  res.status(201).json(
    CreateProcurementSupplyResponse.parse(all.find((s) => s.id === created.id))
  );
});

router.patch("/coop/procurement/supplies/:id", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const parsed = UpdateProcurementSupplyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const [existing] = await db
    .select()
    .from(procurementSupplyItemsTable)
    .where(
      and(
        eq(procurementSupplyItemsTable.id, id),
        eq(procurementSupplyItemsTable.tenantId, tenantId)
      )
    );
  if (!existing) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (parsed.data.vendorItemId != null && !(await orderableVendorItem(parsed.data.vendorItemId))) {
    res.status(404).json({ message: "Vendor item not found or not orderable" });
    return;
  }
  const updates: Partial<typeof procurementSupplyItemsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (parsed.data.name != null) updates.name = parsed.data.name;
  if (parsed.data.unit != null) updates.unit = parsed.data.unit;
  if (parsed.data.onHandQty != null) updates.onHandQty = parsed.data.onHandQty;
  if (parsed.data.lowStockThreshold != null)
    updates.lowStockThreshold = parsed.data.lowStockThreshold;
  if ("vendorItemId" in parsed.data) updates.vendorItemId = parsed.data.vendorItemId ?? null;
  if (parsed.data.autoRequestEnabled != null)
    updates.autoRequestEnabled = parsed.data.autoRequestEnabled;
  if (parsed.data.autoRestockEnabled != null)
    updates.autoRestockEnabled = parsed.data.autoRestockEnabled;
  // Restocking to (or above) the threshold resets the reminder episode so the
  // next drop below threshold reminds again.
  const nextOnHand = parsed.data.onHandQty ?? existing.onHandQty;
  const nextThreshold = parsed.data.lowStockThreshold ?? existing.lowStockThreshold;
  if (nextOnHand >= nextThreshold) updates.lastReorderRemindedAt = null;

  await db
    .update(procurementSupplyItemsTable)
    .set(updates)
    .where(eq(procurementSupplyItemsTable.id, id));
  const all = await serializeSupplies(tenantId);
  res.json(UpdateProcurementSupplyResponse.parse(all.find((s) => s.id === id)));
});

router.post("/coop/procurement/supplies/:id/replenish", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const parsed = ReplenishProcurementSupplyBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const [supply] = await db
    .select()
    .from(procurementSupplyItemsTable)
    .where(
      and(
        eq(procurementSupplyItemsTable.id, id),
        eq(procurementSupplyItemsTable.tenantId, tenantId)
      )
    );
  if (!supply) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (supply.vendorItemId == null) {
    res.status(400).json({
      message: "Link this supply to a vendor item first — replenishment pools orders on a vendor's supply item.",
    });
    return;
  }
  if (!(await isCoopNetworkTenant(tenantId))) {
    res.status(403).json({ message: NOT_IN_COOP_NETWORK_MESSAGE });
    return;
  }
  if (!(await orderableVendorItem(supply.vendorItemId))) {
    res.status(400).json({ message: "The linked vendor item is no longer orderable" });
    return;
  }
  const quantity =
    parsed.data.quantity ?? Math.max(supply.lowStockThreshold - supply.onHandQty, 1);
  const { action, groupBuyId } = await createOrJoinGroupBuy(tenantId, supply.vendorItemId, quantity);
  await db
    .update(procurementSupplyItemsTable)
    .set({ lastReorderRemindedAt: new Date(), updatedAt: new Date() })
    .where(eq(procurementSupplyItemsTable.id, id));
  const [row] = await loadGroupBuyRows([groupBuyId]);
  res.json(
    ReplenishProcurementSupplyResponse.parse({
      action,
      groupBuy: serializeGroupBuy(row, tenantId),
    })
  );
});

export default router;
