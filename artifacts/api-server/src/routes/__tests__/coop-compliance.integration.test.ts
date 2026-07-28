import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  merchantCoopPartnershipsTable,
  coopComplianceLedgerTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-Op Automated Tax & Revenue Compliance Ledger: automatic ledger capture on
// perk redemption (only when the perk has monetary terms), rate-snapshot
// immutability, manual entries, 1099 threshold flagging across the $600
// boundary, tenant isolation, and CSV export shapes (QuickBooks/Xero/audit).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `cooptax-${Date.now()}-${process.pid}`;
const YEAR = new Date().getUTCFullYear();
const PERIOD = String(YEAR);

let agent: ReturnType<typeof request.agent>;
let hostId: number;
let partnerId: number;
let outsiderId: number;
let partnershipId: number;
let hostTrackingCode: string;

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD }).expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Tax Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Tax Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
      { brandName: `Tax Outsider ${RUN}`, subdomain: `${RUN}-out`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [hostId, partnerId, outsiderId] = tenants.map((t) => t.id);

  await db.insert(sosSettingsTable).values([
    { tenantId: hostId, industryType: "restaurant", businessCategory: `Cafe-${RUN}` },
    { tenantId: partnerId, industryType: "fitness", businessCategory: `Gym-${RUN}` },
    { tenantId: outsiderId, industryType: "bakery", businessCategory: `Bakery-${RUN}` },
  ]);

  // Accepted partnership with monetary perk terms ($25 value).
  const invite = await agent
    .post("/api/coop/invites")
    .set("x-tenant-id", String(hostId))
    .send({ partnerTenantId: partnerId, perkTitle: `Free tasting ${RUN}` })
    .expect(201);
  partnershipId = invite.body.id;
  await agent
    .post(`/api/coop/invites/${partnershipId}/respond`)
    .set("x-tenant-id", String(partnerId))
    .send({ action: "accept" })
    .expect(200);
  const patched = await agent
    .patch(`/api/coop/partnerships/${partnershipId}`)
    .set("x-tenant-id", String(hostId))
    .send({ perkValueAmount: 25 })
    .expect(200);
  expect(patched.body.perkValueAmount).toBe(25);
  const [row] = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
  hostTrackingCode = row.hostTrackingCode!;
});

afterAll(async () => {
  const ids = [hostId, partnerId, outsiderId].filter((n) => Number.isInteger(n));
  if (ids.length) {
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

const ledgerFor = (tenantId: number) =>
  db
    .select()
    .from(coopComplianceLedgerTable)
    .where(eq(coopComplianceLedgerTable.tenantId, tenantId));

describe("tax settings", () => {
  it("auto-creates zero-rate settings with the $600 default 1099 threshold", async () => {
    const res = await agent
      .get("/api/coop/compliance/settings")
      .set("x-tenant-id", String(partnerId))
      .expect(200);
    expect(res.body.stateRatePercent).toBe(0);
    expect(res.body.threshold1099).toBe(600);
  });

  it("updates rates per tenant without touching other tenants", async () => {
    const res = await agent
      .patch("/api/coop/compliance/settings")
      .set("x-tenant-id", String(partnerId))
      .send({ stateRatePercent: 5, localRatePercent: 2, salesRatePercent: 3 })
      .expect(200);
    expect(res.body.stateRatePercent).toBe(5);
    const other = await agent
      .get("/api/coop/compliance/settings")
      .set("x-tenant-id", String(hostId))
      .expect(200);
    expect(other.body.stateRatePercent).toBe(0);
  });
});

describe("automatic capture on perk redemption", () => {
  it("a redemption of a perk with monetary terms writes exactly one ledger entry with the rate snapshot", async () => {
    // Partner (rates 5/2/3 = 10%) redeems the host's code.
    await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(partnerId))
      .send({ code: hostTrackingCode, passCode: `${RUN}-pass-1` })
      .expect(200);
    const rows = await ledgerFor(partnerId);
    expect(rows.length).toBe(1);
    expect(rows[0].category).toBe("perk_redemption");
    expect(rows[0].direction).toBe("expense");
    expect(rows[0].counterpartTenantId).toBe(hostId);
    expect(parseFloat(rows[0].grossAmount)).toBe(25);
    expect(parseFloat(rows[0].stateRatePercent)).toBe(5);
    expect(parseFloat(rows[0].estimatedTaxAmount)).toBeCloseTo(2.5, 2);
  });

  it("a replayed redemption never double-writes (idempotent source_ref)", async () => {
    await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(partnerId))
      .send({ code: hostTrackingCode, passCode: `${RUN}-pass-1` })
      .expect(200);
    expect((await ledgerFor(partnerId)).length).toBe(1);
  });

  it("rate changes only affect entries going forward — historical entries keep their snapshot", async () => {
    await agent
      .patch("/api/coop/compliance/settings")
      .set("x-tenant-id", String(partnerId))
      .send({ stateRatePercent: 9 })
      .expect(200);
    const [old] = await ledgerFor(partnerId);
    expect(parseFloat(old.stateRatePercent)).toBe(5); // unchanged snapshot
    await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(partnerId))
      .send({ code: hostTrackingCode, passCode: `${RUN}-pass-2` })
      .expect(200);
    const rows = await ledgerFor(partnerId);
    expect(rows.length).toBe(2);
    const fresh = rows.find((r) => r.sourceRef !== old.sourceRef)!;
    expect(parseFloat(fresh.stateRatePercent)).toBe(9);
    expect(parseFloat(fresh.estimatedTaxAmount)).toBeCloseTo(25 * 0.14, 2);
  });

  it("perks without monetary terms are not ledgered", async () => {
    await agent
      .patch(`/api/coop/partnerships/${partnershipId}`)
      .set("x-tenant-id", String(hostId))
      .send({ perkValueAmount: null })
      .expect(200);
    const before = (await ledgerFor(partnerId)).length;
    await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(partnerId))
      .send({ code: hostTrackingCode, passCode: `${RUN}-pass-3` })
      .expect(200);
    expect((await ledgerFor(partnerId)).length).toBe(before);
    await agent
      .patch(`/api/coop/partnerships/${partnershipId}`)
      .set("x-tenant-id", String(hostId))
      .send({ perkValueAmount: 25 })
      .expect(200);
  });
});

describe("manual entries, summary, and tenant isolation", () => {
  it("logs a manual sponsorship entry and rejects invalid categories", async () => {
    const res = await agent
      .post("/api/coop/compliance/entries")
      .set("x-tenant-id", String(hostId))
      .send({
        category: "sponsorship",
        direction: "income",
        grossAmount: 100,
        description: `Street fair sponsorship ${RUN}`,
      })
      .expect(201);
    expect(res.body.category).toBe("sponsorship");
    expect(res.body.grossAmount).toBe(100);
    await agent
      .post("/api/coop/compliance/entries")
      .set("x-tenant-id", String(hostId))
      .send({ category: "perk_redemption", direction: "income", grossAmount: 1, description: "x" })
      .expect(400);
  });

  it("summary separates revenue classes and includes the estimate disclaimer", async () => {
    const res = await agent
      .get(`/api/coop/compliance/summary?period=${PERIOD}`)
      .set("x-tenant-id", String(hostId))
      .expect(200);
    expect(res.body.disclaimer).toMatch(/consult your accountant/i);
    const keys = res.body.sections.map((s: { key: string }) => s.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "direct_revenue",
        "perk_redemption",
        "referral_commission",
        "sponsorship",
        "shared_expense",
      ]),
    );
    const sponsorship = res.body.sections.find((s: { key: string }) => s.key === "sponsorship");
    expect(sponsorship.grossIncome).toBe(100);
  });

  it("quarter and month period keys parse; garbage is rejected", async () => {
    await agent
      .get(`/api/coop/compliance/summary?period=${YEAR}-Q1`)
      .set("x-tenant-id", String(hostId))
      .expect(200);
    await agent
      .get("/api/coop/compliance/summary?period=banana")
      .set("x-tenant-id", String(hostId))
      .expect(400);
  });

  it("one tenant's ledger is invisible to another tenant", async () => {
    const res = await agent
      .get(`/api/coop/compliance/ledger?period=${PERIOD}`)
      .set("x-tenant-id", String(outsiderId))
      .expect(200);
    const refs = res.body.map((e: { description: string | null }) => e.description ?? "");
    expect(refs.join()).not.toContain(RUN);
    expect(res.body.length).toBe(0);
  });
});

describe("1099 partner payout tracking", () => {
  it("accumulates expense payouts per payee and flags the $600 threshold crossing", async () => {
    const payee = `Agent ${RUN}`;
    await agent
      .post("/api/coop/compliance/entries")
      .set("x-tenant-id", String(hostId))
      .send({
        category: "referral_commission",
        direction: "expense",
        grossAmount: 550,
        description: "Referral bounty batch 1",
        payeeName: payee,
      })
      .expect(201);
    let res = await agent
      .get(`/api/coop/compliance/payouts?year=${YEAR}`)
      .set("x-tenant-id", String(hostId))
      .expect(200);
    let row = res.body.payouts.find((p: { payeeName: string }) => p.payeeName === payee);
    expect(row.totalPaid).toBe(550);
    expect(row.thresholdCrossed).toBe(false);
    expect(row.remainingBeforeThreshold).toBe(50);

    await agent
      .post("/api/coop/compliance/entries")
      .set("x-tenant-id", String(hostId))
      .send({
        category: "referral_commission",
        direction: "expense",
        grossAmount: 75,
        description: "Referral bounty batch 2",
        payeeName: payee,
      })
      .expect(201);
    res = await agent
      .get(`/api/coop/compliance/payouts?year=${YEAR}`)
      .set("x-tenant-id", String(hostId))
      .expect(200);
    row = res.body.payouts.find((p: { payeeName: string }) => p.payeeName === payee);
    expect(row.totalPaid).toBe(625);
    expect(row.thresholdCrossed).toBe(true);
    expect(row.remainingBeforeThreshold).toBe(0);
  });

  it("payout accumulations are tenant-isolated", async () => {
    const res = await agent
      .get(`/api/coop/compliance/payouts?year=${YEAR}`)
      .set("x-tenant-id", String(outsiderId))
      .expect(200);
    expect(res.body.payouts.length).toBe(0);
  });
});

describe("CSV exports", () => {
  const get = (qs: string, tenantId: number) =>
    agent.get(`/api/coop/compliance/export?${qs}`).set("x-tenant-id", String(tenantId));

  it("audit layout carries every column including the rate snapshot", async () => {
    const res = await get(`period=${PERIOD}&layout=audit`, partnerId).expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/coop-ledger-audit/);
    const lines = res.text.trim().split("\r\n");
    expect(lines[0]).toContain("State Rate %");
    expect(lines.length).toBeGreaterThanOrEqual(3); // header + 2 redemptions
  });

  it("QuickBooks layout is a balanced general-journal (two lines per entry)", async () => {
    const res = await get(`period=${PERIOD}&layout=quickbooks`, partnerId).expect(200);
    const lines = res.text.trim().split("\r\n");
    expect(lines[0]).toBe("JournalNo,JournalDate,Memo,AccountName,Debits,Credits,Name");
    expect((lines.length - 1) % 2).toBe(0);
  });

  it("Xero layout signs amounts by direction", async () => {
    const res = await get(`period=${PERIOD}&layout=xero`, partnerId).expect(200);
    const lines = res.text.trim().split("\r\n");
    expect(lines[0]).toBe("Date,Amount,Payee,Description,Reference");
    expect(lines[1]).toMatch(/,-25\.00,/); // expense-side redemption
  });

  it("payouts dataset exports 1099 tracking data", async () => {
    const res = await get(`period=${PERIOD}&layout=quickbooks&dataset=payouts`, hostId).expect(200);
    const lines = res.text.trim().split("\r\n");
    expect(lines[0]).toBe("Vendor,TaxYear,TotalPayments,1099Threshold,Meets1099Threshold");
    expect(res.text).toContain(`Agent ${RUN}`);
    expect(res.text).toContain("Yes");
  });

  it("rejects bad layout and dataset values", async () => {
    await get(`period=${PERIOD}&layout=excel`, hostId).expect(400);
    await get(`period=${PERIOD}&layout=audit&dataset=everything`, hostId).expect(400);
  });
});
