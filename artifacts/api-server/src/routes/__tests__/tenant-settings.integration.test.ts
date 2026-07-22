import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, sosSettingsTable } from "@workspace/db";
import { inArray, isNull, eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for per-tenant settings (/api/tenants/:id/settings)
// against the real dev database. Verifies each tenant gets its own settings
// row and that the legacy global /api/sos/settings record is untouched.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest
delete process.env.REPLIT_CONNECTORS_HOSTNAME; // no Twilio connector lookup
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `tset-${Date.now()}-${process.pid}`;

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
      { brandName: `Tenant A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `Tenant B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [tenantA, tenantB] = tenants.map((t) => t.id);
});

afterAll(async () => {
  // sos_settings rows cascade on tenant delete.
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantA, tenantB]));
});

describe("per-tenant settings", () => {
  it("auto-creates a settings row per tenant on first access", async () => {
    const resA = await agent.get(`/api/tenants/${tenantA}/settings`).expect(200);
    const resB = await agent.get(`/api/tenants/${tenantB}/settings`).expect(200);
    expect(resA.body.tenantId).toBe(tenantA);
    expect(resB.body.tenantId).toBe(tenantB);
    expect(resA.body.id).not.toBe(resB.body.id);
  });

  it("PATCH updates only that tenant's settings", async () => {
    await agent
      .patch(`/api/tenants/${tenantA}/settings`)
      .send({ businessName: `A Biz ${RUN}`, aiReceptionistEnabled: false })
      .expect(200);

    const resA = await agent.get(`/api/tenants/${tenantA}/settings`).expect(200);
    expect(resA.body.businessName).toBe(`A Biz ${RUN}`);
    expect(resA.body.aiReceptionistEnabled).toBe(false);

    // Other tenant keeps defaults.
    const resB = await agent.get(`/api/tenants/${tenantB}/settings`).expect(200);
    expect(resB.body.businessName).not.toBe(`A Biz ${RUN}`);

    // Legacy global row (tenant_id IS NULL) is untouched.
    const [globalRow] = await db
      .select()
      .from(sosSettingsTable)
      .where(isNull(sosSettingsTable.tenantId))
      .limit(1);
    if (globalRow) {
      expect(globalRow.businessName).not.toBe(`A Biz ${RUN}`);
    }
    const legacy = await agent.get("/api/sos/settings").expect(200);
    expect(legacy.body.tenantId).toBeNull();
    expect(legacy.body.businessName).not.toBe(`A Biz ${RUN}`);
  });

  it("404s for a missing tenant", async () => {
    await agent.get("/api/tenants/999999/settings").expect(404);
    await agent
      .patch("/api/tenants/999999/settings")
      .send({ businessName: "x" })
      .expect(404);
  });

  it("legacy PATCH /api/sos/settings still writes the global row only", async () => {
    const before = await agent.get(`/api/tenants/${tenantB}/settings`).expect(200);
    const legacyBefore = await agent.get("/api/sos/settings").expect(200);
    await agent
      .patch("/api/sos/settings")
      .send({ resourceLabel: `GlobalLabel-${RUN}` })
      .expect(200);
    const legacy = await agent.get("/api/sos/settings").expect(200);
    expect(legacy.body.resourceLabel).toBe(`GlobalLabel-${RUN}`);
    const after = await agent.get(`/api/tenants/${tenantB}/settings`).expect(200);
    expect(after.body.resourceLabel).toBe(before.body.resourceLabel);

    // Restore the legacy label so we don't leave test residue in dev data.
    const [globalRow] = await db
      .select({ id: sosSettingsTable.id })
      .from(sosSettingsTable)
      .where(isNull(sosSettingsTable.tenantId))
      .limit(1);
    if (globalRow) {
      await db
        .update(sosSettingsTable)
        .set({ resourceLabel: legacyBefore.body.resourceLabel })
        .where(eq(sosSettingsTable.id, globalRow.id));
    }
  });
});
