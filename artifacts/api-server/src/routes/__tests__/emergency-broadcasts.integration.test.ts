import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosCustomersTable,
  merchantCoopPartnershipsTable,
  emergencyBroadcastsTable,
  emergencyBroadcastTargetsTable,
  messagesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { sweepEmergencyBroadcastFanout } from "../../lib/emergencyBroadcasts";

// ---------------------------------------------------------------------------
// Co-Op Emergency & Crisis Network Broadcast (/coop/emergency/*), against the
// real dev DB. Covers: merchant local-leader authorization (accepted+active
// partnership required), network-scoped fan-out with no cross-network leakage,
// SMS fan-out idempotency via the sweep's send-once claim, check-in
// create/update + roster visibility, resolve behavior (sender/admin only,
// banners clear), admin selected-scope targeting, and the public landing
// page status surface.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `emerg-${Date.now()}-${process.pid}`;
const phoneBase = 4000000000 + (Date.now() % 1000000000);
const phone = (n: number) => `+1${phoneBase + n}`;

let agent: ReturnType<typeof request.agent>;
let anon: ReturnType<typeof request>;

// Salon ↔ Cafe are accepted+active partners (one network). Gym has only a
// deactivated pact with Salon. Outsider has no partnerships at all.
let salonId: number;
let cafeId: number;
let gymId: number;
let outsiderId: number;
const asTenant = (id: number) => String(id);

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
      { brandName: `Emerg Salon ${RUN}`, subdomain: `${RUN}-salon`, status: "active" },
      { brandName: `Emerg Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Emerg Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
      { brandName: `Emerg Outsider ${RUN}`, subdomain: `${RUN}-outsider`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [salonId, cafeId, gymId, outsiderId] = tenants.map((t) => t.id);

  await db.insert(merchantCoopPartnershipsTable).values([
    {
      hostTenantId: salonId,
      partnerTenantId: cafeId,
      perkTitle: `Emerg perk ${RUN}`,
      redemptionCode: `EMRG-${RUN}-A`,
      status: "accepted",
      isActive: true,
    },
    {
      // Accepted but deactivated — gym must NOT be targeted.
      hostTenantId: gymId,
      partnerTenantId: salonId,
      perkTitle: `Emerg perk off ${RUN}`,
      redemptionCode: `EMRG-${RUN}-B`,
      status: "accepted",
      isActive: false,
    },
  ]);

  // Subscribers: cafe has one opted-in, one opted-out; salon one opted-in.
  await db.insert(sosCustomersTable).values([
    { tenantId: cafeId, name: `CafeSub ${RUN}`, phone: phone(1), smsOptIn: true },
    { tenantId: cafeId, name: `CafeOptOut ${RUN}`, phone: phone(2), smsOptIn: false },
    { tenantId: salonId, name: `SalonSub ${RUN}`, phone: phone(3), smsOptIn: true },
    { tenantId: gymId, name: `GymSub ${RUN}`, phone: phone(4), smsOptIn: true },
  ]);
});

afterAll(async () => {
  const ids = [salonId, cafeId, gymId, outsiderId].filter((n) => Number.isInteger(n));
  if (ids.length) {
    const bIds = (
      await db
        .select({ id: emergencyBroadcastsTable.id })
        .from(emergencyBroadcastsTable)
        .where(inArray(emergencyBroadcastsTable.senderTenantId, ids))
    ).map((r) => r.id);
    if (bIds.length) {
      await db.delete(emergencyBroadcastsTable).where(inArray(emergencyBroadcastsTable.id, bIds));
    }
    // Admin-sent broadcasts (senderTenantId NULL) targeting only our tenants.
    await db
      .delete(emergencyBroadcastTargetsTable)
      .where(inArray(emergencyBroadcastTargetsTable.tenantId, ids));
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
    await db.delete(messagesTable).where(inArray(messagesTable.tenantId, ids));
  }
});

describe("merchant local-leader broadcasts", () => {
  let broadcastId: number;

  it("rejects a tenant with no accepted active partnerships", async () => {
    await agent
      .post("/api/coop/emergency/broadcasts")
      .set("x-tenant-id", asTenant(outsiderId))
      .send({
        severity: "critical",
        alertType: "safety_alert",
        headline: `No network ${RUN}`,
        message: "should fail",
      })
      .expect(403);
  });

  it("requires a session", async () => {
    await anon
      .post("/api/coop/emergency/broadcasts")
      .set("x-tenant-id", asTenant(salonId))
      .send({
        severity: "info",
        alertType: "other",
        headline: "x",
        message: "y",
      })
      .expect(401);
  });

  it("targets exactly the accepted+active network (sender + partners), never inactive or outside tenants", async () => {
    const res = await agent
      .post("/api/coop/emergency/broadcasts")
      .set("x-tenant-id", asTenant(salonId))
      .send({
        severity: "critical",
        alertType: "weather_closure",
        headline: `Flash flood ${RUN}`,
        message: "Plaza is closing early; stay safe.",
      })
      .expect(201);
    broadcastId = res.body.id;
    expect(res.body.scope).toBe("network");
    expect(res.body.senderTenantId).toBe(salonId);
    expect(res.body.status).toBe("active");
    const rosterIds = res.body.roster.map((r: { tenantId: number }) => r.tenantId).sort();
    expect(rosterIds).toEqual([salonId, cafeId].sort());
    // Gym (deactivated pact) and Outsider must not be targets.
    expect(rosterIds).not.toContain(gymId);
    expect(rosterIds).not.toContain(outsiderId);
  });

  it("SMS fan-out reaches opted-in subscribers of every target, once, with the emergency origin kind", async () => {
    // The route already kicked the sweep; run it again to prove idempotency.
    await sweepEmergencyBroadcastFanout();
    await sweepEmergencyBroadcastFanout();

    // The post-create kick is fire-and-forget: give its sends a moment to
    // finalize from "pending" to sent/simulated before asserting.
    for (let i = 0; i < 20; i++) {
      const rows = await db
        .select({ status: messagesTable.status })
        .from(messagesTable)
        .where(
          and(
            inArray(messagesTable.tenantId, [salonId, cafeId]),
            eq(messagesTable.kind, "emergency_broadcast"),
          ),
        );
      if (rows.length >= 2 && rows.every((r) => r.status !== "pending")) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    const msgs = await db
      .select()
      .from(messagesTable)
      .where(
        and(
          inArray(messagesTable.tenantId, [salonId, cafeId, gymId, outsiderId]),
          eq(messagesTable.kind, "emergency_broadcast"),
        ),
      );
    const byTenant = new Map<number, number>();
    for (const m of msgs) byTenant.set(m.tenantId!, (byTenant.get(m.tenantId!) ?? 0) + 1);
    expect(byTenant.get(cafeId)).toBe(1); // opted-out subscriber skipped
    expect(byTenant.get(salonId)).toBe(1);
    expect(byTenant.get(gymId)).toBeUndefined();
    expect(byTenant.get(outsiderId)).toBeUndefined();
    const cafeMsg = msgs.find((m) => m.tenantId === cafeId)!;
    expect(cafeMsg.body).toContain(`Flash flood ${RUN}`);
    expect(["sent", "simulated"]).toContain(cafeMsg.status);
  });

  it("shows the active alert to targets and hides it from outsiders", async () => {
    const cafeActive = await agent
      .get("/api/coop/emergency/active")
      .set("x-tenant-id", asTenant(cafeId))
      .expect(200);
    expect(cafeActive.body.map((b: { id: number }) => b.id)).toContain(broadcastId);

    const gymActive = await agent
      .get("/api/coop/emergency/active")
      .set("x-tenant-id", asTenant(gymId))
      .expect(200);
    expect(gymActive.body.map((b: { id: number }) => b.id)).not.toContain(broadcastId);

    // Outsider can't see the roster or the broadcast at all.
    await agent
      .get(`/api/coop/emergency/broadcasts/${broadcastId}/checkins`)
      .set("x-tenant-id", asTenant(outsiderId))
      .expect(404);
    const outsiderList = await agent
      .get("/api/coop/emergency/broadcasts")
      .set("x-tenant-id", asTenant(outsiderId))
      .expect(200);
    expect(outsiderList.body.map((b: { id: number }) => b.id)).not.toContain(broadcastId);
  });

  it("targets can check in and update their status; roster reflects it", async () => {
    const first = await agent
      .post(`/api/coop/emergency/broadcasts/${broadcastId}/checkin`)
      .set("x-tenant-id", asTenant(cafeId))
      .send({ status: "temporarily_closed", note: "Water in the basement" })
      .expect(200);
    expect(first.body.status).toBe("temporarily_closed");

    // Update in place (no duplicate rows).
    await agent
      .post(`/api/coop/emergency/broadcasts/${broadcastId}/checkin`)
      .set("x-tenant-id", asTenant(cafeId))
      .send({ status: "open" })
      .expect(200);

    const roster = await agent
      .get(`/api/coop/emergency/broadcasts/${broadcastId}/checkins`)
      .set("x-tenant-id", asTenant(salonId))
      .expect(200);
    const cafeEntry = roster.body.find((r: { tenantId: number }) => r.tenantId === cafeId);
    expect(cafeEntry.status).toBe("open");
    const salonEntry = roster.body.find((r: { tenantId: number }) => r.tenantId === salonId);
    expect(salonEntry.status).toBeNull();
  });

  it("non-targets cannot check in", async () => {
    await agent
      .post(`/api/coop/emergency/broadcasts/${broadcastId}/checkin`)
      .set("x-tenant-id", asTenant(gymId))
      .send({ status: "open" })
      .expect(404);
  });

  it("public landing page shows the latest check-in while the alert is active", async () => {
    const res = await anon.get(`/api/public/landing/${RUN}-cafe`).expect(200);
    expect(res.text).toContain("Community Alert");
    expect(res.text).toContain(`Flash flood ${RUN}`);
    expect(res.text).toContain("Open");

    // Salon hasn't checked in: pending copy instead of a status.
    const salon = await anon.get(`/api/public/landing/${RUN}-salon`).expect(200);
    expect(salon.text).toContain("has not posted a status update yet");

    // Gym is outside the network: no alert section at all.
    const gym = await anon.get(`/api/public/landing/${RUN}-gym`).expect(200);
    expect(gym.text).not.toContain("Community Alert");
  });

  it("only the sender (or admin) may resolve; resolution clears banners and landing status", async () => {
    await agent
      .post(`/api/coop/emergency/broadcasts/${broadcastId}/resolve`)
      .set("x-tenant-id", asTenant(cafeId))
      .expect(403);

    const res = await agent
      .post(`/api/coop/emergency/broadcasts/${broadcastId}/resolve`)
      .set("x-tenant-id", asTenant(salonId))
      .expect(200);
    expect(res.body.status).toBe("resolved");
    expect(res.body.resolvedAt).toBeTruthy();

    // Resolving twice conflicts.
    await agent
      .post(`/api/coop/emergency/broadcasts/${broadcastId}/resolve`)
      .set("x-tenant-id", asTenant(salonId))
      .expect(409);

    // Banner source is empty and check-ins are frozen.
    const active = await agent
      .get("/api/coop/emergency/active")
      .set("x-tenant-id", asTenant(cafeId))
      .expect(200);
    expect(active.body.map((b: { id: number }) => b.id)).not.toContain(broadcastId);
    await agent
      .post(`/api/coop/emergency/broadcasts/${broadcastId}/checkin`)
      .set("x-tenant-id", asTenant(cafeId))
      .send({ status: "safe" })
      .expect(409);

    // Landing page returns to normal.
    const landing = await anon.get(`/api/public/landing/${RUN}-cafe`).expect(200);
    expect(landing.text).not.toContain("Community Alert");
  });
});

describe("admin broadcasts", () => {
  it("unscoped create requires platform admin (anon gets 401)", async () => {
    await anon
      .post("/api/coop/emergency/broadcasts")
      .send({ severity: "info", alertType: "other", headline: "x", message: "y" })
      .expect(401);
  });

  it("selected scope targets exactly the chosen tenants and rejects unknown ids", async () => {
    await agent
      .post("/api/coop/emergency/broadcasts")
      .send({
        severity: "warning",
        alertType: "power_outage",
        headline: `Grid work ${RUN}`,
        message: "x",
        scope: "selected",
        targetTenantIds: [outsiderId, 99999999],
      })
      .expect(400);

    const res = await agent
      .post("/api/coop/emergency/broadcasts")
      .send({
        severity: "warning",
        alertType: "power_outage",
        headline: `Grid maintenance ${RUN}`,
        message: "Power out downtown until 3pm.",
        scope: "selected",
        targetTenantIds: [outsiderId, gymId],
      })
      .expect(201);
    expect(res.body.senderTenantId).toBeNull();
    expect(res.body.senderName).toBe("Platform Administration");
    const rosterIds = res.body.roster.map((r: { tenantId: number }) => r.tenantId).sort();
    expect(rosterIds).toEqual([outsiderId, gymId].sort());

    // Targeted tenants see it and can check in; unrelated tenants don't.
    const gymActive = await agent
      .get("/api/coop/emergency/active")
      .set("x-tenant-id", asTenant(gymId))
      .expect(200);
    expect(gymActive.body.map((b: { id: number }) => b.id)).toContain(res.body.id);
    await agent
      .post(`/api/coop/emergency/broadcasts/${res.body.id}/checkin`)
      .set("x-tenant-id", asTenant(gymId))
      .send({ status: "safe" })
      .expect(200);
    const salonActive = await agent
      .get("/api/coop/emergency/active")
      .set("x-tenant-id", asTenant(salonId))
      .expect(200);
    expect(salonActive.body.map((b: { id: number }) => b.id)).not.toContain(res.body.id);

    // Admin resolves without a tenant scope.
    await agent.post(`/api/coop/emergency/broadcasts/${res.body.id}/resolve`).expect(200);
  });
});
