import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  merchantCoopPartnershipsTable,
  coopTrafficEventsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-Op cross-promotion Traffic & Value Ledger: event recording attribution
// (correct partnership + direction) from landing-page impressions, perk-link
// clicks, and redemption-code validations; tenant scoping of /coop/ledger;
// reciprocity-threshold flag math; the re-negotiation propose/accept/decline
// flow; and tenant-side pause/resume hiding perks everywhere.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `coopledger-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let cafeId: number;
let gymId: number;
let bakeryId: number; // bystander — never a party to the cafe↔gym pact
let partnershipId: number;
let redemptionCode: string;

const events = (pid: number) =>
  db.select().from(coopTrafficEventsTable).where(eq(coopTrafficEventsTable.partnershipId, pid));

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
      { brandName: `Ledger Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Ledger Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
      { brandName: `Ledger Bakery ${RUN}`, subdomain: `${RUN}-bakery`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [cafeId, gymId, bakeryId] = tenants.map((t) => t.id);

  await db.insert(sosSettingsTable).values([
    { tenantId: cafeId, industryType: "restaurant", businessCategory: `Cafe-${RUN}` },
    { tenantId: gymId, industryType: "fitness", businessCategory: `Gym-${RUN}` },
    { tenantId: bakeryId, industryType: "bakery", businessCategory: `Bakery-${RUN}` },
  ]);

  // Accepted, active cafe↔gym partnership via the invite flow.
  const invite = await agent
    .post("/api/coop/invites")
    .set("x-tenant-id", String(cafeId))
    .send({ partnerTenantId: gymId, perkTitle: `Free espresso ${RUN}` })
    .expect(201);
  partnershipId = invite.body.id;
  redemptionCode = invite.body.redemptionCode;
  await agent
    .post(`/api/coop/invites/${partnershipId}/respond`)
    .set("x-tenant-id", String(gymId))
    .send({ action: "accept" })
    .expect(200);
});

afterAll(async () => {
  const ids = [cafeId, gymId, bakeryId].filter((n) => Number.isInteger(n));
  if (ids.length) {
    // Cascades clean up settings, partnerships, and traffic events.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

describe("traffic event recording & attribution", () => {
  it("landing perks JSON records an impression: outbound from the page owner, inbound for the partner", async () => {
    const before = (await events(partnershipId)).length;
    const res = await agent.get(`/api/public/landing/${RUN}-cafe/perks`).expect(200);
    expect(res.body.perks.some((p: { perkTitle: string }) => p.perkTitle === `Free espresso ${RUN}`)).toBe(true);
    const after = await events(partnershipId);
    expect(after.length).toBe(before + 1);
    const ev = after[after.length - 1];
    expect(ev.eventType).toBe("perk_impression");
    // Cafe's page promotes the gym → gym receives the exposure.
    expect(ev.receivingTenantId).toBe(gymId);
    expect(ev.sourceTenantId).toBe(cafeId);
  });

  it("the perk click-through redirects to the partner's landing page and records a perk_click", async () => {
    const res = await agent
      .get(`/api/public/landing/${RUN}-cafe/perks/${partnershipId}/visit`)
      .expect(302);
    expect(res.headers.location).toBe(`/api/public/landing/${RUN}-gym`);
    const rows = (await events(partnershipId)).filter((e) => e.eventType === "perk_click");
    expect(rows.length).toBe(1);
    expect(rows[0].receivingTenantId).toBe(gymId);
    expect(rows[0].sourceTenantId).toBe(cafeId);
  });

  it("click-through 404s (and records nothing) for a partnership the page owner is not in", async () => {
    const before = (await events(partnershipId)).length;
    await agent
      .get(`/api/public/landing/${RUN}-bakery/perks/${partnershipId}/visit`)
      .expect(404);
    expect((await events(partnershipId)).length).toBe(before);
  });

  it("code validation at checkout attributes inbound to the validating tenant", async () => {
    const res = await agent
      .get(`/api/coop/redemptions/${redemptionCode}`)
      .set("x-tenant-id", String(gymId))
      .expect(200);
    expect(res.body.valid).toBe(true);
    const rows = (await events(partnershipId)).filter((e) => e.eventType === "code_validation");
    expect(rows.length).toBe(1);
    // The customer arrived at the gym → inbound for the gym, from the cafe.
    expect(rows[0].receivingTenantId).toBe(gymId);
    expect(rows[0].sourceTenantId).toBe(cafeId);
  });

  it("unscoped or non-participant validation records no event", async () => {
    const before = (await events(partnershipId)).length;
    await agent.get(`/api/coop/redemptions/${redemptionCode}`).expect(200);
    await agent
      .get(`/api/coop/redemptions/${redemptionCode}`)
      .set("x-tenant-id", String(bakeryId))
      .expect(200);
    expect((await events(partnershipId)).length).toBe(before);
  });
});

describe("GET /coop/ledger — tenant scoping & math", () => {
  it("requires the x-tenant-id scope", async () => {
    await agent.get("/api/coop/ledger").expect(400);
  });

  it("mirrors inbound/outbound between the two parties and hides the pact from bystanders", async () => {
    const gymLedger = await agent
      .get("/api/coop/ledger")
      .set("x-tenant-id", String(gymId))
      .expect(200);
    const gymEntry = gymLedger.body.entries.find(
      (e: { partnershipId: number }) => e.partnershipId === partnershipId,
    );
    expect(gymEntry).toBeDefined();
    expect(gymEntry.partnerName).toBe(`Ledger Cafe ${RUN}`);
    // impression + click + validation all flowed toward the gym.
    expect(gymEntry.allTime.inbound).toBe(3);
    expect(gymEntry.allTime.outbound).toBe(0);
    expect(gymEntry.window.inbound).toBe(3);
    expect(gymEntry.disparityPercent).toBe(100);
    expect(gymEntry.ratio).toBeNull(); // outbound 0

    const cafeLedger = await agent
      .get("/api/coop/ledger")
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    const cafeEntry = cafeLedger.body.entries.find(
      (e: { partnershipId: number }) => e.partnershipId === partnershipId,
    );
    expect(cafeEntry.allTime.inbound).toBe(0);
    expect(cafeEntry.allTime.outbound).toBe(3);

    const bakeryLedger = await agent
      .get("/api/coop/ledger")
      .set("x-tenant-id", String(bakeryId))
      .expect(200);
    expect(
      bakeryLedger.body.entries.some(
        (e: { partnershipId: number }) => e.partnershipId === partnershipId,
      ),
    ).toBe(false);
  });

  it("windowDays narrows the recent window while all-time stays put", async () => {
    // An event 40 days old is outside any 30-day window but inside all-time.
    await db.insert(coopTrafficEventsTable).values({
      partnershipId,
      receivingTenantId: cafeId,
      sourceTenantId: gymId,
      eventType: "perk_impression",
      occurredAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });
    const res = await agent
      .get("/api/coop/ledger?windowDays=7")
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(res.body.windowDays).toBe(7);
    const entry = res.body.entries.find(
      (e: { partnershipId: number }) => e.partnershipId === partnershipId,
    );
    expect(entry.allTime.inbound).toBe(1);
    expect(entry.window.inbound).toBe(0);
  });

  it("flags only when the tenant's configured margin is breached within the evaluation window", async () => {
    // No margin configured → never flagged, even at 100% disparity.
    const unflagged = await agent
      .get("/api/coop/ledger")
      .set("x-tenant-id", String(gymId))
      .expect(200);
    expect(
      unflagged.body.entries.find(
        (e: { partnershipId: number }) => e.partnershipId === partnershipId,
      ).flagged,
    ).toBe(false);

    // Gym sets a 50% margin: inbound 3 / outbound 0 → disparity 100% > 50%.
    await agent
      .patch(`/api/tenants/${gymId}/settings`)
      .send({ coopReciprocityMarginPercent: 50, coopReciprocityWindowDays: 30 })
      .expect(200);
    const flagged = await agent
      .get("/api/coop/ledger")
      .set("x-tenant-id", String(gymId))
      .expect(200);
    expect(flagged.body.marginPercent).toBe(50);
    expect(
      flagged.body.entries.find(
        (e: { partnershipId: number }) => e.partnershipId === partnershipId,
      ).flagged,
    ).toBe(true);

    // A wide-open margin (100%) is not breached by 100% disparity (> not ≥)…
    await agent
      .patch(`/api/tenants/${gymId}/settings`)
      .send({ coopReciprocityMarginPercent: 100 })
      .expect(200);
    const atLimit = await agent
      .get("/api/coop/ledger")
      .set("x-tenant-id", String(gymId))
      .expect(200);
    expect(
      atLimit.body.entries.find(
        (e: { partnershipId: number }) => e.partnershipId === partnershipId,
      ).flagged,
    ).toBe(false);
  });
});

describe("re-negotiation flow", () => {
  it("staging a proposal does not change live terms; only the other party may respond", async () => {
    const proposed = await agent
      .post(`/api/coop/partnerships/${partnershipId}/renegotiate`)
      .set("x-tenant-id", String(gymId))
      .send({ perkTitle: `Free espresso + pastry ${RUN}`, mutualRewardTerms: "Both honor 15% off" })
      .expect(200);
    expect(proposed.body.perkTitle).toBe(`Free espresso ${RUN}`); // live terms untouched
    expect(proposed.body.proposedPerkTitle).toBe(`Free espresso + pastry ${RUN}`);
    expect(proposed.body.renegotiationRequestedByTenantId).toBe(gymId);

    // Proposer cannot answer their own proposal; bystanders are shut out.
    await agent
      .post(`/api/coop/partnerships/${partnershipId}/renegotiation/respond`)
      .set("x-tenant-id", String(gymId))
      .send({ action: "accept" })
      .expect(403);
    await agent
      .post(`/api/coop/partnerships/${partnershipId}/renegotiation/respond`)
      .set("x-tenant-id", String(bakeryId))
      .send({ action: "accept" })
      .expect(403);
    // No double-propose while one is pending.
    await agent
      .post(`/api/coop/partnerships/${partnershipId}/renegotiate`)
      .set("x-tenant-id", String(cafeId))
      .send({ perkTitle: "Competing proposal" })
      .expect(409);
  });

  it("decline keeps current terms and clears the proposal", async () => {
    const res = await agent
      .post(`/api/coop/partnerships/${partnershipId}/renegotiation/respond`)
      .set("x-tenant-id", String(cafeId))
      .send({ action: "decline" })
      .expect(200);
    expect(res.body.perkTitle).toBe(`Free espresso ${RUN}`);
    expect(res.body.proposedPerkTitle).toBeNull();
    expect(res.body.renegotiationRequestedByTenantId).toBeNull();
    // Nothing pending → respond is a 409 now.
    await agent
      .post(`/api/coop/partnerships/${partnershipId}/renegotiation/respond`)
      .set("x-tenant-id", String(cafeId))
      .send({ action: "accept" })
      .expect(409);
  });

  it("accept replaces the live terms and clears the proposal", async () => {
    await agent
      .post(`/api/coop/partnerships/${partnershipId}/renegotiate`)
      .set("x-tenant-id", String(cafeId))
      .send({ perkTitle: `Espresso v2 ${RUN}`, perkDescription: "Any size" })
      .expect(200);
    const res = await agent
      .post(`/api/coop/partnerships/${partnershipId}/renegotiation/respond`)
      .set("x-tenant-id", String(gymId))
      .send({ action: "accept" })
      .expect(200);
    expect(res.body.perkTitle).toBe(`Espresso v2 ${RUN}`);
    expect(res.body.perkDescription).toBe("Any size");
    expect(res.body.proposedPerkTitle).toBeNull();
    expect(res.body.renegotiationRequestedByTenantId).toBeNull();
  });
});

describe("tenant pause / resume", () => {
  it("bystanders cannot pause someone else's pact", async () => {
    await agent
      .post(`/api/coop/partnerships/${partnershipId}/pause`)
      .set("x-tenant-id", String(bakeryId))
      .expect(403);
  });

  it("pausing hides the perk from /coop/perks, the landing page, and code validation", async () => {
    const paused = await agent
      .post(`/api/coop/partnerships/${partnershipId}/pause`)
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(paused.body.isActive).toBe(false);
    expect(paused.body.status).toBe("accepted");

    for (const t of [cafeId, gymId]) {
      const perks = await agent
        .get("/api/coop/perks")
        .set("x-tenant-id", String(t))
        .expect(200);
      expect(perks.body.perks.some((p: { id: number }) => p.id === partnershipId)).toBe(false);
    }
    const landing = await agent.get(`/api/public/landing/${RUN}-cafe/perks`).expect(200);
    expect(
      landing.body.perks.some((p: { perkTitle: string }) => p.perkTitle === `Espresso v2 ${RUN}`),
    ).toBe(false);
    const validation = await agent
      .get(`/api/coop/redemptions/${redemptionCode}`)
      .set("x-tenant-id", String(gymId))
      .expect(200);
    expect(validation.body.valid).toBe(false);
    // Paused pacts cannot be re-negotiated back to life silently… but the
    // click-through is also dead.
    await agent
      .get(`/api/public/landing/${RUN}-cafe/perks/${partnershipId}/visit`)
      .expect(404);
  });

  it("either party can resume; the perk comes back", async () => {
    const resumed = await agent
      .post(`/api/coop/partnerships/${partnershipId}/resume`)
      .set("x-tenant-id", String(gymId))
      .expect(200);
    expect(resumed.body.isActive).toBe(true);
    const perks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(perks.body.perks.some((p: { id: number }) => p.id === partnershipId)).toBe(true);
  });
});
