import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  sosSettingsTable,
  sosStaffMembersTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-op staff cross-training & shift coverage, against the real dev DB:
// credential eligibility enforcement on offers (coverage flag, verification,
// expiry, license state, skill), partner-only shift visibility, single-winner
// acceptance under concurrency, lifecycle (complete + hours), and rating
// aggregation onto the coverage card.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `coopcov-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let hostId: number; // posting business (TX)
let partnerAId: number; // accepted active partner (offers staff)
let partnerBId: number; // second accepted partner (races on accept)
let strangerId: number; // NOT a partner — must never see shifts
let tenantIds: number[] = [];

// partner A staff
let eligibleAId: number;
let unverifiedId: number;
let expiredId: number;
let wrongStateId: number;
let wrongSkillId: number;
let notOptedInId: number;
// partner B staff
let eligibleBId: number;

const futureExpiry = new Date(Date.now() + 365 * 24 * 3600 * 1000);
const pastExpiry = new Date(Date.now() - 24 * 3600 * 1000);

function staffRow(
  tenantId: number,
  name: string,
  over: Partial<typeof sosStaffMembersTable.$inferInsert> = {},
) {
  return {
    tenantId,
    name: `${name} ${RUN}`,
    compensationType: "commission",
    commissionPercent: 50,
    skills: ["fades", "color"],
    certifications: ["Barber certificate"],
    licenseNumber: `LIC-${name}-${RUN}`,
    licenseState: "TX",
    licenseExpiresAt: futureExpiry,
    licenseVerificationStatus: "verified",
    licenseVerifiedBy: "Test Verifier",
    licenseVerifiedAt: new Date(),
    coopCoverageEnabled: true,
    ...over,
  };
}

async function postShift(over: Record<string, unknown> = {}) {
  const res = await agent
    .post("/api/coop/coverage/shifts")
    .set("x-tenant-id", String(hostId))
    .send({
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 56 * 3600 * 1000).toISOString(),
      requiredSkill: "fades",
      offeredHourlyRate: 35,
      ...over,
    })
    .expect(201);
  return res.body;
}

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
      { brandName: `Cov Host ${RUN}`, subdomain: `${RUN}-host`, status: "active" },
      { brandName: `Cov Partner A ${RUN}`, subdomain: `${RUN}-pa`, status: "active" },
      { brandName: `Cov Partner B ${RUN}`, subdomain: `${RUN}-pb`, status: "active" },
      { brandName: `Cov Stranger ${RUN}`, subdomain: `${RUN}-str`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [hostId, partnerAId, partnerBId, strangerId] = tenants.map((t) => t.id);
  tenantIds = tenants.map((t) => t.id);

  // Host's business state (TX) is the default required license state.
  await db.insert(sosSettingsTable).values([
    { tenantId: hostId, businessName: `Cov Host ${RUN}`, addressRegion: "TX" },
  ]);

  await db.insert(merchantCoopPartnershipsTable).values([
    {
      hostTenantId: hostId,
      partnerTenantId: partnerAId,
      perkTitle: `Cov perk A ${RUN}`,
      redemptionCode: `COV-${RUN}-A`,
      status: "accepted",
      isActive: true,
    },
    {
      hostTenantId: partnerBId,
      partnerTenantId: hostId,
      perkTitle: `Cov perk B ${RUN}`,
      redemptionCode: `COV-${RUN}-B`,
      status: "accepted",
      isActive: true,
    },
    // Stranger has only a *pending* invite — not an accepted partner.
    {
      hostTenantId: hostId,
      partnerTenantId: strangerId,
      perkTitle: `Cov perk S ${RUN}`,
      redemptionCode: `COV-${RUN}-S`,
      status: "pending",
      isActive: true,
    },
  ]);

  const staff = await db
    .insert(sosStaffMembersTable)
    .values([
      staffRow(partnerAId, "Eligible-A"),
      staffRow(partnerAId, "Unverified", {
        licenseVerificationStatus: "unverified",
        licenseVerifiedBy: null,
        licenseVerifiedAt: null,
      }),
      staffRow(partnerAId, "Expired", { licenseExpiresAt: pastExpiry }),
      staffRow(partnerAId, "WrongState", { licenseState: "CA" }),
      staffRow(partnerAId, "WrongSkill", { skills: ["nails"] }),
      staffRow(partnerAId, "NotOptedIn", { coopCoverageEnabled: false }),
      staffRow(partnerBId, "Eligible-B"),
    ])
    .returning({ id: sosStaffMembersTable.id });
  [eligibleAId, unverifiedId, expiredId, wrongStateId, wrongSkillId, notOptedInId, eligibleBId] =
    staff.map((s) => s.id);
});

afterAll(async () => {
  // Tenant cascade removes staff, settings, partnerships, shifts, offers,
  // ratings created by this run.
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
});

describe("credential registry", () => {
  it("computes expired status at read time and flags it on the staff list", async () => {
    const res = await agent
      .get("/api/sos/staff")
      .set("x-tenant-id", String(partnerAId))
      .expect(200);
    const byId = new Map(res.body.map((s: any) => [s.id, s]));
    expect((byId.get(eligibleAId) as any).licenseStatus).toBe("verified");
    expect((byId.get(unverifiedId) as any).licenseStatus).toBe("unverified");
    expect((byId.get(expiredId) as any).licenseStatus).toBe("expired");
  });

  it("manual attestation verifies, and editing license fields resets to unverified", async () => {
    const verify = await agent
      .post(`/api/sos/staff/${unverifiedId}/license-verification`)
      .set("x-tenant-id", String(partnerAId))
      .send({ verifiedBy: `Inspector ${RUN}` })
      .expect(200);
    expect(verify.body.licenseStatus).toBe("verified");
    expect(verify.body.licenseVerifiedBy).toBe(`Inspector ${RUN}`);
    expect(verify.body.licenseVerifiedAt).toBeTruthy();

    const edited = await agent
      .patch(`/api/sos/staff/${unverifiedId}`)
      .set("x-tenant-id", String(partnerAId))
      .send({ licenseNumber: `LIC-CHANGED-${RUN}` })
      .expect(200);
    expect(edited.body.licenseStatus).toBe("unverified");
    expect(edited.body.licenseVerifiedBy).toBeNull();
  });

  it("refuses to verify when no license is on file", async () => {
    const [bare] = await db
      .insert(sosStaffMembersTable)
      .values([staffRow(partnerAId, "NoLicense", { licenseNumber: null })])
      .returning({ id: sosStaffMembersTable.id });
    await agent
      .post(`/api/sos/staff/${bare.id}/license-verification`)
      .set("x-tenant-id", String(partnerAId))
      .send({ verifiedBy: "Nobody" })
      .expect(400);
  });
});

describe("partner-only visibility", () => {
  let shiftId: number;

  it("host posts a shift defaulting the license state from its settings", async () => {
    const shift = await postShift();
    shiftId = shift.id;
    expect(shift.requiredLicenseState).toBe("TX");
    expect(shift.status).toBe("open");
  });

  it("accepted partners see the shift; a non-partner does not", async () => {
    const forA = await agent
      .get("/api/coop/coverage/shifts")
      .set("x-tenant-id", String(partnerAId))
      .expect(200);
    expect(forA.body.some((s: any) => s.id === shiftId)).toBe(true);

    const forStranger = await agent
      .get("/api/coop/coverage/shifts")
      .set("x-tenant-id", String(strangerId))
      .expect(200);
    expect(forStranger.body.some((s: any) => s.id === shiftId)).toBe(false);
  });

  it("a non-partner cannot offer on the shift (404, existence not revealed)", async () => {
    const [own] = await db
      .insert(sosStaffMembersTable)
      .values([staffRow(strangerId, "StrangerStaff")])
      .returning({ id: sosStaffMembersTable.id });
    await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/offers`)
      .set("x-tenant-id", String(strangerId))
      .send({ staffId: own.id })
      .expect(404);
  });

  it("privacy-safe partner staff cards exclude non-opted-in staff and compensation", async () => {
    const res = await agent
      .get("/api/coop/coverage/partner-staff")
      .set("x-tenant-id", String(hostId))
      .expect(200);
    const ids = res.body.map((c: any) => c.staffId);
    expect(ids).toContain(eligibleAId);
    expect(ids).not.toContain(notOptedInId);
    const card = res.body.find((c: any) => c.staffId === eligibleAId);
    expect(card.compensationType).toBeUndefined();
    expect(card.commissionPercent).toBeUndefined();
    expect(card.amount).toBeUndefined();
  });

  it("poster sees all offers; each partner sees only its own", async () => {
    await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/offers`)
      .set("x-tenant-id", String(partnerAId))
      .send({ staffId: eligibleAId })
      .expect(201);
    await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/offers`)
      .set("x-tenant-id", String(partnerBId))
      .send({ staffId: eligibleBId })
      .expect(201);

    const forHost = await agent
      .get("/api/coop/coverage/shifts")
      .set("x-tenant-id", String(hostId))
      .expect(200);
    const hostShift = forHost.body.find((s: any) => s.id === shiftId);
    expect(hostShift.status).toBe("offered");
    expect(hostShift.offers).toHaveLength(2);

    const forA = await agent
      .get("/api/coop/coverage/shifts")
      .set("x-tenant-id", String(partnerAId))
      .expect(200);
    const aShift = forA.body.find((s: any) => s.id === shiftId);
    expect(aShift.offers).toHaveLength(1);
    expect(aShift.offers[0].staffId).toBe(eligibleAId);
  });
});

describe("offer eligibility enforcement", () => {
  let shiftId: number;

  beforeAll(async () => {
    const shift = await postShift();
    shiftId = shift.id;
  });

  const attempt = (staffId: number) =>
    agent
      .post(`/api/coop/coverage/shifts/${shiftId}/offers`)
      .set("x-tenant-id", String(partnerAId))
      .send({ staffId });

  it("rejects staff not opted into co-op coverage", async () => {
    const res = await attempt(notOptedInId).expect(409);
    expect(res.body.message).toMatch(/not marked available/i);
  });

  it("rejects unverified licenses with an explanation", async () => {
    const res = await attempt(unverifiedId).expect(409);
    expect(res.body.message).toMatch(/not been verified/i);
  });

  it("rejects expired licenses even when marked verified", async () => {
    const res = await attempt(expiredId).expect(409);
    expect(res.body.message).toMatch(/expired/i);
  });

  it("rejects licenses from a different state than the shift requires", async () => {
    const res = await attempt(wrongStateId).expect(409);
    expect(res.body.message).toMatch(/licensed in CA/i);
    expect(res.body.message).toMatch(/TX/);
  });

  it("rejects staff missing the required skill", async () => {
    const res = await attempt(wrongSkillId).expect(409);
    expect(res.body.message).toMatch(/required skill/i);
  });

  it("rejects offering another tenant's staff", async () => {
    await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/offers`)
      .set("x-tenant-id", String(partnerAId))
      .send({ staffId: eligibleBId })
      .expect(404);
  });

  it("accepts a fully eligible staff member exactly once", async () => {
    await attempt(eligibleAId).expect(201);
    const dup = await attempt(eligibleAId).expect(409);
    expect(dup.body.message).toMatch(/already been offered/i);
  });
});

describe("single-winner acceptance, lifecycle, and rating aggregation", () => {
  let shiftId: number;
  let offerAId: number;
  let offerBId: number;

  beforeAll(async () => {
    const shift = await postShift();
    shiftId = shift.id;
    const a = await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/offers`)
      .set("x-tenant-id", String(partnerAId))
      .send({ staffId: eligibleAId })
      .expect(201);
    offerAId = a.body.offers[0].id;
    const b = await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/offers`)
      .set("x-tenant-id", String(partnerBId))
      .send({ staffId: eligibleBId })
      .expect(201);
    offerBId = b.body.offers[0].id;
  });

  it("only the posting business can accept an offer", async () => {
    await agent
      .post(`/api/coop/coverage/offers/${offerAId}/accept`)
      .set("x-tenant-id", String(partnerAId))
      .expect(403);
  });

  it("under concurrent accepts exactly one offer wins; the loser is declined", async () => {
    const [ra, rb] = await Promise.all([
      agent
        .post(`/api/coop/coverage/offers/${offerAId}/accept`)
        .set("x-tenant-id", String(hostId)),
      agent
        .post(`/api/coop/coverage/offers/${offerBId}/accept`)
        .set("x-tenant-id", String(hostId)),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);
    winnerIsA = ra.status === 200;
    const winner = ra.status === 200 ? ra.body : rb.body;
    expect(winner.status).toBe("confirmed");
    expect(winner.acceptedOfferId).not.toBeNull();
    const accepted = winner.offers.filter((o: any) => o.status === "accepted");
    const declined = winner.offers.filter((o: any) => o.status === "declined");
    expect(accepted).toHaveLength(1);
    expect(declined).toHaveLength(1);
  });

  it("cannot rate before completion; completing records hours", async () => {
    await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/rating`)
      .set("x-tenant-id", String(hostId))
      .send({ rating: 5 })
      .expect(409);

    const done = await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/complete`)
      .set("x-tenant-id", String(hostId))
      .send({ hoursWorked: 7.5 })
      .expect(200);
    expect(done.body.status).toBe("completed");
    expect(done.body.hoursWorked).toBe(7.5);
  });

  it("host rates the covering staff once; average shows on the coverage card", async () => {
    const rated = await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/rating`)
      .set("x-tenant-id", String(hostId))
      .send({ rating: 4, comment: `Solid work ${RUN}` })
      .expect(201);
    expect(rated.body.rating.rating).toBe(4);

    // One rating per shift.
    await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/rating`)
      .set("x-tenant-id", String(hostId))
      .send({ rating: 1 })
      .expect(409);

    // Second completed shift for the same staff → average of 4 and 5.
    const shift2 = await postShift();
    const o = await agent
      .post(`/api/coop/coverage/shifts/${shift2.id}/offers`)
      .set("x-tenant-id", String(hostWinnerTenant()))
      .send({ staffId: winnerStaffId() })
      .expect(201);
    await agent
      .post(`/api/coop/coverage/offers/${o.body.offers[0].id}/accept`)
      .set("x-tenant-id", String(hostId))
      .expect(200);
    await agent
      .post(`/api/coop/coverage/shifts/${shift2.id}/complete`)
      .set("x-tenant-id", String(hostId))
      .send({ hoursWorked: 8 })
      .expect(200);
    await agent
      .post(`/api/coop/coverage/shifts/${shift2.id}/rating`)
      .set("x-tenant-id", String(hostId))
      .send({ rating: 5 })
      .expect(201);

    const cards = await agent
      .get("/api/coop/coverage/partner-staff")
      .set("x-tenant-id", String(hostId))
      .expect(200);
    const card = cards.body.find((c: any) => c.staffId === winnerStaffId());
    expect(card.ratingCount).toBe(2);
    expect(card.averageRating).toBeCloseTo(4.5, 1);
  });

  it("ledger shows the shift for both poster and covering business", async () => {
    const hostLedger = await agent
      .get("/api/coop/coverage/ledger")
      .set("x-tenant-id", String(hostId))
      .expect(200);
    expect(hostLedger.body.posted.some((s: any) => s.id === shiftId)).toBe(true);

    const coverLedger = await agent
      .get("/api/coop/coverage/ledger")
      .set("x-tenant-id", String(hostWinnerTenant()))
      .expect(200);
    expect(coverLedger.body.covered.some((s: any) => s.id === shiftId)).toBe(true);
  });

  it("cancel declines pending offers and blocks on completed shifts", async () => {
    const shift3 = await postShift();
    await agent
      .post(`/api/coop/coverage/shifts/${shift3.id}/offers`)
      .set("x-tenant-id", String(partnerAId))
      .send({ staffId: eligibleAId })
      .expect(201);
    const cancelled = await agent
      .post(`/api/coop/coverage/shifts/${shift3.id}/cancel`)
      .set("x-tenant-id", String(hostId))
      .expect(200);
    expect(cancelled.body.status).toBe("cancelled");
    expect(cancelled.body.offers.every((o: any) => o.status === "declined")).toBe(true);

    await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/cancel`)
      .set("x-tenant-id", String(hostId))
      .expect(409);
  });

  // The concurrency race decides which staff won the first shift; the rating
  // tests follow whichever side won so assertions stay deterministic.
  function winnerStaffId(): number {
    return winnerIsA ? eligibleAId : eligibleBId;
  }
  function hostWinnerTenant(): number {
    return winnerIsA ? partnerAId : partnerBId;
  }
  let winnerIsA = true;
});
