import { Router, type IRouter, type Request } from "express";
import {
  db,
  agencySettingsTable,
  coopFeaturedBoostsTable,
  coopWalletEntriesTable,
  merchantCoopPartnershipsTable,
  tenantsTable,
  type CoopFeaturedBoost,
} from "@workspace/db";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import {
  ListCoopSponsorshipSlotsResponse,
  ListCoopBoostsResponse,
  CreateCoopBoostBody,
  CreateCoopBoostResponse,
  GetCoopWalletResponse,
  ListAdminCoopWalletsResponse,
  UpdateAdminCoopFeeBody,
  UpdateAdminCoopFeeResponse,
  ProcessAdminCoopPayoutResponse,
} from "@workspace/api-zod";
import {
  BOOST_SURFACES,
  type BoostSurface,
  activateFlatBoost,
  activeBoostsForSurface,
  coopPlatformFeePercent,
  walletTotals,
} from "../lib/coopSponsorship";

// ---------------------------------------------------------------------------
// Co-Op Sponsorship Hub routes.
//
// Merchant-facing (/coop/sponsorship/*, /coop/wallet) — tenant scope via the
// x-tenant-id header, same convention as the rest of /coop. Membership is
// enforced upstream by the tenant-authorization middleware.
//
// Operator-facing (/admin/coop/*) — platform-admin only (the tenant-access
// middleware gates every /admin path on an admin session).
//
// All money here is internal accounting (simulated billing) — no real
// charges or transfers.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const money = (n: number) => Math.round(n * 100) / 100;

function serializeBoost(b: CoopFeaturedBoost, perkTitle: string, partnerName: string) {
  return {
    id: b.id,
    tenantId: b.tenantId,
    partnershipId: b.partnershipId,
    perkTitle,
    partnerName,
    surface: b.surface,
    pricingType: b.pricingType,
    amount: parseFloat(b.amount),
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    status: b.status,
    createdAt: b.createdAt.toISOString(),
  };
}

/** Boost rows joined with perk title + the sponsor's counterparty name. */
async function boostContext(boosts: CoopFeaturedBoost[]) {
  if (boosts.length === 0) return new Map<number, { perkTitle: string; partnerName: string }>();
  const partnershipIds = [...new Set(boosts.map((b) => b.partnershipId))];
  const rows = await db
    .select({
      id: merchantCoopPartnershipsTable.id,
      perkTitle: merchantCoopPartnershipsTable.perkTitle,
      hostTenantId: merchantCoopPartnershipsTable.hostTenantId,
      partnerTenantId: merchantCoopPartnershipsTable.partnerTenantId,
    })
    .from(merchantCoopPartnershipsTable)
    .where(inArray(merchantCoopPartnershipsTable.id, partnershipIds));
  const tenantIds = [...new Set(rows.flatMap((r) => [r.hostTenantId, r.partnerTenantId]))];
  const tenants = tenantIds.length
    ? await db
        .select({ id: tenantsTable.id, name: tenantsTable.brandName })
        .from(tenantsTable)
        .where(inArray(tenantsTable.id, tenantIds))
    : [];
  const nameById = new Map(tenants.map((t) => [t.id, t.name]));
  const byPartnership = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<number, { perkTitle: string; partnerName: string }>();
  for (const b of boosts) {
    const p = byPartnership.get(b.partnershipId);
    if (!p) continue;
    const otherId = b.tenantId === p.hostTenantId ? p.partnerTenantId : p.hostTenantId;
    out.set(b.id, {
      perkTitle: p.perkTitle,
      partnerName: nameById.get(otherId) ?? "Partner",
    });
  }
  return out;
}

// ── GET /coop/sponsorship/slots — availability per surface ──────────────────
router.get("/coop/sponsorship/slots", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const now = new Date();
  const slots = [];
  for (const surface of BOOST_SURFACES) {
    const active = await activeBoostsForSurface(surface, now);
    const current = active[0] ?? null;
    const pending = await db
      .select({
        startsAt: coopFeaturedBoostsTable.startsAt,
        endsAt: coopFeaturedBoostsTable.endsAt,
        bidCount: sql<number>`count(*)::int`,
        highBid: sql<string>`max(${coopFeaturedBoostsTable.amount})`,
      })
      .from(coopFeaturedBoostsTable)
      .where(
        and(
          eq(coopFeaturedBoostsTable.surface, surface),
          eq(coopFeaturedBoostsTable.status, "pending"),
          eq(coopFeaturedBoostsTable.pricingType, "bid"),
          gt(coopFeaturedBoostsTable.endsAt, now),
        ),
      )
      .groupBy(coopFeaturedBoostsTable.startsAt, coopFeaturedBoostsTable.endsAt)
      .orderBy(coopFeaturedBoostsTable.startsAt);
    const ctx = current ? await boostContext([current]) : null;
    slots.push({
      surface,
      activeBoost: current
        ? serializeBoost(
            current,
            ctx!.get(current.id)?.perkTitle ?? "",
            ctx!.get(current.id)?.partnerName ?? "Partner",
          )
        : null,
      pendingWindows: pending.map((w) => ({
        startsAt: w.startsAt.toISOString(),
        endsAt: w.endsAt.toISOString(),
        bidCount: w.bidCount,
        highBid: parseFloat(w.highBid ?? "0"),
      })),
    });
  }
  res.json(ListCoopSponsorshipSlotsResponse.parse({ slots }));
});

// ── GET /coop/sponsorship/boosts — the tenant's boosts ──────────────────────
router.get("/coop/sponsorship/boosts", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const boosts = await db
    .select()
    .from(coopFeaturedBoostsTable)
    .where(eq(coopFeaturedBoostsTable.tenantId, tenantId))
    .orderBy(desc(coopFeaturedBoostsTable.createdAt), desc(coopFeaturedBoostsTable.id));
  const ctx = await boostContext(boosts);
  res.json(
    ListCoopBoostsResponse.parse(
      boosts.map((b) =>
        serializeBoost(b, ctx.get(b.id)?.perkTitle ?? "", ctx.get(b.id)?.partnerName ?? "Partner"),
      ),
    ),
  );
});

// ── POST /coop/sponsorship/boosts — place a bid or buy a flat boost ─────────
// Flat purchases are first-come-first-served: they activate immediately and
// overlapping flat purchases for the same surface are rejected with 409.
// Bids stay pending until the scheduled auction resolution at window start.
router.post("/coop/sponsorship/boosts", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateCoopBoostBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const { partnershipId, surface, pricingType, amount } = parsed.data;
  const startsAt = new Date(parsed.data.startsAt);
  const endsAt = new Date(parsed.data.endsAt);
  const now = new Date();
  if (!(endsAt > startsAt)) {
    res.status(400).json({ message: "endsAt must be after startsAt" });
    return;
  }
  if (endsAt <= now) {
    res.status(400).json({ message: "The boost window is already over" });
    return;
  }
  if (pricingType === "bid" && startsAt <= now) {
    res.status(400).json({
      message: "Auction bids need a future start — the auction settles when the window begins",
    });
    return;
  }
  const [p] = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
  if (
    !p ||
    (p.hostTenantId !== tenantId && p.partnerTenantId !== tenantId) ||
    p.status !== "accepted" ||
    !p.isActive ||
    p.disputeSuspended ||
    p.bannedAt != null
  ) {
    res.status(404).json({ message: "Partnership not found or not active for this business" });
    return;
  }

  // Slot exclusivity across pricing types: the featured slot is exclusive per
  // surface + time window. A new boost (flat OR bid) is rejected when its
  // window overlaps any active boost, any pending flat reservation, or any
  // pending auction — with one exception: a bid whose window exactly matches
  // an existing pending auction window joins that auction (competing bid).
  //
  // The overlap check + insert run in one transaction under a per-surface
  // transaction-scoped advisory lock, so two concurrent requests for
  // overlapping windows serialize: the second sees the first's row and 409s.
  const SLOT_LOCK_NS = 0x636f5350; // "coSP" — sponsorship slot claim namespace
  const boost = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${SLOT_LOCK_NS}, ${BOOST_SURFACES.indexOf(surface)})`,
    );
    const overlapping = await tx
      .select({
        id: coopFeaturedBoostsTable.id,
        pricingType: coopFeaturedBoostsTable.pricingType,
        status: coopFeaturedBoostsTable.status,
        startsAt: coopFeaturedBoostsTable.startsAt,
        endsAt: coopFeaturedBoostsTable.endsAt,
      })
      .from(coopFeaturedBoostsTable)
      .where(
        and(
          eq(coopFeaturedBoostsTable.surface, surface),
          inArray(coopFeaturedBoostsTable.status, ["active", "pending"]),
          lt(coopFeaturedBoostsTable.startsAt, endsAt),
          gt(coopFeaturedBoostsTable.endsAt, startsAt),
        ),
      );
    const conflict = overlapping.some((b) => {
      if (
        pricingType === "bid" &&
        b.pricingType === "bid" &&
        b.status === "pending" &&
        b.startsAt.getTime() === startsAt.getTime() &&
        b.endsAt.getTime() === endsAt.getTime()
      ) {
        return false; // same auction — competing bids are welcome
      }
      return true;
    });
    if (conflict) return null;
    const status = pricingType === "flat" ? (startsAt <= now ? "active" : "pending") : "pending";
    const [created] = await tx
      .insert(coopFeaturedBoostsTable)
      .values({
        tenantId,
        partnershipId,
        surface,
        pricingType,
        amount: amount.toFixed(2),
        startsAt,
        endsAt,
        status,
      })
      .returning();
    return created;
  });
  if (!boost) {
    res.status(409).json({
      message:
        pricingType === "bid"
          ? "That window conflicts with an existing reservation or auction — bid on the exact open auction window or pick a free window"
          : "That featured slot window is already taken — try another window or place a bid",
    });
    return;
  }
  // Flat purchases are charged at purchase time (winning bids are charged at
  // auction resolution). Future-dated flat purchases activate on schedule via
  // the resolution sweep but pay now — the slot is reserved.
  if (pricingType === "flat") {
    await activateFlatBoost(boost);
  }
  const ctx = await boostContext([boost]);
  res.status(201).json(
    CreateCoopBoostResponse.parse(
      serializeBoost(boost, ctx.get(boost.id)?.perkTitle ?? "", ctx.get(boost.id)?.partnerName ?? "Partner"),
    ),
  );
});

// ── GET /coop/wallet — balance + ledger for the scoped tenant ───────────────
router.get("/coop/wallet", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const totals = await walletTotals(tenantId);
  const entries = await db
    .select({
      entry: coopWalletEntriesTable,
      perkTitle: merchantCoopPartnershipsTable.perkTitle,
    })
    .from(coopWalletEntriesTable)
    .leftJoin(
      merchantCoopPartnershipsTable,
      eq(coopWalletEntriesTable.partnershipId, merchantCoopPartnershipsTable.id),
    )
    .where(eq(coopWalletEntriesTable.tenantId, tenantId))
    .orderBy(desc(coopWalletEntriesTable.createdAt), desc(coopWalletEntriesTable.id))
    .limit(200);
  res.json(
    GetCoopWalletResponse.parse({
      balance: money(totals.balance),
      lifetimeEarnings: money(totals.lifetimeEarnings),
      totalFees: money(totals.totalFees),
      entries: entries.map(({ entry: e, perkTitle }) => ({
        id: e.id,
        entryType: e.entryType,
        amount: parseFloat(e.amount),
        fee: parseFloat(e.fee),
        partnershipId: e.partnershipId,
        partnershipPerkTitle: perkTitle ?? null,
        redemptionId: e.redemptionId,
        boostId: e.boostId,
        status: e.status,
        description: e.description,
        createdAt: e.createdAt.toISOString(),
      })),
    }),
  );
});

// ── GET /admin/coop/wallets — operator overview ─────────────────────────────
router.get("/admin/coop/wallets", async (_req, res): Promise<void> => {
  const feePercent = await coopPlatformFeePercent();
  const rows = await db
    .select({
      tenantId: coopWalletEntriesTable.tenantId,
      tenantName: tenantsTable.brandName,
      pendingBalance: sql<string>`coalesce(sum(${coopWalletEntriesTable.amount}) filter (where ${coopWalletEntriesTable.status} = 'pending'), 0)`,
      lifetimeEarnings: sql<string>`coalesce(sum(${coopWalletEntriesTable.amount}) filter (where ${coopWalletEntriesTable.amount} > 0), 0)`,
      totalFees: sql<string>`coalesce(sum(${coopWalletEntriesTable.fee}), 0)`,
      entryCount: sql<number>`count(*)::int`,
      lastActivityAt: sql<string | null>`max(${coopWalletEntriesTable.createdAt})`,
    })
    .from(coopWalletEntriesTable)
    .innerJoin(tenantsTable, eq(coopWalletEntriesTable.tenantId, tenantsTable.id))
    .groupBy(coopWalletEntriesTable.tenantId, tenantsTable.brandName)
    .orderBy(sql`2`);
  res.json(
    ListAdminCoopWalletsResponse.parse({
      feePercent,
      wallets: rows.map((r) => ({
        tenantId: r.tenantId,
        tenantName: r.tenantName,
        pendingBalance: money(parseFloat(r.pendingBalance)),
        lifetimeEarnings: money(parseFloat(r.lifetimeEarnings)),
        totalFees: money(parseFloat(r.totalFees)),
        entryCount: r.entryCount,
        lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt).toISOString() : null,
      })),
    }),
  );
});

// ── PATCH /admin/coop/fee — set the platform transaction fee ────────────────
router.patch("/admin/coop/fee", async (req, res): Promise<void> => {
  const parsed = UpdateAdminCoopFeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid fee percent", errors: parsed.error.flatten() });
    return;
  }
  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  if (settings) {
    await db
      .update(agencySettingsTable)
      .set({ coopPlatformFeePercent: parsed.data.feePercent.toFixed(2) })
      .where(eq(agencySettingsTable.id, settings.id));
  } else {
    await db
      .insert(agencySettingsTable)
      .values({ coopPlatformFeePercent: parsed.data.feePercent.toFixed(2) });
  }
  res.json(UpdateAdminCoopFeeResponse.parse({ feePercent: parsed.data.feePercent }));
});

// ── POST /admin/coop/wallets/:tenantId/payouts — mark balance paid out ──────
// Internal accounting only: flips every pending entry to paid_out and
// appends a negative payout entry, all in one transaction so the balance
// can't be double-paid by concurrent clicks.
router.post("/admin/coop/wallets/:tenantId/payouts", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    res.status(404).json({ message: "Tenant not found" });
    return;
  }
  const [tenant] = await db
    .select({ id: tenantsTable.id, name: tenantsTable.brandName })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.status(404).json({ message: "Tenant not found" });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const marked = await tx
      .update(coopWalletEntriesTable)
      .set({ status: "paid_out" })
      .where(
        and(
          eq(coopWalletEntriesTable.tenantId, tenantId),
          eq(coopWalletEntriesTable.status, "pending"),
        ),
      )
      .returning({ amount: coopWalletEntriesTable.amount });
    const total = marked.reduce((s, r) => s + parseFloat(r.amount), 0);
    if (!(total > 0)) {
      tx.rollback();
    }
    const [payout] = await tx
      .insert(coopWalletEntriesTable)
      .values({
        tenantId,
        entryType: "payout",
        amount: (-total).toFixed(2),
        status: "paid_out",
        description: `Payout processed by platform operator`,
      })
      .returning();
    return { total, entriesMarked: marked.length, payoutEntryId: payout.id };
  }).catch((err) => {
    // drizzle tx.rollback() throws a rollback error — map it to "nothing to pay".
    if (err instanceof Error && /[Rr]ollback/.test(err.message)) return null;
    throw err;
  });
  if (!result) {
    res.status(409).json({ message: "Nothing to pay out — no positive pending balance" });
    return;
  }
  res.status(201).json(
    ProcessAdminCoopPayoutResponse.parse({
      tenantId,
      amountPaid: money(result.total),
      entriesMarked: result.entriesMarked,
      payoutEntryId: result.payoutEntryId,
    }),
  );
});

export default router;
