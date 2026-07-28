import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, sosSettingsTable } from "@workspace/db";
import { inArray, isNull, eq } from "drizzle-orm";
import { parseCallIntent } from "../../lib/receptionist";

// ---------------------------------------------------------------------------
// Integration tests for per-tenant settings isolation, custom service names,
// and the concierge rule/profile CRUD, against the real dev database.
//
// Isolation: two throwaway tenants per run; their settings rows cascade on
// tenant delete. The legacy/global (tenant_id NULL) settings record is only
// read, never mutated destructively (we restore its prior values).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest
delete process.env.REPLIT_CONNECTORS_HOSTNAME; // no Twilio connector lookup
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL; // force fallback parser
delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

const RUN = `tenset-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenantA: number;
let tenantB: number;

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
      { brandName: `Settings A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `Settings B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  tenantA = tenants[0].id;
  tenantB = tenants[1].id;
});

afterAll(async () => {
  // settings/profiles/rules/logs cascade on tenant delete
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantA, tenantB]));
});

describe("per-tenant settings", () => {
  it("auto-creates a tenant settings row seeded from the brand name", async () => {
    const res = await agent.get(`/api/tenants/${tenantA}/settings`).expect(200);
    expect(res.body.tenantId).toBe(tenantA);
    expect(res.body.businessName).toBe(`Settings A ${RUN}`);
    expect(res.body.serviceNames).toBe("");
  });

  it("404s for a missing tenant", async () => {
    await agent.get(`/api/tenants/99999999/settings`).expect(404);
    await agent
      .patch(`/api/tenants/99999999/settings`)
      .send({ businessName: "x" })
      .expect(404);
  });

  it("isolates updates between tenants and from the legacy record", async () => {
    const legacyBefore = await agent
      .get("/api/sos/settings")
      .set("x-tenant-id", "legacy")
      .expect(200);

    await agent
      .patch(`/api/tenants/${tenantA}/settings`)
      .send({
        businessName: "Tenant A Salon",
        aiReceptionistEnabled: false,
        smsFromNumber: "+15550001111",
        serviceNames: "Balayage, Gel Manicure",
      })
      .expect(200);

    const a = await agent.get(`/api/tenants/${tenantA}/settings`).expect(200);
    expect(a.body.businessName).toBe("Tenant A Salon");
    expect(a.body.aiReceptionistEnabled).toBe(false);
    expect(a.body.serviceNames).toBe("Balayage, Gel Manicure");

    // Tenant B untouched
    const b = await agent.get(`/api/tenants/${tenantB}/settings`).expect(200);
    expect(b.body.businessName).toBe(`Settings B ${RUN}`);
    expect(b.body.aiReceptionistEnabled).toBe(true);
    expect(b.body.serviceNames).toBe("");

    // Legacy record untouched
    const legacyAfter = await agent
      .get("/api/sos/settings")
      .set("x-tenant-id", "legacy")
      .expect(200);
    expect(legacyAfter.body.businessName).toBe(legacyBefore.body.businessName);
    expect(legacyAfter.body.aiReceptionistEnabled).toBe(
      legacyBefore.body.aiReceptionistEnabled,
    );
    expect(legacyAfter.body.tenantId).toBeNull();
  });

  it("legacy /sos/settings PATCH only touches the tenant_id-NULL row", async () => {
    const before = await db
      .select()
      .from(sosSettingsTable)
      .where(isNull(sosSettingsTable.tenantId));
    expect(before.length).toBe(1);
    const prior = before[0];

    const res = await agent
      .patch("/api/sos/settings")
      .set("x-tenant-id", "legacy")
      .send({ resourceLabel: "TestLabel" })
      .expect(200);
    expect(res.body.tenantId).toBeNull();
    expect(res.body.resourceLabel).toBe("TestLabel");

    // Tenant rows unaffected
    const a = await agent.get(`/api/tenants/${tenantA}/settings`).expect(200);
    expect(a.body.resourceLabel).not.toBe("TestLabel");

    // restore
    await db
      .update(sosSettingsTable)
      .set({ resourceLabel: prior.resourceLabel })
      .where(eq(sosSettingsTable.id, prior.id));
  });
});

describe("custom service names in the receptionist fallback parser", () => {
  it("matches a configured service name ahead of generic terms", async () => {
    const parsed = await parseCallIntent(
      "Hi, I'd like to book a balayage appointment tomorrow",
      "Pat",
      new Date().toISOString(),
      ["Balayage", "Gel Manicure"],
    );
    expect(parsed.usedAi).toBe(false);
    expect(parsed.intent).toBe("book_appointment");
    expect(parsed.serviceType).toBe("Balayage");
  });

  it("still falls back to generic keywords without custom names", async () => {
    const parsed = await parseCallIntent(
      "Can I book a cleaning today?",
      null,
      new Date().toISOString(),
      [],
    );
    expect(parsed.serviceType).toBe("cleaning");
  });
});

describe("concierge rule & profile CRUD", () => {
  let ruleId: number;
  let profileId: number;

  it("creates, updates, and deletes an engagement rule with config validation", async () => {
    const created = await agent
      .post(`/api/tenants/${tenantA}/engagement-rules`)
      .send({ ruleType: "reminder", config: { leadHours: 48 } })
      .expect(201);
    ruleId = created.body.id;
    expect(created.body.tenantId).toBe(tenantA);
    expect(created.body.config.leadHours).toBe(48);
    expect(created.body.config.template).toBeTruthy(); // default applied

    // invalid config rejected
    await agent
      .post(`/api/tenants/${tenantA}/engagement-rules`)
      .send({ ruleType: "reminder", config: { leadHours: -2 } })
      .expect(400);

    const updated = await agent
      .patch(`/api/tenants/${tenantA}/engagement-rules/${ruleId}`)
      .send({ isActive: false })
      .expect(200);
    expect(updated.body.isActive).toBe(false);

    // cross-tenant access blocked
    await agent
      .patch(`/api/tenants/${tenantB}/engagement-rules/${ruleId}`)
      .send({ isActive: true })
      .expect(404);
    await agent
      .delete(`/api/tenants/${tenantB}/engagement-rules/${ruleId}`)
      .expect(404);

    await agent.delete(`/api/tenants/${tenantA}/engagement-rules/${ruleId}`).expect(204);
    const list = await agent.get(`/api/tenants/${tenantA}/engagement-rules`).expect(200);
    expect(list.body.find((r: { id: number }) => r.id === ruleId)).toBeUndefined();
  });

  it("creates, lists, updates, and deletes client profiles per tenant", async () => {
    const created = await agent
      .post(`/api/tenants/${tenantA}/client-profiles`)
      .send({ name: "Casey Client", phone: "+15550002222" })
      .expect(201);
    profileId = created.body.id;
    expect(created.body.tenantId).toBe(tenantA);
    expect(created.body.preferredChannel).toBe("sms");

    // not visible under another tenant
    const otherList = await agent
      .get(`/api/tenants/${tenantB}/client-profiles`)
      .expect(200);
    expect(otherList.body.find((p: { id: number }) => p.id === profileId)).toBeUndefined();

    const updated = await agent
      .patch(`/api/tenants/${tenantA}/client-profiles/${profileId}`)
      .send({ smsOptIn: false })
      .expect(200);
    expect(updated.body.smsOptIn).toBe(false);

    await agent
      .patch(`/api/tenants/${tenantB}/client-profiles/${profileId}`)
      .send({ smsOptIn: true })
      .expect(404);

    await agent
      .delete(`/api/tenants/${tenantA}/client-profiles/${profileId}`)
      .expect(204);
  });

  it("exposes the tenant message dispatch log with status and error reasons", async () => {
    const profile = await agent
      .post(`/api/tenants/${tenantA}/client-profiles`)
      .send({ name: "No Phone", phone: null })
      .expect(201);
    await agent
      .post("/api/concierge/dispatch-message")
      .send({ tenantId: tenantA, clientProfileId: profile.body.id, body: "Hello!" })
      .expect(409); // skipped: no phone

    const logs = await agent.get(`/api/tenants/${tenantA}/message-logs`).expect(200);
    const log = logs.body.find(
      (l: { clientProfileId: number }) => l.clientProfileId === profile.body.id,
    );
    expect(log).toBeTruthy();
    expect(log.status).toBe("skipped");
    expect(log.errorCode).toBe("no_phone");
    expect(log.clientName).toBe("No Phone");
    expect(log.body).toBe("Hello!");

    // other tenant's log is empty of this entry
    const otherLogs = await agent.get(`/api/tenants/${tenantB}/message-logs`).expect(200);
    expect(otherLogs.body.find((l: { id: number }) => l.id === log.id)).toBeUndefined();
  });
});
