import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  merchantCoopPartnershipsTable,
  coopDisputesTable,
  messagesTable,
} from "@workspace/db";
import { escalateExpiredCoopDisputes } from "../../workers/concierge";
import { addBusinessDays } from "../coop";

// ── Co-op dispute resolution lifecycle ───────────────────────────────────────
// Filing (with alert + grace deadline), withdrawal, grace-period escalation
// pausing the perk, and the admin reinstate/ban/mediation-note queue.

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `coopdis-${Date.now()}-${process.pid}`;

let agent: TestAgent;
let salonId = 0; // reporter
let cafeId = 0; // reported
let gymId = 0; // outsider
let partnershipId = 0;
let redemptionCode = "";

async function createPartnership(suffix: string): Promise<{ id: number; code: string }> {
  const code = `COOP-${RUN}-${suffix}`.toUpperCase().slice(0, 40);
  const [p] = await db
    .insert(merchantCoopPartnershipsTable)
    .values({
      hostTenantId: salonId,
      partnerTenantId: cafeId,
      perkTitle: `Dispute perk ${RUN} ${suffix}`,
      redemptionCode: code,
      status: "accepted",
      isActive: true,
    })
    .returning({ id: merchantCoopPartnershipsTable.id });
  return { id: p.id, code };
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
      { brandName: `Dis Salon ${RUN}`, subdomain: `${RUN}-salon`, status: "active" },
      { brandName: `Dis Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Dis Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [salonId, cafeId, gymId] = tenants.map((t) => t.id);

  // Reported business has a public phone so the alert has a recipient.
  await db.insert(sosSettingsTable).values([
    { tenantId: cafeId, industryType: "restaurant", publicPhone: "+15550001111" },
  ]);

  const p = await createPartnership("main");
  partnershipId = p.id;
  redemptionCode = p.code;
});

afterAll(async () => {
  const ids = [salonId, cafeId, gymId].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length) await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
});

describe("business-day grace window", () => {
  it("skips weekends when computing the deadline", () => {
    // Friday 2026-07-24 + 7 business days = Tuesday 2026-08-04.
    const friday = new Date("2026-07-24T15:00:00Z");
    const deadline = addBusinessDays(friday, 7);
    expect(deadline.toISOString().slice(0, 10)).toBe("2026-08-04");
  });
});

describe("filing a dispute", () => {
  it("rejects filing on a deactivated partnership", async () => {
    const { id: pId } = await createPartnership("inactive");
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ isActive: false })
      .where(eq(merchantCoopPartnershipsTable.id, pId));
    await agent
      .post("/api/coop/disputes")
      .set("x-tenant-id", String(salonId))
      .send({ partnershipId: pId, category: "Inappropriate business conduct" })
      .expect(409);
  });

  it("allows only one live dispute even under concurrent filings", async () => {
    const { id: pId } = await createPartnership("race");
    const results = await Promise.all(
      [salonId, cafeId].map((tid) =>
        agent
          .post("/api/coop/disputes")
          .set("x-tenant-id", String(tid))
          .send({ partnershipId: pId, category: "Closed storefront/unresponsive" }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const live = await db
      .select()
      .from(coopDisputesTable)
      .where(eq(coopDisputesTable.partnershipId, pId));
    expect(live.filter((d) => d.status === "open")).toHaveLength(1);
  });

  it("rejects a tenant that is not a party to the partnership", async () => {
    await agent
      .post("/api/coop/disputes")
      .set("x-tenant-id", String(gymId))
      .send({ partnershipId, category: "Inappropriate business conduct" })
      .expect(403);
  });

  it("files a dispute, computes the grace deadline, and alerts the reported owner", async () => {
    const res = await agent
      .post("/api/coop/disputes")
      .set("x-tenant-id", String(salonId))
      .send({
        partnershipId,
        category: "Partner refusing valid digital perk",
        details: "Staff refused the QR pass twice.",
      })
      .expect(201);
    expect(res.body.status).toBe("open");
    expect(res.body.reportingTenantId).toBe(salonId);
    expect(res.body.reportedTenantId).toBe(cafeId);
    expect(res.body.category).toBe("Partner refusing valid digital perk");
    // Deadline is ~7 business days out: strictly more than 6 calendar days,
    // no more than 11 (7 business days spans at most two weekends).
    const days = (new Date(res.body.graceDeadlineAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThanOrEqual(11.1);

    // The alert went through the unified messaging pipeline to the reported tenant.
    const alerts = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.tenantId, cafeId));
    const alert = alerts.find(
      (m) => m.kind === "coop_dispute" && m.body.includes(`Dis Salon ${RUN}`),
    );
    expect(alert).toBeDefined();
    expect(alert!.status).not.toBe("failed");
  });

  it("rejects a second dispute while one is open, and both parties can see it", async () => {
    await agent
      .post("/api/coop/disputes")
      .set("x-tenant-id", String(cafeId))
      .send({ partnershipId, category: "Inappropriate business conduct" })
      .expect(409);

    for (const tid of [salonId, cafeId]) {
      const list = await agent
        .get("/api/coop/disputes")
        .set("x-tenant-id", String(tid))
        .expect(200);
      expect(list.body.some((d: { partnershipId: number }) => d.partnershipId === partnershipId)).toBe(true);
    }
  });
});

describe("withdrawal before escalation", () => {
  it("only the reporter can withdraw; withdrawal restores the partnership", async () => {
    const [dispute] = await db
      .select()
      .from(coopDisputesTable)
      .where(eq(coopDisputesTable.partnershipId, partnershipId));

    await agent
      .post(`/api/coop/disputes/${dispute.id}/withdraw`)
      .set("x-tenant-id", String(cafeId))
      .expect(403);

    const res = await agent
      .post(`/api/coop/disputes/${dispute.id}/withdraw`)
      .set("x-tenant-id", String(salonId))
      .expect(200);
    expect(res.body.status).toBe("withdrawn");
    expect(res.body.withdrawnAt).not.toBeNull();

    const [p] = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
    expect(p.disputeSuspended).toBe(false);

    // A withdrawn dispute cannot be withdrawn again.
    await agent
      .post(`/api/coop/disputes/${dispute.id}/withdraw`)
      .set("x-tenant-id", String(salonId))
      .expect(409);
  });
});

describe("grace-period escalation", () => {
  let dispute2Id = 0;

  it("escalates only disputes past their grace deadline and pauses the perk", async () => {
    const res = await agent
      .post("/api/coop/disputes")
      .set("x-tenant-id", String(salonId))
      .send({ partnershipId, category: "Closed storefront/unresponsive" })
      .expect(201);
    dispute2Id = res.body.id;

    // Before the deadline, the worker leaves it alone.
    await escalateExpiredCoopDisputes(new Date());
    let [d] = await db.select().from(coopDisputesTable).where(eq(coopDisputesTable.id, dispute2Id));
    expect(d.status).toBe("open");

    // Force the deadline into the past, then tick.
    await db
      .update(coopDisputesTable)
      .set({ graceDeadlineAt: new Date(Date.now() - 60_000) })
      .where(eq(coopDisputesTable.id, dispute2Id));
    const n = await escalateExpiredCoopDisputes(new Date());
    expect(n).toBeGreaterThanOrEqual(1);

    [d] = await db.select().from(coopDisputesTable).where(eq(coopDisputesTable.id, dispute2Id));
    expect(d.status).toBe("escalated");
    expect(d.escalatedAt).not.toBeNull();

    const [p] = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
    expect(p.disputeSuspended).toBe(true);
  });

  it("suspended partnerships stop serving the perk and fail redemption", async () => {
    const perks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(salonId))
      .expect(200);
    expect(
      perks.body.perks.some((k: { id: number }) => k.id === partnershipId),
    ).toBe(false);

    const validate = await agent.get(`/api/coop/redemptions/${redemptionCode}`).expect(200);
    expect(validate.body.valid).toBe(false);

    const redeem = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(cafeId))
      .send({ code: redemptionCode, passCode: `P-${RUN}` })
      .expect(200);
    expect(redeem.body.valid).toBe(false);
  });

  it("an escalated dispute can no longer be withdrawn by the reporter", async () => {
    await agent
      .post(`/api/coop/disputes/${dispute2Id}/withdraw`)
      .set("x-tenant-id", String(salonId))
      .expect(409);
  });

  it("admin mediation note keeps the dispute open and is timestamped", async () => {
    const res = await agent
      .post(`/api/admin/coop/disputes/${dispute2Id}/mediation-notes`)
      .send({ note: "Called both owners; cafe promises staff retraining." })
      .expect(200);
    expect(res.body.status).toBe("escalated");
    expect(res.body.mediationNotes).toContain("staff retraining");
    expect(res.body.mediationNotes).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
  });

  it("admin queue lists the dispute with status filtering", async () => {
    const all = await agent.get("/api/admin/coop/disputes").expect(200);
    expect(all.body.some((d: { id: number }) => d.id === dispute2Id)).toBe(true);

    const escalated = await agent.get("/api/admin/coop/disputes?status=escalated").expect(200);
    expect(escalated.body.some((d: { id: number }) => d.id === dispute2Id)).toBe(true);
    expect(escalated.body.every((d: { status: string }) => d.status === "escalated")).toBe(true);

    const withdrawn = await agent.get("/api/admin/coop/disputes?status=withdrawn").expect(200);
    expect(withdrawn.body.every((d: { status: string }) => d.status === "withdrawn")).toBe(true);
  });

  it("admin reinstate resolves the dispute and reactivates the perk", async () => {
    const res = await agent.post(`/api/admin/coop/disputes/${dispute2Id}/reinstate`).expect(200);
    expect(res.body.status).toBe("resolved");
    expect(res.body.resolvedAt).not.toBeNull();

    const [p] = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
    expect(p.disputeSuspended).toBe(false);
    expect(p.bannedAt).toBeNull();

    const perks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(salonId))
      .expect(200);
    expect(perks.body.perks.some((k: { id: number }) => k.id === partnershipId)).toBe(true);

    // Closed disputes reject further admin actions.
    await agent.post(`/api/admin/coop/disputes/${dispute2Id}/ban`).expect(409);
  });
});

describe("admin ban", () => {
  it("permanently bans the partnership behind the dispute", async () => {
    const { id: pId, code } = await createPartnership("ban");
    const filed = await agent
      .post("/api/coop/disputes")
      .set("x-tenant-id", String(cafeId))
      .send({ partnershipId: pId, category: "Inappropriate business conduct" })
      .expect(201);

    const res = await agent.post(`/api/admin/coop/disputes/${filed.body.id}/ban`).expect(200);
    expect(res.body.status).toBe("banned");

    const [p] = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, pId));
    expect(p.bannedAt).not.toBeNull();

    const validate = await agent.get(`/api/coop/redemptions/${code}`).expect(200);
    expect(validate.body.valid).toBe(false);

    // No new dispute can be filed on a banned partnership.
    await agent
      .post("/api/coop/disputes")
      .set("x-tenant-id", String(salonId))
      .send({ partnershipId: pId, category: "Closed storefront/unresponsive" })
      .expect(409);
  });
});
