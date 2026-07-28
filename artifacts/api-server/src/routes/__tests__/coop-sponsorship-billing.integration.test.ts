import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { vi } from "vitest";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  coopFeaturedBoostsTable,
  coopWalletEntriesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-Op Sponsorship boost billing — real Stripe charges with a simulated
// fallback, against the real dev DB with Stripe mocked at the client boundary.
//
// Contract under guard:
//   - Live flat purchase: charged (immediate-capture PaymentIntent) before
//     activation; a declined charge blocks the boost entirely (402, no row,
//     no wallet entry) and frees the slot.
//   - Live auction bid: a manual-capture hold is placed at bid time; at
//     resolution the winner's hold is captured and every loser's hold is
//     released — losers are never charged.
//   - Transient capture failures keep the winner pending with retry
//     bookkeeping; the concierge-swept retry captures and activates later.
//   - Permanent capture failures mark the boost lost without charging.
//   - Simulated fallback (test default): behaves exactly as before, with
//     wallet entries labeled SIMULATED.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;

type PiCall = { params: Record<string, unknown>; options?: Record<string, unknown> };
const createCalls: PiCall[] = [];
const captureCalls: string[] = [];
const cancelCalls: string[] = [];
// Status-driven behavior: "ok" resolves to the correct success status for the
// requested capture_method (succeeded for immediate, requires_capture for
// manual holds). Explicit statuses simulate non-success PaymentIntent states
// (SCA challenges, async processing) without a thrown error.
let createBehavior:
  | "ok"
  | "card_error"
  | "api_error"
  | "status:requires_action"
  | "status:processing" = "ok";
let captureBehavior: "ok" | "card_error" | "api_error" | "status:processing" = "ok";
let cancelBehavior: "ok" | "api_error" = "ok";
// Whether the sponsor tenant has a Stripe customer + card on file.
let cardOnFile = true;
let piCounter = 0;

function stripeErr(type: string, message: string) {
  const err = new Error(message) as Error & { type: string };
  err.type = type;
  return err;
}

vi.mock("../../lib/stripeClient", () => ({
  isStripeConfigured: () => true,
  getUncachableStripeClient: async () => ({
    customers: {
      search: async () => ({ data: cardOnFile ? [{ id: "cus_test_sponsor" }] : [] }),
      list: async () => ({ data: [] }),
      retrieve: async (id: string) => ({
        id,
        invoice_settings: { default_payment_method: "pm_test_card" },
      }),
    },
    paymentMethods: {
      list: async () => ({ data: [{ id: "pm_test_card" }] }),
    },
    paymentIntents: {
      create: async (params: Record<string, unknown>, options?: Record<string, unknown>) => {
        if (createBehavior === "card_error") throw stripeErr("StripeCardError", "Your card was declined.");
        if (createBehavior === "api_error") throw stripeErr("StripeAPIError", "Stripe is temporarily unavailable");
        createCalls.push({ params, options });
        const status =
          createBehavior === "ok"
            ? params.capture_method === "manual"
              ? "requires_capture"
              : "succeeded"
            : createBehavior.slice("status:".length);
        return { id: `pi_test_${Date.now()}_${piCounter++}`, status };
      },
      capture: async (id: string) => {
        if (captureBehavior === "card_error") throw stripeErr("StripeCardError", "Your card was declined at capture.");
        if (captureBehavior === "api_error") throw stripeErr("StripeAPIError", "Stripe is temporarily unavailable");
        if (captureBehavior === "status:processing") return { id, status: "processing" };
        captureCalls.push(id);
        return { id, status: "succeeded" };
      },
      cancel: async (id: string) => {
        if (cancelBehavior === "api_error") throw stripeErr("StripeAPIError", "Stripe is temporarily unavailable");
        cancelCalls.push(id);
        return { id, status: "canceled" };
      },
    },
  }),
  getStripeSync: async () => {
    throw new Error("not used in this test");
  },
}));

import {
  __setLiveBoostChargesForTests,
  resolveCoopBoosts,
  sweepBoostChargeRetries,
} from "../../lib/coopSponsorship";

const RUN = `sponbill-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let hostId: number;
let partnerAId: number;
let partnerBId: number;
let allIds: number[] = [];
let pAId: number; // host ↔ partnerA
let pBId: number; // host ↔ partnerB

const settingsRow = (tenantId: number, coopSubCategory: string, lat: string, lng: string) => ({
  tenantId,
  coopSubCategory,
  businessCategory: `SPONBILL-${RUN}`,
  addressLocality: "Riverside",
  latitude: lat,
  longitude: lng,
});

// Each test uses its own far-future window slice so slots never collide with
// other suites (and windows within this suite don't overlap each other).
let windowCursor = new Date("2094-06-01T00:00:00Z").getTime();
function freshWindow(hours = 1): { startsAt: Date; endsAt: Date } {
  const startsAt = new Date(windowCursor);
  const endsAt = new Date(windowCursor + hours * 60 * 60_000);
  windowCursor = endsAt.getTime() + 60 * 60_000;
  return { startsAt, endsAt };
}

const postBoost = (tenantId: number, body: Record<string, unknown>) =>
  agent.post("/api/coop/sponsorship/boosts").set("x-tenant-id", String(tenantId)).send(body);

const boostRow = async (id: number) => {
  const [row] = await db
    .select()
    .from(coopFeaturedBoostsTable)
    .where(eq(coopFeaturedBoostsTable.id, id));
  return row;
};

const walletEntriesForBoost = (boostId: number) =>
  db.select().from(coopWalletEntriesTable).where(eq(coopWalletEntriesTable.boostId, boostId));

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Bill Host ${RUN}`, subdomain: `${RUN}-host`, status: "active" },
      { brandName: `Bill A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `Bill B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [hostId, partnerAId, partnerBId] = tenants.map((t) => t.id);
  allIds = tenants.map((t) => t.id);

  await db.insert(sosSettingsTable).values([
    settingsRow(hostId, "barbershop", "40.7128", "-74.0060"),
    settingsRow(partnerAId, "nail-salon", "40.7150", "-74.0080"),
    settingsRow(partnerBId, "mechanic-shop", "40.7130", "-74.0050"),
  ]);

  const mkPartnership = async (partnerTenantId: number, title: string) => {
    const res = await agent
      .post("/api/coop/partnerships")
      .send({ hostTenantId: hostId, partnerTenantId, perkTitle: title })
      .expect(201);
    return res.body.id as number;
  };
  pAId = await mkPartnership(partnerAId, `Bill perk A ${RUN}`);
  pBId = await mkPartnership(partnerBId, `Bill perk B ${RUN}`);

  // Pin the shared platform fee row per sponsorship test convention.
  await agent.patch("/api/admin/coop/fee").send({ feePercent: 10 }).expect(200);
});

afterAll(async () => {
  const ids = allIds.filter((n) => Number.isInteger(n));
  if (ids.length) {
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

afterEach(() => {
  __setLiveBoostChargesForTests(null);
  createBehavior = "ok";
  captureBehavior = "ok";
  cancelBehavior = "ok";
  cardOnFile = true;
  createCalls.length = 0;
  captureCalls.length = 0;
  cancelCalls.length = 0;
});

describe("simulated fallback (Stripe not live — test default)", () => {
  it("purchases a flat boost with no Stripe call and a SIMULATED-labeled wallet entry", async () => {
    const { startsAt, endsAt } = freshWindow();
    const res = await postBoost(hostId, {
      partnershipId: pAId,
      surface: "discovery",
      pricingType: "flat",
      amount: 10,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(201);
    expect(res.body.paymentMode).toBe("simulated");
    expect(res.body.paymentRef).toBeNull();
    expect(createCalls.length).toBe(0);
    const entries = await walletEntriesForBoost(res.body.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toContain("SIMULATED (no real charge)");
  });
});

describe("live flat boost purchases", () => {
  it("charges the sponsor's card before activation and records the payment reference", async () => {
    __setLiveBoostChargesForTests(true);
    const { startsAt, endsAt } = freshWindow();
    const res = await postBoost(hostId, {
      partnershipId: pAId,
      surface: "discovery",
      pricingType: "flat",
      amount: 25.5,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(201);
    expect(res.body.paymentMode).toBe("stripe");
    expect(res.body.paymentRef).toMatch(/^pi_test_/);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].params.amount).toBe(2550);
    expect(createCalls[0].params.capture_method).toBeUndefined(); // immediate capture
    // Off-session charge against the sponsor's saved card on file.
    expect(createCalls[0].params.customer).toBe("cus_test_sponsor");
    expect(createCalls[0].params.payment_method).toBe("pm_test_card");
    expect(createCalls[0].params.off_session).toBe(true);
    expect(createCalls[0].options?.idempotencyKey).toBe(`coop-boost-charge-${res.body.id}`);
    const entries = await walletEntriesForBoost(res.body.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe("-25.50");
    expect(entries[0].description).toContain(`paid via Stripe (${res.body.paymentRef})`);
  });

  it("blocks activation on a declined charge: 402, no boost row, no wallet entry, slot freed", async () => {
    __setLiveBoostChargesForTests(true);
    createBehavior = "card_error";
    const { startsAt, endsAt } = freshWindow();
    const body = {
      partnershipId: pAId,
      surface: "discovery",
      pricingType: "flat",
      amount: 30,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    };
    const res = await postBoost(hostId, body).expect(402);
    expect(res.body.message).toContain("could not be charged");
    // No orphan boost or wallet entry for this window.
    const rows = await db
      .select()
      .from(coopFeaturedBoostsTable)
      .where(eq(coopFeaturedBoostsTable.startsAt, startsAt));
    expect(rows.filter((r) => allIds.includes(r.tenantId))).toHaveLength(0);
    // The slot is free again: the same window succeeds once the card works.
    createBehavior = "ok";
    await postBoost(hostId, body).expect(201);
  });

  it("rejects a sponsor with no card on file (402, no boost row)", async () => {
    __setLiveBoostChargesForTests(true);
    cardOnFile = false;
    const { startsAt, endsAt } = freshWindow();
    const res = await postBoost(hostId, {
      partnershipId: pAId,
      surface: "discovery",
      pricingType: "flat",
      amount: 12,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(402);
    expect(res.body.message).toContain("No card on file");
    const rows = await db
      .select()
      .from(coopFeaturedBoostsTable)
      .where(eq(coopFeaturedBoostsTable.startsAt, startsAt));
    expect(rows.filter((r) => allIds.includes(r.tenantId))).toHaveLength(0);
    expect(createCalls).toHaveLength(0); // never even attempted a charge
  });

  it("does not activate on a non-succeeded PaymentIntent (SCA required off-session)", async () => {
    __setLiveBoostChargesForTests(true);
    createBehavior = "status:requires_action";
    const { startsAt, endsAt } = freshWindow();
    const res = await postBoost(hostId, {
      partnershipId: pAId,
      surface: "discovery",
      pricingType: "flat",
      amount: 12,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(402);
    expect(res.body.message).toContain("requires_action");
    const rows = await db
      .select()
      .from(coopFeaturedBoostsTable)
      .where(eq(coopFeaturedBoostsTable.startsAt, startsAt));
    expect(rows.filter((r) => allIds.includes(r.tenantId))).toHaveLength(0);
  });

  it("does not activate on a still-processing PaymentIntent", async () => {
    __setLiveBoostChargesForTests(true);
    createBehavior = "status:processing";
    const { startsAt, endsAt } = freshWindow();
    const res = await postBoost(hostId, {
      partnershipId: pAId,
      surface: "discovery",
      pricingType: "flat",
      amount: 12,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(402);
    expect(res.body.message).toContain("processing");
  });
});

describe("live auction bids: hold at bid, capture winner, release losers", () => {
  it("places a manual-capture hold at bid time", async () => {
    __setLiveBoostChargesForTests(true);
    const { startsAt, endsAt } = freshWindow();
    const res = await postBoost(hostId, {
      partnershipId: pAId,
      surface: "booking_confirmation",
      pricingType: "bid",
      amount: 15,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(201);
    expect(res.body.status).toBe("pending");
    expect(res.body.paymentMode).toBe("stripe");
    expect(res.body.paymentRef).toMatch(/^pi_test_/);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].params.capture_method).toBe("manual");
    expect(createCalls[0].params.customer).toBe("cus_test_sponsor");
    expect(createCalls[0].params.payment_method).toBe("pm_test_card");
    expect(createCalls[0].options?.idempotencyKey).toBe(`coop-boost-hold-${res.body.id}`);
    // No wallet charge at bid time.
    expect(await walletEntriesForBoost(res.body.id)).toHaveLength(0);
  });

  it("rejects a bid whose hold does not reach a capturable state", async () => {
    __setLiveBoostChargesForTests(true);
    createBehavior = "status:processing"; // authorized-but-not-capturable is not enough
    const { startsAt, endsAt } = freshWindow();
    const res = await postBoost(hostId, {
      partnershipId: pAId,
      surface: "booking_confirmation",
      pricingType: "bid",
      amount: 15,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(402);
    expect(res.body.message).toContain("processing");
    const rows = await db
      .select()
      .from(coopFeaturedBoostsTable)
      .where(eq(coopFeaturedBoostsTable.startsAt, startsAt));
    expect(rows.filter((r) => allIds.includes(r.tenantId))).toHaveLength(0);
  });

  it("rejects a bid whose card hold is declined (402, no bid row)", async () => {
    __setLiveBoostChargesForTests(true);
    createBehavior = "card_error";
    const { startsAt, endsAt } = freshWindow();
    const res = await postBoost(hostId, {
      partnershipId: pAId,
      surface: "booking_confirmation",
      pricingType: "bid",
      amount: 15,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(402);
    expect(res.body.message).toContain("card hold");
    const rows = await db
      .select()
      .from(coopFeaturedBoostsTable)
      .where(eq(coopFeaturedBoostsTable.startsAt, startsAt));
    expect(rows.filter((r) => allIds.includes(r.tenantId))).toHaveLength(0);
  });

  it("captures the winner's hold and releases the loser's hold at resolution — the loser is never charged", async () => {
    __setLiveBoostChargesForTests(true);
    const { startsAt, endsAt } = freshWindow();
    const win = await postBoost(hostId, {
      partnershipId: pAId,
      surface: "booking_confirmation",
      pricingType: "bid",
      amount: 40,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(201);
    const lose = await postBoost(hostId, {
      partnershipId: pBId,
      surface: "booking_confirmation",
      pricingType: "bid",
      amount: 22,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(201);

    // Resolve mid-window (holds already placed; live gate only affects new charges).
    await resolveCoopBoosts(new Date(startsAt.getTime() + 60_000));

    const winner = await boostRow(win.body.id);
    const loser = await boostRow(lose.body.id);
    expect(winner.status).toBe("active");
    expect(loser.status).toBe("lost");
    expect(captureCalls).toEqual([win.body.paymentRef]);
    // The resolver may also release stale pending bids from earlier windows
    // in this run — the loser's hold must be among the releases, and the
    // winner's must not.
    expect(cancelCalls).toContain(lose.body.paymentRef);
    expect(cancelCalls).not.toContain(win.body.paymentRef);
    const winnerEntries = await walletEntriesForBoost(win.body.id);
    expect(winnerEntries).toHaveLength(1);
    expect(winnerEntries[0].description).toContain(`paid via Stripe (${win.body.paymentRef})`);
    expect(await walletEntriesForBoost(lose.body.id)).toHaveLength(0);
  });

  it("marks the winner lost on a permanent capture failure — never activated, never charged", async () => {
    __setLiveBoostChargesForTests(true);
    const { startsAt, endsAt } = freshWindow();
    const win = await postBoost(hostId, {
      partnershipId: pAId,
      surface: "booking_confirmation",
      pricingType: "bid",
      amount: 18,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(201);

    captureBehavior = "card_error";
    await resolveCoopBoosts(new Date(startsAt.getTime() + 60_000));

    const row = await boostRow(win.body.id);
    expect(row.status).toBe("lost");
    expect(row.paymentFailureReason).toContain("FAILED permanently");
    expect(row.retryOperation).toBeNull();
    expect(await walletEntriesForBoost(win.body.id)).toHaveLength(0);
  });

  it("retries a transient capture failure via the sweep and activates once it succeeds", async () => {
    __setLiveBoostChargesForTests(true);
    const { startsAt, endsAt } = freshWindow(4);
    const win = await postBoost(hostId, {
      partnershipId: pAId,
      surface: "booking_confirmation",
      pricingType: "bid",
      amount: 33,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(201);

    captureBehavior = "api_error";
    const resolveAt = new Date(startsAt.getTime() + 60_000);
    await resolveCoopBoosts(resolveAt);

    let row = await boostRow(win.body.id);
    expect(row.status).toBe("pending"); // still pending — capture will be retried
    expect(row.retryOperation).toBe("capture");
    expect(row.retryAttempts).toBe(1);
    expect(row.nextRetryAt).not.toBeNull();
    expect(await walletEntriesForBoost(win.body.id)).toHaveLength(0);

    // Not due yet: the sweep skips it.
    expect(await sweepBoostChargeRetries(resolveAt)).toBe(0);

    // Stripe recovers; the concierge-pattern sweep captures and activates.
    captureBehavior = "ok";
    const retryAt = new Date(row.nextRetryAt!.getTime() + 1_000);
    expect(await sweepBoostChargeRetries(retryAt)).toBe(1);

    row = await boostRow(win.body.id);
    expect(row.status).toBe("active");
    expect(row.retryOperation).toBeNull();
    expect(row.nextRetryAt).toBeNull();
    expect(row.paymentFailureReason).toBeNull();
    expect(captureCalls).toEqual([win.body.paymentRef]);
    const entries = await walletEntriesForBoost(win.body.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toContain(`paid via Stripe (${win.body.paymentRef})`);
  });

  it("treats a capture that does not reach succeeded as transient — never activates on it", async () => {
    __setLiveBoostChargesForTests(true);
    const { startsAt, endsAt } = freshWindow(4);
    const win = await postBoost(hostId, {
      partnershipId: pAId,
      surface: "booking_confirmation",
      pricingType: "bid",
      amount: 27,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(201);

    captureBehavior = "status:processing"; // Stripe accepted the call but the PI is not succeeded
    await resolveCoopBoosts(new Date(startsAt.getTime() + 60_000));

    const row = await boostRow(win.body.id);
    expect(row.status).toBe("pending");
    expect(row.retryOperation).toBe("capture");
    expect(row.paymentFailureReason).toContain("did not complete");
    expect(await walletEntriesForBoost(win.body.id)).toHaveLength(0);

    // Cleanup so later resolves in this file don't pick this row up: let the
    // sweep succeed once Stripe reports a terminal capture.
    captureBehavior = "ok";
    await sweepBoostChargeRetries(new Date(row.nextRetryAt!.getTime() + 1_000));
    expect((await boostRow(win.body.id)).status).toBe("active");
  });

  it("schedules a retry when a loser's hold release fails transiently, then releases via the sweep", async () => {
    __setLiveBoostChargesForTests(true);
    const { startsAt, endsAt } = freshWindow();
    const win = await postBoost(hostId, {
      partnershipId: pAId,
      surface: "booking_confirmation",
      pricingType: "bid",
      amount: 50,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(201);
    const lose = await postBoost(hostId, {
      partnershipId: pBId,
      surface: "booking_confirmation",
      pricingType: "bid",
      amount: 20,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }).expect(201);

    cancelBehavior = "api_error";
    await resolveCoopBoosts(new Date(startsAt.getTime() + 60_000));

    let loser = await boostRow(lose.body.id);
    expect(loser.status).toBe("lost");
    expect(loser.retryOperation).toBe("release");

    cancelBehavior = "ok";
    const retryAt = new Date(loser.nextRetryAt!.getTime() + 1_000);
    expect(await sweepBoostChargeRetries(retryAt)).toBe(1);
    loser = await boostRow(lose.body.id);
    expect(loser.retryOperation).toBeNull();
    expect(loser.paymentFailureReason).toBeNull();
    expect(cancelCalls).toEqual([lose.body.paymentRef]);
    // The winner was unaffected and charged exactly once.
    expect(await walletEntriesForBoost(win.body.id)).toHaveLength(1);
    expect(await walletEntriesForBoost(lose.body.id)).toHaveLength(0);
  });
});

describe("admin reconciliation view", () => {
  it("reports per-tenant real vs simulated boost charge counts", async () => {
    const res = await agent.get("/api/admin/coop/wallets").expect(200);
    const row = (res.body.wallets as {
      tenantId: number;
      stripeBoostCharges: number;
      simulatedBoostCharges: number;
    }[]).find((w) => w.tenantId === hostId);
    expect(row).toBeTruthy();
    // Earlier tests charged this suite's host both ways.
    expect(row!.stripeBoostCharges).toBeGreaterThan(0);
    expect(row!.simulatedBoostCharges).toBeGreaterThan(0);
  });
});
