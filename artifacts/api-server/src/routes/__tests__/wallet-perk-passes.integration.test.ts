import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  sosCustomersTable,
  sosVisitsTable,
  perkPassesTable,
  walletLoginCodesTable,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Customer Loyalty & Cross-Perk Wallet, against the real dev DB. Covers:
// pass granting on visit check-out (including idempotency and no-phone skip),
// SMS login code request/verify (wrong code, single-use consume), the
// session-gated wallet listing, single-use wallet-pass redemption (expired /
// double-redeem rejections), and the expiry-reminder sweep's send-once claim.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `wallet-${Date.now()}-${process.pid}`;
const SERVICE = `wallet-svc-${RUN}`;
// Unique per-run phone so parallel runs never share wallet rows.
const PHONE = `+1988${String(Date.now()).slice(-7)}`;

let agent: ReturnType<typeof request.agent>;
let anon: ReturnType<typeof request>;
let hostId: number; // the business where the customer checks out
let partnerId: number; // the partner business granting the cross-perk
let partnershipId: number;
let customerId: number;

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
      { brandName: `Wallet Host ${RUN}`, subdomain: `${RUN}-host`, status: "active" },
      { brandName: `Wallet Partner ${RUN}`, subdomain: `${RUN}-partner`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [hostId, partnerId] = tenants.map((t) => t.id);

  const [p] = await db
    .insert(merchantCoopPartnershipsTable)
    .values({
      hostTenantId: hostId,
      partnerTenantId: partnerId,
      perkTitle: `Free pastry ${RUN}`,
      perkDescription: "One free pastry with any visit",
      redemptionCode: `COOP-${RUN}`,
      status: "accepted",
      isActive: true,
    })
    .returning({ id: merchantCoopPartnershipsTable.id });
  partnershipId = p.id;

  const [customer] = await db
    .insert(sosCustomersTable)
    .values({ tenantId: hostId, name: `Wallet Customer ${RUN}`, phone: PHONE })
    .returning({ id: sosCustomersTable.id });
  customerId = customer.id;
});

afterAll(async () => {
  await db.delete(walletLoginCodesTable).where(eq(walletLoginCodesTable.phone, PHONE));
  const tenantIds = [hostId, partnerId].filter((n) => Number.isInteger(n));
  if (tenantIds.length) {
    // Cascades clean up customers, visits, partnerships, and perk passes.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
  }
});

async function checkoutVisit(custId: number) {
  const [visit] = await db
    .insert(sosVisitsTable)
    .values({
      tenantId: hostId,
      customerId: custId,
      serviceType: SERVICE,
      status: "in_service",
      checkedInAt: new Date(),
      serviceStartedAt: new Date(),
    })
    .returning();
  await agent
    .post(`/api/sos/visits/${visit.id}/advance`)
    .set("x-tenant-id", String(hostId))
    .send({ action: "check_out" })
    .expect(200);
}

const passesForPhone = () =>
  db
    .select()
    .from(perkPassesTable)
    .where(
      and(eq(perkPassesTable.partnershipId, partnershipId), eq(perkPassesTable.customerPhone, PHONE))
    );

describe("perk pass granting at checkout", () => {
  it("deposits a wallet pass when the visit checks out, idempotently", async () => {
    await checkoutVisit(customerId);
    let passes = await passesForPhone();
    expect(passes).toHaveLength(1);
    expect(passes[0].token.startsWith("WPASS-")).toBe(true);
    expect(passes[0].grantedByTenantId).toBe(hostId);
    expect(passes[0].expiresAt.getTime()).toBeGreaterThan(Date.now());

    // A second checkout while the pass is still valid grants nothing new.
    await checkoutVisit(customerId);
    passes = await passesForPhone();
    expect(passes).toHaveLength(1);
  });

  it("skips granting for customers without a phone number", async () => {
    const [noPhone] = await db
      .insert(sosCustomersTable)
      .values({ tenantId: hostId, name: `No Phone ${RUN}`, phone: null })
      .returning({ id: sosCustomersTable.id });
    await checkoutVisit(noPhone.id);
    const rows = await db
      .select()
      .from(perkPassesTable)
      .where(eq(perkPassesTable.partnershipId, partnershipId));
    // Still only the phone customer's pass.
    expect(rows.every((r) => r.customerPhone === PHONE)).toBe(true);
  });
});

describe("wallet SMS login", () => {
  let sessionToken: string;

  it("issues a code, rejects wrong codes, and verifies the right one once", async () => {
    const reqRes = await anon
      .post("/api/wallet/login/request")
      .send({ phone: PHONE })
      .expect(200);
    expect(reqRes.body.sent).toBe(true);
    expect(reqRes.body.phone).toBe(PHONE);

    const [row] = await db
      .select()
      .from(walletLoginCodesTable)
      .where(eq(walletLoginCodesTable.phone, PHONE))
      .orderBy(desc(walletLoginCodesTable.id))
      .limit(1);
    expect(row.code).toMatch(/^\d{6}$/);

    // Wrong code fails and bumps the attempt counter.
    const wrong = row.code === "000000" ? "000001" : "000000";
    await anon.post("/api/wallet/login/verify").send({ phone: PHONE, code: wrong }).expect(400);

    const verify = await anon
      .post("/api/wallet/login/verify")
      .send({ phone: PHONE, code: row.code })
      .expect(200);
    expect(typeof verify.body.token).toBe("string");
    expect(verify.body.token.length).toBeGreaterThan(20);
    sessionToken = verify.body.token;

    // The code is single-use: replaying it fails.
    await anon.post("/api/wallet/login/verify").send({ phone: PHONE, code: row.code }).expect(400);
  });

  it("gates wallet reads on the session token", async () => {
    await anon.get("/api/wallet/passes").expect(401);

    const list = await anon
      .get("/api/wallet/passes")
      .set("x-wallet-session", sessionToken)
      .expect(200);
    expect(list.body.phone).toBe(PHONE);
    const mine = list.body.passes.filter(
      (p: { perkTitle: string }) => p.perkTitle === `Free pastry ${RUN}`
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe("active");
    expect(mine[0].redeemAtBusinessName).toBe(`Wallet Partner ${RUN}`);
    expect(mine[0].grantedByBusinessName).toBe(`Wallet Host ${RUN}`);

    const detail = await anon
      .get(`/api/wallet/passes/${mine[0].id}`)
      .set("x-wallet-session", sessionToken)
      .expect(200);
    expect(detail.body.qrPayload).toBe(mine[0].token);
  });
});

describe("wallet pass redemption at the partner storefront", () => {
  it("validates, redeems exactly once, and rejects the second attempt", async () => {
    const [pass] = await passesForPhone();

    const validate = await agent.get(`/api/coop/redemptions/${pass.token}`).expect(200);
    expect(validate.body.valid).toBe(true);

    const first = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(partnerId))
      .send({ code: pass.token })
      .expect(200);
    expect(first.body.valid).toBe(true);
    expect(first.body.redeemedAt).toBeTruthy();

    const second = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(partnerId))
      .send({ code: pass.token })
      .expect(200);
    expect(second.body.valid).toBe(false);
    expect(second.body.reason).toBe("This pass was already redeemed");

    const [after] = await passesForPhone();
    expect(after.redeemedByTenantId).toBe(partnerId);
  });

  it("rejects expired passes and unknown tokens with clear reasons", async () => {
    const [expired] = await db
      .insert(perkPassesTable)
      .values({
        partnershipId,
        customerPhone: PHONE,
        grantedByTenantId: hostId,
        token: `WPASS-expired-${RUN}`,
        expiresAt: new Date(Date.now() - 60_000),
      })
      .returning();
    const res = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(partnerId))
      .send({ code: expired.token })
      .expect(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toBe("This pass has expired");

    const unknown = await agent
      .get(`/api/coop/redemptions/WPASS-nope-${RUN}`)
      .expect(200);
    expect(unknown.body.valid).toBe(false);
    expect(unknown.body.reason).toBe("Unknown pass");
  });
});

describe("expiry reminder sweep", () => {
  it("sends one reminder per expiring pass and never repeats", async () => {
    const { sweepPerkExpiryReminders } = await import("../../workers/concierge");
    // A fresh unredeemed pass expiring within the 48h window.
    const [pass] = await db
      .insert(perkPassesTable)
      .values({
        partnershipId,
        customerPhone: PHONE,
        customerName: `Wallet Customer ${RUN}`,
        grantedByTenantId: hostId,
        token: `WPASS-reminder-${RUN}`,
        expiresAt: new Date(Date.now() + 12 * 3_600_000),
      })
      .returning();

    await sweepPerkExpiryReminders();
    const [afterFirst] = await db
      .select()
      .from(perkPassesTable)
      .where(eq(perkPassesTable.id, pass.id));
    expect(afterFirst.reminderSentAt).not.toBeNull();

    // Second tick must not re-claim (send-once lock).
    await sweepPerkExpiryReminders();
    const [afterSecond] = await db
      .select()
      .from(perkPassesTable)
      .where(eq(perkPassesTable.id, pass.id));
    expect(afterSecond.reminderSentAt?.getTime()).toBe(afterFirst.reminderSentAt?.getTime());
  });
});
