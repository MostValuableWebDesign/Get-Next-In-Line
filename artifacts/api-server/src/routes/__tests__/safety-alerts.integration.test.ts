import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  merchantCoopPartnershipsTable,
  safetyIncidentsTable,
  messagesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { decryptIncidentText, isEncryptedIncidentText } from "../../lib/safetyCrypto";

// ---------------------------------------------------------------------------
// Co-Op Emergency & Safety Alert Network (/coop/safety/*) against the real
// dev DB. Covers: broadcast fan-out to accepted+active partners only, tenant
// isolation (non-partnered tenants never see incidents), encryption of
// incident text at rest (round-trip through the API), acknowledge/update/
// resolve flows with role enforcement, the messages audit trail for partner
// SMS notifications (simulated mode), and contacts/templates defaults + CRUD
// tenant scoping.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `safety-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
// Salon partners with Cafe (accepted+active) and Gym (accepted but
// deactivated); Bystander has no partnership at all.
let salonId: number;
let cafeId: number;
let gymId: number;
let bystanderId: number;

const asTenant = (id: number) => String(id);

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
      { brandName: `Safety Salon ${RUN}`, subdomain: `${RUN}-salon`, status: "active" },
      { brandName: `Safety Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Safety Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
      { brandName: `Safety Bystander ${RUN}`, subdomain: `${RUN}-bystander`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [salonId, cafeId, gymId, bystanderId] = tenants.map((t) => t.id);

  // Cafe has a phone on file so its notification records a simulated SMS.
  await db.insert(sosSettingsTable).values([
    { tenantId: cafeId, publicPhone: "5551230001" },
  ]);

  await db.insert(merchantCoopPartnershipsTable).values([
    {
      hostTenantId: salonId,
      partnerTenantId: cafeId,
      perkTitle: `Safety perk ${RUN}`,
      redemptionCode: `SAFE-${RUN}-A`,
      status: "accepted",
      isActive: true,
    },
    {
      // Accepted but deactivated — must NOT receive broadcasts.
      hostTenantId: gymId,
      partnerTenantId: salonId,
      perkTitle: `Safety perk off ${RUN}`,
      redemptionCode: `SAFE-${RUN}-B`,
      status: "accepted",
      isActive: false,
    },
  ]);
});

afterAll(async () => {
  const ids = [salonId, cafeId, gymId, bystanderId].filter((n) => Number.isInteger(n));
  if (ids.length) {
    // Cascades clean up settings, partnerships, incidents, recipients,
    // events, contacts, templates, and the seeded markers.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
    await db.delete(messagesTable).where(inArray(messagesTable.tenantId, ids));
  }
});

describe("safety incident broadcast & isolation", () => {
  const DESCRIPTION = `Unattended bag by the door ${RUN}`;
  let incidentId: number;

  it("requires the x-tenant-id scope", async () => {
    await agent.get("/api/coop/safety/incidents").expect(400);
    await agent
      .post("/api/coop/safety/incidents")
      .send({ incidentType: "silent_panic", description: "x" })
      .expect(400);
  });

  it("raising an alert fans out to accepted+active partners only", async () => {
    const res = await agent
      .post("/api/coop/safety/incidents")
      .set("x-tenant-id", asTenant(salonId))
      .send({
        incidentType: "suspicious_activity",
        description: DESCRIPTION,
        location: "Front entrance",
      })
      .expect(201);
    incidentId = res.body.id;
    expect(res.body.direction).toBe("raised");
    expect(res.body.description).toBe(DESCRIPTION);
    expect(res.body.location).toBe("Front entrance");
    expect(res.body.status).toBe("active");
    // Only the cafe (accepted+active) — not the deactivated gym partnership.
    expect(res.body.recipientCount).toBe(1);
    expect(res.body.smsSentCount).toBe(1);
  });

  it("stores the incident description encrypted at rest", async () => {
    const [row] = await db
      .select()
      .from(safetyIncidentsTable)
      .where(eq(safetyIncidentsTable.id, incidentId));
    expect(row.description).not.toContain(DESCRIPTION);
    expect(isEncryptedIncidentText(row.description)).toBe(true);
    expect(decryptIncidentText(row.description)).toBe(DESCRIPTION);
  });

  it("records the partner SMS in the messages audit trail (simulated mode)", async () => {
    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.tenantId, cafeId));
    const alert = rows.find((m) => m.kind === "safety_alert");
    expect(alert).toBeDefined();
    expect(alert!.status).toBe("simulated");
    expect(alert!.body).toContain(`Safety Salon ${RUN}`);
    expect(alert!.body).toContain("Suspicious activity");
    // The sensitive description never leaves the app in the SMS.
    expect(alert!.body).not.toContain(DESCRIPTION);
  });

  it("the partner sees the incident as received, decrypted", async () => {
    const res = await agent
      .get("/api/coop/safety/incidents")
      .set("x-tenant-id", asTenant(cafeId))
      .expect(200);
    const incident = res.body.find((i: { id: number }) => i.id === incidentId);
    expect(incident).toBeDefined();
    expect(incident.direction).toBe("received");
    expect(incident.description).toBe(DESCRIPTION);
    expect(incident.tenantName).toBe(`Safety Salon ${RUN}`);
  });

  it("non-partnered and deactivated-partner tenants never see the incident", async () => {
    for (const t of [bystanderId, gymId]) {
      const res = await agent
        .get("/api/coop/safety/incidents")
        .set("x-tenant-id", asTenant(t))
        .expect(200);
      expect(res.body.find((i: { id: number }) => i.id === incidentId)).toBeUndefined();
      await agent
        .get(`/api/coop/safety/incidents/${incidentId}/timeline`)
        .set("x-tenant-id", asTenant(t))
        .expect(404);
    }
  });

  it("only a recipient can acknowledge; only the originator can update/resolve", async () => {
    // Originator cannot acknowledge its own alert.
    await agent
      .post(`/api/coop/safety/incidents/${incidentId}/acknowledge`)
      .set("x-tenant-id", asTenant(salonId))
      .expect(403);
    // Recipient cannot post updates or resolve.
    await agent
      .post(`/api/coop/safety/incidents/${incidentId}/updates`)
      .set("x-tenant-id", asTenant(cafeId))
      .send({ body: "not mine" })
      .expect(403);
    await agent
      .post(`/api/coop/safety/incidents/${incidentId}/resolve`)
      .set("x-tenant-id", asTenant(cafeId))
      .expect(403);
    // Bystander gets 404 (not even existence).
    await agent
      .post(`/api/coop/safety/incidents/${incidentId}/acknowledge`)
      .set("x-tenant-id", asTenant(bystanderId))
      .expect(404);
  });

  it("acknowledge → update → resolve flows update state and the audit trail", async () => {
    const ack = await agent
      .post(`/api/coop/safety/incidents/${incidentId}/acknowledge`)
      .set("x-tenant-id", asTenant(cafeId))
      .expect(200);
    expect(ack.body.acknowledgedAt).not.toBeNull();

    const upd = await agent
      .post(`/api/coop/safety/incidents/${incidentId}/updates`)
      .set("x-tenant-id", asTenant(salonId))
      .send({ body: `Police on the way ${RUN}` })
      .expect(200);
    expect(upd.body.acknowledgedCount).toBe(1);

    const resolved = await agent
      .post(`/api/coop/safety/incidents/${incidentId}/resolve`)
      .set("x-tenant-id", asTenant(salonId))
      .expect(200);
    expect(resolved.body.status).toBe("resolved");
    expect(resolved.body.resolvedAt).not.toBeNull();

    // Resolving or updating again is rejected.
    await agent
      .post(`/api/coop/safety/incidents/${incidentId}/resolve`)
      .set("x-tenant-id", asTenant(salonId))
      .expect(409);
    await agent
      .post(`/api/coop/safety/incidents/${incidentId}/updates`)
      .set("x-tenant-id", asTenant(salonId))
      .send({ body: "too late" })
      .expect(409);

    // Full timeline visible to both sides, decrypted, in order.
    for (const t of [salonId, cafeId]) {
      const timeline = await agent
        .get(`/api/coop/safety/incidents/${incidentId}/timeline`)
        .set("x-tenant-id", asTenant(t))
        .expect(200);
      expect(timeline.body.map((e: { kind: string }) => e.kind)).toEqual([
        "broadcast",
        "acknowledgment",
        "update",
        "resolution",
      ]);
      const update = timeline.body.find((e: { kind: string }) => e.kind === "update");
      expect(update.body).toBe(`Police on the way ${RUN}`);
      expect(update.actorTenantName).toBe(`Safety Salon ${RUN}`);
    }
  });
});

describe("emergency contacts & broadcast templates", () => {
  it("seeds defaults on first access, once", async () => {
    const first = await agent
      .get("/api/coop/safety/contacts")
      .set("x-tenant-id", asTenant(salonId))
      .expect(200);
    expect(first.body.length).toBe(3);
    expect(first.body.map((c: { category: string }) => c.category)).toContain("law_enforcement");

    const templates = await agent
      .get("/api/coop/safety/templates")
      .set("x-tenant-id", asTenant(salonId))
      .expect(200);
    expect(templates.body.length).toBe(3);

    // Deleting one and re-listing must NOT re-seed.
    await agent
      .delete(`/api/coop/safety/contacts/${first.body[0].id}`)
      .set("x-tenant-id", asTenant(salonId))
      .expect(204);
    const again = await agent
      .get("/api/coop/safety/contacts")
      .set("x-tenant-id", asTenant(salonId))
      .expect(200);
    expect(again.body.length).toBe(2);
  });

  it("contacts and templates are tenant-scoped for edit/delete", async () => {
    const created = await agent
      .post("/api/coop/safety/contacts")
      .set("x-tenant-id", asTenant(salonId))
      .send({ label: `Alarm company ${RUN}`, phone: "5559990000", category: "other" })
      .expect(201);
    // Another tenant cannot edit or delete it.
    await agent
      .patch(`/api/coop/safety/contacts/${created.body.id}`)
      .set("x-tenant-id", asTenant(cafeId))
      .send({ label: "hijack" })
      .expect(404);
    await agent
      .delete(`/api/coop/safety/contacts/${created.body.id}`)
      .set("x-tenant-id", asTenant(cafeId))
      .expect(404);

    const tmpl = await agent
      .post("/api/coop/safety/templates")
      .set("x-tenant-id", asTenant(salonId))
      .send({ title: `Gas leak ${RUN}`, incidentType: "safety_hazard", body: "Gas smell reported nearby." })
      .expect(201);
    await agent
      .patch(`/api/coop/safety/templates/${tmpl.body.id}`)
      .set("x-tenant-id", asTenant(cafeId))
      .send({ title: "hijack" })
      .expect(404);
    const edited = await agent
      .patch(`/api/coop/safety/templates/${tmpl.body.id}`)
      .set("x-tenant-id", asTenant(salonId))
      .send({ title: `Gas leak edited ${RUN}` })
      .expect(200);
    expect(edited.body.title).toBe(`Gas leak edited ${RUN}`);
  });
});
