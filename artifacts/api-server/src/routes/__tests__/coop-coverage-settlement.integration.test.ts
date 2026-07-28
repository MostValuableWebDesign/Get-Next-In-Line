import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  sosSettingsTable,
  sosStaffMembersTable,
  coopObligationLedgerTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Coverage-shift labor settlement: completing a coverage shift writes an
// idempotent coverage_labor obligation (hours × agreed rate) into the co-op
// settlement clearinghouse ledger — poster owes the covering business.
// Assertions are scoped to this run's tenants; other suites share the DB.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `covstl-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let hostId: number; // posting business (TX)
let partnerId: number; // covering business
let tenantIds: number[] = [];
let staffId: number;

const futureExpiry = new Date(Date.now() + 365 * 24 * 3600 * 1000);

async function postShift(offeredHourlyRate = 40) {
  const res = await agent
    .post("/api/coop/coverage/shifts")
    .set("x-tenant-id", String(hostId))
    .send({
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 56 * 3600 * 1000).toISOString(),
      requiredSkill: "fades",
      offeredHourlyRate,
    })
    .expect(201);
  return res.body;
}

/** Post → offer → accept, returning the confirmed shift id. */
async function confirmedShift(rate = 40) {
  const shift = await postShift(rate);
  const offered = await agent
    .post(`/api/coop/coverage/shifts/${shift.id}/offers`)
    .set("x-tenant-id", String(partnerId))
    .send({ staffId })
    .expect(201);
  const offerId = offered.body.offers[0].id;
  await agent
    .post(`/api/coop/coverage/offers/${offerId}/accept`)
    .set("x-tenant-id", String(hostId))
    .expect(200);
  return shift.id as number;
}

function ledgerRowsFor(shiftId: number) {
  return db
    .select()
    .from(coopObligationLedgerTable)
    .where(
      and(
        eq(coopObligationLedgerTable.kind, "coverage_labor"),
        eq(coopObligationLedgerTable.sourceRef, `coop_coverage_shifts:${shiftId}`),
      ),
    );
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
      { brandName: `CovStl Host ${RUN}`, subdomain: `${RUN}-host`, status: "active" },
      { brandName: `CovStl Partner ${RUN}`, subdomain: `${RUN}-pa`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [hostId, partnerId] = tenants.map((t) => t.id);
  tenantIds = tenants.map((t) => t.id);

  await db
    .insert(sosSettingsTable)
    .values([{ tenantId: hostId, businessName: `CovStl Host ${RUN}`, addressRegion: "TX" }]);

  await db.insert(merchantCoopPartnershipsTable).values([
    {
      hostTenantId: hostId,
      partnerTenantId: partnerId,
      perkTitle: `CovStl perk ${RUN}`,
      redemptionCode: `COVSTL-${RUN}`,
      status: "accepted",
      isActive: true,
    },
  ]);

  const [staff] = await db
    .insert(sosStaffMembersTable)
    .values([
      {
        tenantId: partnerId,
        name: `CovStl Staff ${RUN}`,
        compensationType: "commission",
        commissionPercent: 50,
        skills: ["fades"],
        licenseNumber: `LIC-${RUN}`,
        licenseState: "TX",
        licenseExpiresAt: futureExpiry,
        licenseVerificationStatus: "verified",
        licenseVerifiedBy: "Test Verifier",
        licenseVerifiedAt: new Date(),
        coopCoverageEnabled: true,
      },
    ])
    .returning({ id: sosStaffMembersTable.id });
  staffId = staff.id;
});

afterAll(async () => {
  // Ledger rows reference tenants with ON DELETE CASCADE; tenant delete
  // removes staff, settings, partnerships, shifts, offers, and ledger rows.
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
});

describe("coverage labor settlement", () => {
  it("completing a confirmed shift records poster-owes-coverer hours × rate", async () => {
    const shiftId = await confirmedShift(40);
    await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/complete`)
      .set("x-tenant-id", String(hostId))
      .send({ hoursWorked: 6.5 })
      .expect(200);

    const rows = await ledgerRowsFor(shiftId);
    expect(rows).toHaveLength(1);
    expect(rows[0].debtorTenantId).toBe(hostId);
    expect(rows[0].creditorTenantId).toBe(partnerId);
    expect(rows[0].amount).toBe("260.00"); // 6.5 × 40
    expect(rows[0].settlementCycleId).toBeNull();
    expect(rows[0].description).toContain("Coverage labor");
  });

  it("a retried completion never double-bills the shift", async () => {
    const shiftId = await confirmedShift(35);
    await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/complete`)
      .set("x-tenant-id", String(hostId))
      .send({ hoursWorked: 4 })
      .expect(200);
    // Retry — already completed, but even if the hook re-fires the
    // (kind, sourceRef) unique keeps the ledger at exactly one row.
    await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/complete`)
      .set("x-tenant-id", String(hostId))
      .send({ hoursWorked: 4 })
      .expect(409);

    const rows = await ledgerRowsFor(shiftId);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe("140.00");
  });

  it("a cancelled shift produces no obligation", async () => {
    const shiftId = await confirmedShift(50);
    await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/cancel`)
      .set("x-tenant-id", String(hostId))
      .expect(200);
    expect(await ledgerRowsFor(shiftId)).toHaveLength(0);
    // Completion after cancellation is refused and still records nothing.
    await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/complete`)
      .set("x-tenant-id", String(hostId))
      .send({ hoursWorked: 3 })
      .expect(409);
    expect(await ledgerRowsFor(shiftId)).toHaveLength(0);
  });

  it("an unconfirmed (open) shift cannot be completed and records nothing", async () => {
    const shift = await postShift(30);
    await agent
      .post(`/api/coop/coverage/shifts/${shift.id}/complete`)
      .set("x-tenant-id", String(hostId))
      .send({ hoursWorked: 2 })
      .expect(409);
    expect(await ledgerRowsFor(shift.id)).toHaveLength(0);
  });

  it("the coverage charge surfaces in the settlement preview for both businesses", async () => {
    const shiftId = await confirmedShift(45);
    await agent
      .post(`/api/coop/coverage/shifts/${shiftId}/complete`)
      .set("x-tenant-id", String(hostId))
      .send({ hoursWorked: 2 })
      .expect(200);

    const start = new Date(Date.now() - 3600 * 1000).toISOString();
    const end = new Date(Date.now() + 3600 * 1000).toISOString();
    const res = await agent
      .get(`/api/agency/settlement/preview?periodStart=${start}&periodEnd=${end}`)
      .expect(200);
    const mine = res.body.entries.filter(
      (e: any) => e.sourceRef === `coop_coverage_shifts:${shiftId}`,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].kind).toBe("coverage_labor");
    expect(mine[0].amount).toBe(90); // 2 × 45
    expect(mine[0].debtorTenantId).toBe(hostId);
    expect(mine[0].creditorTenantId).toBe(partnerId);
    // Netting includes both businesses' statements.
    const stmtTenantIds = res.body.statements.map((s: any) => s.tenantId);
    expect(stmtTenantIds).toContain(hostId);
    expect(stmtTenantIds).toContain(partnerId);
  });
});
