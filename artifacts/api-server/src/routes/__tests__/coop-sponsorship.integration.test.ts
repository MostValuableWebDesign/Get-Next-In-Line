import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  merchantCoopPartnershipsTable,
  coopFeaturedBoostsTable,
  coopWalletEntriesTable,
  perkPassesTable,
} from "@workspace/db";
import { redeemWalletPassAsTenant } from "../../lib/walletRedemption";
import { inArray } from "drizzle-orm";
import { resolveCoopBoosts } from "../../lib/coopSponsorship";

// ---------------------------------------------------------------------------
// Co-Op Sponsorship Hub (/coop/sponsorship/*, /coop/wallet, /admin/coop/*),
// against the real dev DB. Covers: flat-boost purchase + overlap rejection,
// auction resolution (highest bid wins, loser lost, winner charged),
// activation/expiry ordering in the directory + perks + public post-booking
// responses, revenue-share split math including the platform fee, wallet
// ledger consistency, and the operator payout flow.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `spon-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let anon: ReturnType<typeof request>;
// barber ↔ nails (P1) and barber ↔ mechanic (P2): all different sub-
// categories, all within a mile, so both pacts pass the firewall.
let barberId: number;
let nailsId: number;
let mechanicId: number;
let allIds: number[] = [];
let p1Id: number; // barber ↔ nails, carries revenue-share terms later
let p2Id: number; // barber ↔ mechanic, wins the confirmation auction

const settingsRow = (tenantId: number, coopSubCategory: string, lat: string, lng: string) => ({
  tenantId,
  coopSubCategory,
  businessCategory: `SPON-${RUN}`,
  addressLocality: "Riverside",
  latitude: lat,
  longitude: lng,
});

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  anon = request(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Spon Barber ${RUN}`, subdomain: `${RUN}-barber`, status: "active" },
      { brandName: `Spon Nails ${RUN}`, subdomain: `${RUN}-nails`, status: "active" },
      { brandName: `Spon Mechanic ${RUN}`, subdomain: `${RUN}-mechanic`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [barberId, nailsId, mechanicId] = tenants.map((t) => t.id);
  allIds = tenants.map((t) => t.id);

  await db.insert(sosSettingsTable).values([
    settingsRow(barberId, "barbershop", "40.7128", "-74.0060"),
    settingsRow(nailsId, "nail-salon", "40.7150", "-74.0080"),
    settingsRow(mechanicId, "mechanic-shop", "40.7130", "-74.0050"),
  ]);

  const mkPartnership = async (partnerTenantId: number, title: string) => {
    const res = await agent
      .post("/api/coop/partnerships")
      .send({
        hostTenantId: barberId,
        partnerTenantId,
        perkTitle: title,
      })
      .expect(201);
    return res.body.id as number;
  };
  p1Id = await mkPartnership(nailsId, `Free polish ${RUN}`);
  p2Id = await mkPartnership(mechanicId, `Free oil check ${RUN}`);

  // Pin the platform fee so split math is deterministic.
  await agent.patch("/api/admin/coop/fee").send({ feePercent: 10 }).expect(200);
});

afterAll(async () => {
  const ids = allIds.filter((n) => Number.isInteger(n));
  if (ids.length) {
    // Cascades clean up settings, partnerships, boosts, and wallet entries.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

const wallet = async (tenantId: number) => {
  const res = await agent
    .get("/api/coop/wallet")
    .set("x-tenant-id", String(tenantId))
    .expect(200);
  return res.body as {
    balance: number;
    lifetimeEarnings: number;
    totalFees: number;
    entries: { entryType: string; amount: number; fee: number; status: string; redemptionId: number | null }[];
  };
};

describe("session protection", () => {
  it("rejects anonymous access to sponsorship and wallet endpoints", async () => {
    await anon.get("/api/coop/wallet").set("x-tenant-id", String(barberId)).expect(401);
    await anon
      .get("/api/coop/sponsorship/boosts")
      .set("x-tenant-id", String(barberId))
      .expect(401);
    await anon.get("/api/admin/coop/wallets").expect(401);
  });
});

describe("flat boost purchase and featured directory placement", () => {
  it("activates a flat purchase immediately, charges the wallet, and features the sponsor in the directory", async () => {
    const now = Date.now();
    const res = await agent
      .post("/api/coop/sponsorship/boosts")
      .set("x-tenant-id", String(barberId))
      .send({
        partnershipId: p1Id,
        surface: "discovery",
        pricingType: "flat",
        amount: 12.5,
        startsAt: new Date(now - 60_000).toISOString(),
        endsAt: new Date(now + 60 * 60_000).toISOString(),
      })
      .expect(201);
    expect(res.body.status).toBe("active");
    expect(res.body.pricingType).toBe("flat");

    const w = await wallet(barberId);
    const charge = w.entries.find((e) => e.entryType === "boost_purchase");
    expect(charge).toBeTruthy();
    expect(charge!.amount).toBe(-12.5);

    // The sponsor renders featured — and above organic matches — for peers.
    const dir = await agent
      .get("/api/coop/directory")
      .set("x-tenant-id", String(nailsId))
      .expect(200);
    const entries = (res => res)(dir.body as { id: number; featured: boolean }[]);
    const mine = entries.filter((e) => allIds.includes(e.id));
    const barberEntry = mine.find((e) => e.id === barberId);
    expect(barberEntry?.featured).toBe(true);
    expect(mine.findIndex((e) => e.id === barberId)).toBeLessThan(
      mine.findIndex((e) => e.id === mechanicId),
    );
    // Featured entries lead the whole listing.
    expect(entries.findIndex((e) => e.id === barberId)).toBe(
      entries.findIndex((e) => e.featured),
    );
  });

  it("rejects an overlapping flat purchase for the same surface with 409", async () => {
    const now = Date.now();
    await agent
      .post("/api/coop/sponsorship/boosts")
      .set("x-tenant-id", String(mechanicId))
      .send({
        partnershipId: p2Id,
        surface: "discovery",
        pricingType: "flat",
        amount: 99,
        startsAt: new Date(now).toISOString(),
        endsAt: new Date(now + 30 * 60_000).toISOString(),
      })
      .expect(409);
  });

  it("rejects boosts on partnerships the tenant does not participate in", async () => {
    const now = Date.now();
    await agent
      .post("/api/coop/sponsorship/boosts")
      .set("x-tenant-id", String(nailsId))
      .send({
        partnershipId: p2Id, // barber ↔ mechanic
        surface: "discovery",
        pricingType: "flat",
        amount: 5,
        startsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
        endsAt: new Date(now + 3 * 60 * 60_000).toISOString(),
      })
      .expect(404);
  });

  it("activates a future-dated flat purchase at window start and expires it after the window", async () => {
    // Scheduled flat: charged at purchase, pending until the window opens.
    const start = new Date(Date.now() + 6 * 60 * 60_000); // +6h
    const end = new Date(start.getTime() + 60 * 60_000); // 1h window
    const created = await agent
      .post("/api/coop/sponsorship/boosts")
      .set("x-tenant-id", String(mechanicId))
      .send({
        partnershipId: p2Id,
        surface: "discovery",
        pricingType: "flat",
        amount: 12,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
      })
      .expect(201);
    expect(created.body.status).toBe("pending");

    // Before the window opens, the resolver leaves it pending.
    await resolveCoopBoosts(new Date(start.getTime() - 60_000));
    const statusOf = async (id: number) => {
      const list = await agent
        .get("/api/coop/sponsorship/boosts")
        .set("x-tenant-id", String(mechanicId))
        .expect(200);
      return list.body.find((b: { id: number }) => b.id === created.body.id)?.status;
    };
    expect(await statusOf(created.body.id)).toBe("pending");

    // At window start it activates (no second charge — flats pay at purchase).
    const activated = await resolveCoopBoosts(new Date(start.getTime() + 1000));
    expect(activated.boostsActivated).toBeGreaterThanOrEqual(1);
    expect(await statusOf(created.body.id)).toBe("active");
    const w = await wallet(mechanicId);
    expect(
      w.entries.filter((e) => e.entryType === "boost_purchase" && e.amount === -12),
    ).toHaveLength(1);

    // After the window it expires.
    await resolveCoopBoosts(new Date(end.getTime() + 1000));
    expect(await statusOf(created.body.id)).toBe("expired");
  });

  it("enforces slot exclusivity across pricing types and auction windows", async () => {
    const base = Date.now() + 24 * 60 * 60_000; // tomorrow, clear of other windows
    const iso = (t: number) => new Date(t).toISOString();
    const post = (tenantId: number, body: object) =>
      agent
        .post("/api/coop/sponsorship/boosts")
        .set("x-tenant-id", String(tenantId))
        .send({ partnershipId: tenantId === barberId ? p1Id : p2Id, surface: "discovery", ...body });

    // Reserve a flat window tomorrow 00:00–01:00 (relative). Mechanic pays:
    // wallet assertions elsewhere use find/filter shapes this doesn't disturb.
    await post(mechanicId, {
      pricingType: "flat",
      amount: 10,
      startsAt: iso(base),
      endsAt: iso(base + 60 * 60_000),
    }).expect(201);

    // A bid overlapping the pending flat reservation is rejected.
    await post(barberId, {
      pricingType: "bid",
      amount: 50,
      startsAt: iso(base + 30 * 60_000),
      endsAt: iso(base + 90 * 60_000),
    }).expect(409);

    // Open an auction in a free window (02:00–03:00).
    const auction = await post(mechanicId, {
      pricingType: "bid",
      amount: 15,
      startsAt: iso(base + 2 * 60 * 60_000),
      endsAt: iso(base + 3 * 60 * 60_000),
    }).expect(201);
    expect(auction.body.status).toBe("pending");

    // An exact-window competing bid joins the auction.
    await post(barberId, {
      pricingType: "bid",
      amount: 18,
      startsAt: iso(base + 2 * 60 * 60_000),
      endsAt: iso(base + 3 * 60 * 60_000),
    }).expect(201);

    // A different-but-overlapping bid window cannot coexist with the auction.
    await post(barberId, {
      pricingType: "bid",
      amount: 99,
      startsAt: iso(base + 2.5 * 60 * 60_000),
      endsAt: iso(base + 3.5 * 60 * 60_000),
    }).expect(409);

    // A flat purchase overlapping the pending auction is rejected too.
    await post(barberId, {
      pricingType: "flat",
      amount: 99,
      startsAt: iso(base + 2.5 * 60 * 60_000),
      endsAt: iso(base + 3.5 * 60 * 60_000),
    }).expect(409);
  });
});

describe("auction resolution and featured perk ordering", () => {
  // Near-now window: bids need a future start, but the rendering assertions
  // read real time — so the window opens a few seconds out and the test
  // waits for it before checking featured placement. Computed inside the
  // first test (not at collection time) so a slow parallel suite can't age
  // the start into the past before the bids are placed.
  let windowStart!: Date;
  let windowEnd!: Date;

  it("settles competing bids: highest wins, is charged, and the loser is marked lost", async () => {
    windowStart = new Date(Date.now() + 4_000);
    windowEnd = new Date(Date.now() + 2 * 60 * 60_000);
    // barber bids $20 on P1; mechanic bids $35 on P2 — same slot/window.
    const bid = (tenantId: number, partnershipId: number, amount: number) =>
      agent
        .post("/api/coop/sponsorship/boosts")
        .set("x-tenant-id", String(tenantId))
        .send({
          partnershipId,
          surface: "booking_confirmation",
          pricingType: "bid",
          amount,
          startsAt: windowStart.toISOString(),
          endsAt: windowEnd.toISOString(),
        })
        .expect(201);
    const low = await bid(barberId, p1Id, 20);
    const high = await bid(mechanicId, p2Id, 35);
    expect(low.body.status).toBe("pending");
    expect(high.body.status).toBe("pending");

    // Before the window starts nothing settles.
    await resolveCoopBoosts(new Date(windowStart.getTime() - 2000));
    let boosts = await agent
      .get("/api/coop/sponsorship/boosts")
      .set("x-tenant-id", String(mechanicId))
      .expect(200);
    expect(boosts.body.find((b: { id: number }) => b.id === high.body.id).status).toBe("pending");

    // Wait for the window to actually open (rendering reads real time).
    await new Promise((r) => setTimeout(r, Math.max(0, windowStart.getTime() - Date.now() + 500)));

    // At window start the auction settles: highest bid wins.
    const result = await resolveCoopBoosts(new Date(windowStart.getTime() + 1000));
    expect(result.auctionsSettled).toBeGreaterThanOrEqual(1);

    boosts = await agent
      .get("/api/coop/sponsorship/boosts")
      .set("x-tenant-id", String(mechanicId))
      .expect(200);
    expect(boosts.body.find((b: { id: number }) => b.id === high.body.id).status).toBe("active");
    const loser = await agent
      .get("/api/coop/sponsorship/boosts")
      .set("x-tenant-id", String(barberId))
      .expect(200);
    expect(loser.body.find((b: { id: number }) => b.id === low.body.id).status).toBe("lost");

    // Winner charged, loser not.
    const mw = await wallet(mechanicId);
    expect(mw.entries.find((e) => e.entryType === "boost_purchase")?.amount).toBe(-35);
    const bw = await wallet(barberId);
    const barberBoostCharges = bw.entries.filter((e) => e.entryType === "boost_purchase");
    expect(barberBoostCharges).toHaveLength(1); // only the flat discovery boost
  });

  it("renders the boosted perk featured and first on merchant perks and the public confirmation surface", async () => {
    // Defensive: the coop-tiers suite runs evaluateCoopPartnershipTiers with a
    // shifted "now + 40 days" clock, which performance-pauses any zero-traffic
    // accepted partnership across the whole DB — including these fresh ones
    // when the suites run in parallel. Clear any such pause before asserting
    // rendering, since pause semantics are not what this test verifies.
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ performancePausedAt: null })
      .where(inArray(merchantCoopPartnershipsTable.id, [p1Id, p2Id]));
    const perks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(barberId))
      .expect(200);
    const list = perks.body.perks as { id: number; featured: boolean }[];
    const p2 = list.find((p) => p.id === p2Id);
    const p1 = list.find((p) => p.id === p1Id);
    expect(p2?.featured).toBe(true);
    expect(p1?.featured).toBe(false);
    expect(list.findIndex((p) => p.id === p2Id)).toBeLessThan(list.findIndex((p) => p.id === p1Id));

    const pub = await anon.get(`/api/public/booking/${RUN}-barber/perks`).expect(200);
    const pubList = pub.body.perks as { id: number; featured: boolean }[];
    expect(pubList.find((p) => p.id === p2Id)?.featured).toBe(true);
    expect(pubList.findIndex((p) => p.id === p2Id)).toBeLessThan(
      pubList.findIndex((p) => p.id === p1Id),
    );
    await anon.get(`/api/public/booking/no-such-${RUN}/perks`).expect(404);
  });

  it("expires the boost after its window and falls back to organic placement", async () => {
    // Same defensive unpause as above (see coop-tiers shifted-clock note).
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ performancePausedAt: null })
      .where(inArray(merchantCoopPartnershipsTable.id, [p1Id, p2Id]));
    const result = await resolveCoopBoosts(new Date(windowEnd.getTime() + 1000));
    expect(result.boostsExpired).toBeGreaterThanOrEqual(1);
    const perks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(barberId))
      .expect(200);
    for (const p of perks.body.perks as { featured: boolean }[]) {
      expect(p.featured).toBe(false);
    }
  });
});

describe("revenue-share split accounting", () => {
  it("validates revenue-share terms on the partnership", async () => {
    await agent
      .patch(`/api/coop/partnerships/${p1Id}`)
      .set("x-tenant-id", String(barberId))
      .send({ revenueShareKind: "percent", revenueShareValue: 20 })
      .expect(400); // percent requires a base amount
    await agent
      .patch(`/api/coop/partnerships/${p1Id}`)
      .set("x-tenant-id", String(barberId))
      .send({ revenueShareKind: "bounty", revenueShareValue: -3 })
      .expect(400);
  });

  it("splits a percent-based share on redemption, net of the platform fee, atomically on both sides", async () => {
    const set = await agent
      .patch(`/api/coop/partnerships/${p1Id}`)
      .set("x-tenant-id", String(barberId))
      .send({ revenueShareKind: "percent", revenueShareValue: 20, revenueShareBaseAmount: 50 })
      .expect(200);
    expect(set.body.revenueShareKind).toBe("percent");

    const code = (
      await db
        .select({ code: merchantCoopPartnershipsTable.redemptionCode })
        .from(merchantCoopPartnershipsTable)
        .where(inArray(merchantCoopPartnershipsTable.id, [p1Id]))
    )[0].code;

    // barber redeems a nails-referred pass → nails earns 20% of $50 = $10
    // gross, minus 10% fee = $9 net; barber is charged the $10 gross.
    const res = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(barberId))
      .send({ code, passCode: `${RUN}-pass-1` })
      .expect(200);
    expect(res.body.valid).toBe(true);

    const earner = await wallet(nailsId);
    const earning = earner.entries.find((e) => e.entryType === "redemption_earning");
    expect(earning?.amount).toBe(9);
    expect(earning?.fee).toBe(1);
    expect(earner.balance).toBe(9);

    const payer = await wallet(barberId);
    const charge = payer.entries.find((e) => e.entryType === "redemption_charge");
    expect(charge?.amount).toBe(-10);
    // Earning and charge reference the same redemption.
    expect(charge?.redemptionId).toBe(earning?.redemptionId);
  });

  it("pays a flat referral bounty per redemption", async () => {
    await agent
      .patch(`/api/coop/partnerships/${p1Id}`)
      .set("x-tenant-id", String(barberId))
      .send({ revenueShareKind: "bounty", revenueShareValue: 8 })
      .expect(200);
    const code = (
      await db
        .select({ code: merchantCoopPartnershipsTable.redemptionCode })
        .from(merchantCoopPartnershipsTable)
        .where(inArray(merchantCoopPartnershipsTable.id, [p1Id]))
    )[0].code;
    await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(barberId))
      .send({ code, passCode: `${RUN}-pass-2` })
      .expect(200);
    const earner = await wallet(nailsId);
    const bounty = earner.entries.filter((e) => e.entryType === "redemption_earning");
    expect(bounty.some((e) => e.amount === 7.2 && e.fee === 0.8)).toBe(true);
    expect(earner.balance).toBeCloseTo(16.2, 2);
  });

  it("writes no split entries for a double-scan of the same pass", async () => {
    const code = (
      await db
        .select({ code: merchantCoopPartnershipsTable.redemptionCode })
        .from(merchantCoopPartnershipsTable)
        .where(inArray(merchantCoopPartnershipsTable.id, [p1Id]))
    )[0].code;
    await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(barberId))
      .send({ code, passCode: `${RUN}-pass-2` })
      .expect(200); // valid:false — already redeemed
    const earner = await wallet(nailsId);
    expect(earner.entries.filter((e) => e.entryType === "redemption_earning")).toHaveLength(2);
  });
});

describe("operator payout console", () => {
  it("shows per-tenant balances and the configured fee", async () => {
    const res = await agent.get("/api/admin/coop/wallets").expect(200);
    expect(res.body.feePercent).toBe(10);
    const nails = res.body.wallets.find(
      (w: { tenantId: number }) => w.tenantId === nailsId,
    );
    expect(nails.pendingBalance).toBeCloseTo(16.2, 2);
    expect(nails.totalFees).toBeCloseTo(1.8, 2);
  });

  it("marks a payout processed: pending entries flip, a payout entry lands, and a re-run 409s", async () => {
    const res = await agent.post(`/api/admin/coop/wallets/${nailsId}/payouts`).expect(201);
    expect(res.body.amountPaid).toBeCloseTo(16.2, 2);
    expect(res.body.entriesMarked).toBe(2);

    const w = await wallet(nailsId);
    expect(w.balance).toBe(0);
    const payout = w.entries.find((e) => e.entryType === "payout");
    expect(payout?.amount).toBeCloseTo(-16.2, 2);
    expect(payout?.status).toBe("paid_out");
    expect(w.entries.every((e) => e.status === "paid_out")).toBe(true);

    await agent.post(`/api/admin/coop/wallets/${nailsId}/payouts`).expect(409);
    await agent.post(`/api/admin/coop/wallets/999999999/payouts`).expect(404);
  });

  it("updates the platform fee within bounds only", async () => {
    await agent.patch("/api/admin/coop/fee").send({ feePercent: 150 }).expect(400);
    await agent.patch("/api/admin/coop/fee").send({ feePercent: 10 }).expect(200);
  });
});

describe("machine redemption channels (POS webhook / gateway API)", () => {
  it("applies the revenue-share split through the shared wallet-pass path", async () => {
    // p1 still carries the bounty terms ($8, 10% fee) set earlier. A wallet
    // pass redeemed via the shared machine path (used by POS webhooks and the
    // gateway API) must produce the exact same ledger entries as the native
    // /coop/redemptions route.
    const token = `WPASS-${RUN}-machine-1`;
    await db.insert(perkPassesTable).values({
      partnershipId: p1Id,
      grantedByTenantId: nailsId,
      customerPhone: "+15558881234",
      token,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

    const result = await redeemWalletPassAsTenant(barberId, token);
    expect(result.status).toBe("processed");

    const earner = await wallet(nailsId);
    const earning = earner.entries.find(
      (e) => e.entryType === "redemption_earning" && e.status === "pending",
    );
    expect(earning?.amount).toBeCloseTo(7.2, 2);
    expect(earning?.fee).toBeCloseTo(0.8, 2);

    const payer = await wallet(barberId);
    const charge = payer.entries.find(
      (e) => e.entryType === "redemption_charge" && e.redemptionId === earning?.redemptionId,
    );
    expect(charge?.amount).toBeCloseTo(-8, 2);

    // Replay through the machine path is a no-op: no duplicate split entries.
    const replay = await redeemWalletPassAsTenant(barberId, token);
    expect(replay.status).toBe("ignored");
    const after = await wallet(nailsId);
    expect(after.entries.filter((e) => e.entryType === "redemption_earning").length).toBe(
      earner.entries.filter((e) => e.entryType === "redemption_earning").length,
    );
  });
});
