import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  merchantCoopPartnershipsTable,
  coopPerkRedemptionsTable,
  coopFinancialDisputesTable,
  coopTenantSuspensionsTable,
  perkPassesTable,
  messagesTable,
} from "@workspace/db";

// ── Co-op financial dispute mediation lifecycle ──────────────────────────────
// Filing with evidence, automated reconciliation (auto-resolve vs. escalate),
// admin adjustments + bounty reversals, rulings, suspension enforcement
// (perks pulled, no new partnerships), and repeat-violator auto-suspension.

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `coopfin-${Date.now()}-${process.pid}`;

let agent: TestAgent;
let salonId = 0; // filer
let cafeId = 0; // respondent
let gymId = 0; // outsider
let barId = 0; // repeat-violator target

async function createPartnership(
  suffix: string,
  hostTenantId = salonId,
  partnerTenantId = cafeId
): Promise<{ id: number; code: string }> {
  const code = `CFIN-${RUN}-${suffix}`.toUpperCase().slice(0, 40);
  const [p] = await db
    .insert(merchantCoopPartnershipsTable)
    .values({
      hostTenantId,
      partnerTenantId,
      perkTitle: `Fin dispute perk ${RUN} ${suffix}`,
      redemptionCode: code,
      status: "accepted",
      isActive: true,
    })
    .returning({ id: merchantCoopPartnershipsTable.id });
  return { id: p.id, code };
}

async function seedRedemptions(partnershipId: number, n: number, when: Date): Promise<number[]> {
  const rows = await db
    .insert(coopPerkRedemptionsTable)
    .values(
      Array.from({ length: n }, (_, i) => ({
        partnershipId,
        passCode: `${RUN}-r${partnershipId}-${i}`,
        redeemedByTenantId: cafeId,
        redeemedAt: when,
      }))
    )
    .returning({ id: coopPerkRedemptionsTable.id });
  return rows.map((r) => r.id);
}

const WINDOW = {
  windowStartAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  windowEndAt: new Date().toISOString(),
};
const IN_WINDOW = new Date(Date.now() - 5 * 86_400_000);

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
      { brandName: `Fin Salon ${RUN}`, subdomain: `${RUN}-salon`, status: "active" },
      { brandName: `Fin Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Fin Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
      { brandName: `Fin Bar ${RUN}`, subdomain: `${RUN}-bar`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [salonId, cafeId, gymId, barId] = tenants.map((t) => t.id);

  await db.insert(sosSettingsTable).values([
    { tenantId: cafeId, industryType: "restaurant", publicPhone: "+15550002222" },
  ]);
});

afterAll(async () => {
  const ids = [salonId, cafeId, gymId, barId].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length) await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
});

describe("filing with evidence + automated reconciliation", () => {
  it("rejects a non-party filer and an unknown partnership", async () => {
    const { id: pId } = await createPartnership("guard");
    await agent
      .post("/api/coop/financial-disputes")
      .set("x-tenant-id", String(gymId))
      .send({ partnershipId: pId, disputeType: "commission_mismatch", claimedCount: 3, ...WINDOW })
      .expect(403);
    await agent
      .post("/api/coop/financial-disputes")
      .set("x-tenant-id", String(salonId))
      .send({ partnershipId: 999999999, disputeType: "commission_mismatch", claimedCount: 3, ...WINDOW })
      .expect(404);
  });

  it("rejects evidence redemptions that belong to another partnership", async () => {
    const { id: pId } = await createPartnership("evd-a");
    const { id: otherId } = await createPartnership("evd-b");
    const foreign = await seedRedemptions(otherId, 1, IN_WINDOW);
    await agent
      .post("/api/coop/financial-disputes")
      .set("x-tenant-id", String(salonId))
      .send({
        partnershipId: pId,
        disputeType: "commission_mismatch",
        claimedCount: 1,
        ...WINDOW,
        evidence: { redemptionIds: foreign },
      })
      .expect(409);
    // The rejected filing was not half-saved.
    const rows = await db
      .select()
      .from(coopFinancialDisputesTable)
      .where(eq(coopFinancialDisputesTable.partnershipId, pId));
    expect(rows).toHaveLength(0);
  });

  it("auto-resolves when the ledger matches the filer's figure, notifying the counterparty", async () => {
    const { id: pId } = await createPartnership("auto");
    const redemptionIds = await seedRedemptions(pId, 3, IN_WINDOW);
    const res = await agent
      .post("/api/coop/financial-disputes")
      .set("x-tenant-id", String(salonId))
      .send({
        partnershipId: pId,
        disputeType: "commission_mismatch",
        claimedCount: 3,
        expectedCount: 7,
        ...WINDOW,
        details: "Partner reported 7 referrals; we count 3.",
        evidence: {
          redemptionIds: redemptionIds.slice(0, 2),
          receipts: [
            {
              referenceNumber: `RCPT-${RUN}-1`,
              amount: 42.5,
              entryDate: IN_WINDOW.toISOString(),
              description: "POS z-report line",
            },
          ],
        },
      })
      .expect(201);
    expect(res.body.status).toBe("auto_resolved");
    expect(res.body.reconciliationSystemCount).toBe(3);
    expect(res.body.reconciliationSummary).toContain("3 redemption(s)");
    expect(res.body.resolvedAt).not.toBeNull();
    expect(res.body.evidence).toHaveLength(3);
    const receipt = res.body.evidence.find((e: { kind: string }) => e.kind === "receipt");
    expect(receipt.referenceNumber).toBe(`RCPT-${RUN}-1`);
    expect(receipt.amount).toBe(42.5);
    // Status history: filed then auto_resolved.
    expect(res.body.events.map((e: { eventType: string }) => e.eventType)).toEqual([
      "filed",
      "auto_resolved",
    ]);

    // Counterparty can see the full ticket + reconciliation summary.
    const view = await agent
      .get(`/api/coop/financial-disputes/${res.body.id}`)
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(view.body.reconciliationSummary).toContain("resolved automatically");
    // Outsiders cannot.
    await agent
      .get(`/api/coop/financial-disputes/${res.body.id}`)
      .set("x-tenant-id", String(gymId))
      .expect(403);

    // Notification went through the unified messaging pipeline.
    const alerts = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.tenantId, cafeId));
    const alert = alerts.find(
      (m) => m.kind === "coop_financial_dispute" && m.body.includes(`Fin Salon ${RUN}`)
    );
    expect(alert).toBeDefined();
  });

  it("escalates when neither figure matches, and supports respond + more evidence", async () => {
    const { id: pId } = await createPartnership("esc");
    await seedRedemptions(pId, 5, IN_WINDOW);
    const res = await agent
      .post("/api/coop/financial-disputes")
      .set("x-tenant-id", String(salonId))
      .send({
        partnershipId: pId,
        disputeType: "unfulfilled_redemption",
        claimedCount: 9,
        expectedCount: 2,
        ...WINDOW,
      })
      .expect(201);
    expect(res.body.status).toBe("escalated");
    expect(res.body.escalatedAt).not.toBeNull();
    expect(res.body.reconciliationSystemCount).toBe(5);

    // Only the respondent may respond.
    await agent
      .post(`/api/coop/financial-disputes/${res.body.id}/respond`)
      .set("x-tenant-id", String(salonId))
      .send({ response: "not me" })
      .expect(403);
    const responded = await agent
      .post(`/api/coop/financial-disputes/${res.body.id}/respond`)
      .set("x-tenant-id", String(cafeId))
      .send({ response: "Our till shows 2 fulfilled perks only." })
      .expect(200);
    expect(responded.body.counterpartyResponse).toContain("till shows 2");
    expect(responded.body.respondedAt).not.toBeNull();

    // Either party may add evidence while the ticket is open.
    const more = await agent
      .post(`/api/coop/financial-disputes/${res.body.id}/evidence`)
      .set("x-tenant-id", String(cafeId))
      .send({
        receipts: [
          { referenceNumber: `RCPT-${RUN}-2`, amount: 10, entryDate: IN_WINDOW.toISOString() },
        ],
      })
      .expect(200);
    expect(more.body.evidence.some((e: { referenceNumber: string | null }) => e.referenceNumber === `RCPT-${RUN}-2`)).toBe(true);
    expect(more.body.events.map((e: { eventType: string }) => e.eventType)).toContain("evidence_added");
  });

  it("shared-expense disputes always escalate (no platform expense ledger)", async () => {
    const { id: pId } = await createPartnership("exp");
    const res = await agent
      .post("/api/coop/financial-disputes")
      .set("x-tenant-id", String(cafeId))
      .send({
        partnershipId: pId,
        disputeType: "shared_expense",
        claimedAmount: 250,
        expectedAmount: 400,
        ...WINDOW,
      })
      .expect(201);
    expect(res.body.status).toBe("escalated");
    expect(res.body.reconciliationSummary).toContain("cannot be settled automatically");
    expect(res.body.claimedAmount).toBe(250);
    expect(res.body.expectedAmount).toBe(400);
  });

  it("the evidence picker lists a partnership's redemptions to parties only", async () => {
    const { id: pId } = await createPartnership("picker");
    await seedRedemptions(pId, 2, IN_WINDOW);
    const list = await agent
      .get(`/api/coop/partnerships/${pId}/redemptions`)
      .set("x-tenant-id", String(salonId))
      .expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body[0].passCode).toContain(RUN);
    await agent
      .get(`/api/coop/partnerships/${pId}/redemptions`)
      .set("x-tenant-id", String(gymId))
      .expect(403);
  });
});

describe("admin mediation: adjustments, bounty reversals, rulings", () => {
  let ticketId = 0;

  it("records a ledger adjustment and a bounty reversal on an escalated ticket", async () => {
    const { id: pId } = await createPartnership("adm");
    const res = await agent
      .post("/api/coop/financial-disputes")
      .set("x-tenant-id", String(salonId))
      .send({ partnershipId: pId, disputeType: "commission_mismatch", claimedCount: 4, expectedCount: 1, ...WINDOW })
      .expect(201);
    ticketId = res.body.id;
    expect(res.body.status).toBe("escalated");

    // Queue shows it with the reconciliation report.
    const queue = await agent.get("/api/admin/coop/financial-disputes?status=escalated").expect(200);
    const mine = queue.body.find((d: { id: number }) => d.id === ticketId);
    expect(mine).toBeDefined();
    expect(mine.reconciliationSummary).toContain("escalated");

    // Credit/debit must be the two parties.
    await agent
      .post(`/api/admin/coop/financial-disputes/${ticketId}/adjustments`)
      .send({ adjustmentType: "adjustment", amount: 20, creditTenantId: salonId, debitTenantId: gymId, reason: "x" })
      .expect(400);

    const adj = await agent
      .post(`/api/admin/coop/financial-disputes/${ticketId}/adjustments`)
      .send({
        adjustmentType: "adjustment",
        amount: 37.25,
        creditTenantId: salonId,
        debitTenantId: cafeId,
        reason: "Compensate under-counted referrals",
      })
      .expect(200);
    expect(adj.body.adjustments).toHaveLength(1);
    expect(adj.body.adjustments[0].amount).toBe(37.25);

    const rev = await agent
      .post(`/api/admin/coop/financial-disputes/${ticketId}/adjustments`)
      .send({
        adjustmentType: "bounty_reversal",
        amount: 12,
        creditTenantId: cafeId,
        debitTenantId: salonId,
        reason: "Reverse referral bounty on invalidated claim",
      })
      .expect(200);
    expect(rev.body.adjustments).toHaveLength(2);
    expect(rev.body.adjustments[1].adjustmentType).toBe("bounty_reversal");
  });

  it("closes with a ruling as 'adjusted' when entries exist, and audits everything", async () => {
    const closed = await agent
      .post(`/api/admin/coop/financial-disputes/${ticketId}/ruling`)
      .send({ ruling: "Cafe under-reported; adjustment stands.", ruledAgainstTenantId: cafeId })
      .expect(200);
    expect(closed.body.status).toBe("adjusted");
    expect(closed.body.ruling).toContain("under-reported");
    expect(closed.body.ruledAgainstTenantId).toBe(cafeId);
    expect(closed.body.resolvedAt).not.toBeNull();
    const types = closed.body.events.map((e: { eventType: string }) => e.eventType);
    expect(types).toContain("adjustment_recorded");
    expect(types).toContain("ruling_issued");

    // Closed tickets refuse further mediation and merchant writes.
    await agent
      .post(`/api/admin/coop/financial-disputes/${ticketId}/ruling`)
      .send({ ruling: "again" })
      .expect(409);
    await agent
      .post(`/api/coop/financial-disputes/${ticketId}/evidence`)
      .set("x-tenant-id", String(salonId))
      .send({ receipts: [{ referenceNumber: "x", amount: 1, entryDate: new Date().toISOString() }] })
      .expect(409);
  });
});

describe("suspension enforcement + repeat-violator automation", () => {
  it("manual suspension pulls perks, blocks redemption and new partnerships, then lift restores", async () => {
    const { id: pId, code } = await createPartnership("susp", salonId, gymId);
    // Suspend the gym.
    const created = await agent
      .post("/api/admin/coop/suspensions")
      .send({ tenantId: gymId, reason: "Manual test suspension" })
      .expect(201);
    expect(created.body.status).toBe("active");
    expect(created.body.trigger).toBe("manual");
    // Double-suspension is rejected.
    await agent.post("/api/admin/coop/suspensions").send({ tenantId: gymId }).expect(409);

    // Perk no longer served to either side.
    const perks = await agent.get("/api/coop/perks").set("x-tenant-id", String(salonId)).expect(200);
    expect(perks.body.perks.some((k: { id: number }) => k.id === pId)).toBe(false);

    // Validation and redemption both fail.
    const validate = await agent
      .get(`/api/coop/redemptions/${code}`)
      .set("x-tenant-id", String(salonId))
      .expect(200);
    expect(validate.body.valid).toBe(false);
    expect(validate.body.reason).toContain("suspended");
    const redeem = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(salonId))
      .send({ code, passCode: `P-${RUN}-susp` })
      .expect(200);
    expect(redeem.body.valid).toBe(false);

    // Wallet-pass channels are blocked too — suspension can't be bypassed by
    // redeeming a previously issued pass through the wallet or gateway APIs.
    const [pass] = await db
      .insert(perkPassesTable)
      .values({
        partnershipId: pId,
        grantedByTenantId: gymId,
        customerPhone: "+15553157777",
        token: `WPASS-${RUN}-susp`,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    const walletValidate = await agent.get(`/api/coop/redemptions/${pass.token}`).expect(200);
    expect(walletValidate.body.valid).toBe(false);
    expect(walletValidate.body.reason).toContain("suspended");
    const walletRedeem = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(salonId))
      .send({ code: pass.token })
      .expect(200);
    expect(walletRedeem.body.valid).toBe(false);
    expect(walletRedeem.body.reason).toContain("suspended");

    // Gateway (developer API) validate + redeem inherit the same block.
    const tokenRes = await agent
      .post("/api/gateway/tokens")
      .set("x-tenant-id", String(salonId))
      .send({ label: `susp-${RUN}` })
      .expect(201);
    const gwAuth = { Authorization: `Bearer ${tokenRes.body.token}` };
    const gwValidate = await agent
      .post("/api/v1/gateway/vouchers/validate")
      .set(gwAuth)
      .send({ code: pass.token })
      .expect(200);
    expect(gwValidate.body.valid).toBe(false);
    expect(gwValidate.body.reason).toContain("suspended");
    const gwRedeem = await agent
      .post("/api/v1/gateway/redemptions")
      .set(gwAuth)
      .send({ code: pass.token })
      .expect(200);
    expect(gwRedeem.body.status).toBe("error");
    expect(gwRedeem.body.detail).toContain("suspended");
    // Nothing was written to the pass.
    const [passAfter] = await db
      .select()
      .from(perkPassesTable)
      .where(eq(perkPassesTable.id, pass.id));
    expect(passAfter.redeemedAt).toBeNull();

    // New invites blocked in both directions.
    await agent
      .post("/api/coop/invites")
      .set("x-tenant-id", String(gymId))
      .send({ partnerTenantId: cafeId, perkTitle: `Blocked ${RUN}` })
      .expect(403);
    await agent
      .post("/api/coop/invites")
      .set("x-tenant-id", String(cafeId))
      .send({ partnerTenantId: gymId, perkTitle: `Blocked ${RUN}` })
      .expect(403);

    // Lift reinstates everything.
    const lifted = await agent
      .post(`/api/admin/coop/suspensions/${created.body.id}/lift`)
      .expect(200);
    expect(lifted.body.status).toBe("lifted");
    await agent.post(`/api/admin/coop/suspensions/${created.body.id}/lift`).expect(409);
    const perksAfter = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(salonId))
      .expect(200);
    expect(perksAfter.body.perks.some((k: { id: number }) => k.id === pId)).toBe(true);
  });

  it("auto-suspends a tenant after the ruling threshold within the rolling window", async () => {
    // Three escalated tickets against the bar, each closed with a ruling
    // against it (default threshold 3 within 90 days).
    for (let i = 0; i < 3; i++) {
      const { id: pId } = await createPartnership(`rv${i}`, salonId, barId);
      const filed = await agent
        .post("/api/coop/financial-disputes")
        .set("x-tenant-id", String(salonId))
        .send({ partnershipId: pId, disputeType: "commission_mismatch", claimedCount: 8, expectedCount: 1, ...WINDOW })
        .expect(201);
      expect(filed.body.status).toBe("escalated");
      await agent
        .post(`/api/admin/coop/financial-disputes/${filed.body.id}/ruling`)
        .send({ ruling: `Ruling ${i + 1} against bar`, ruledAgainstTenantId: barId })
        .expect(200);
    }
    const suspensions = await db
      .select()
      .from(coopTenantSuspensionsTable)
      .where(eq(coopTenantSuspensionsTable.tenantId, barId));
    const active = suspensions.filter((s) => s.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0].trigger).toBe("repeat_violator");
    expect(active[0].rulingsCount).toBeGreaterThanOrEqual(3);
    expect(active[0].windowDays).toBeGreaterThan(0);

    // Suspension is visible in the admin list and blocks new partnerships.
    const list = await agent.get("/api/admin/coop/suspensions").expect(200);
    expect(
      list.body.some(
        (s: { tenantId: number; status: string; trigger: string }) =>
          s.tenantId === barId && s.status === "active" && s.trigger === "repeat_violator"
      )
    ).toBe(true);
    await agent
      .post("/api/coop/invites")
      .set("x-tenant-id", String(barId))
      .send({ partnerTenantId: cafeId, perkTitle: `Blocked rv ${RUN}` })
      .expect(403);
  });
});
