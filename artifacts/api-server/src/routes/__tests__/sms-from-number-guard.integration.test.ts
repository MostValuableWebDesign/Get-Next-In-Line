import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, sosSettingsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  isPlaceholderPhoneNumber,
  clearPlaceholderFromNumbers,
} from "../../lib/sms";

// ---------------------------------------------------------------------------
// Guards against leftover placeholder From numbers breaking a business's
// texts: settings routes must reject placeholder/invalid smsFromNumber
// values, and the startup sweep must clear existing placeholder rows.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest
delete process.env.REPLIT_CONNECTORS_HOSTNAME; // no Twilio connector lookup
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `smsfrom-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenantId: number;

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const [tenant] = await db
    .insert(tenantsTable)
    .values([{ brandName: `SmsFrom ${RUN}`, subdomain: `${RUN}-a`, status: "active" }])
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;
});

afterAll(async () => {
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantId]));
});

describe("placeholder detection", () => {
  it("flags 555 area-code and fictional 555-01XX exchange numbers", () => {
    expect(isPlaceholderPhoneNumber("+15550100000")).toBe(true); // legacy demo value
    expect(isPlaceholderPhoneNumber("+15551234567")).toBe(true);
    expect(isPlaceholderPhoneNumber("+12125550142")).toBe(true); // fictional exchange
    expect(isPlaceholderPhoneNumber("+12125551234")).toBe(false); // real-ish 555x line
    expect(isPlaceholderPhoneNumber("+12125559876")).toBe(false);
    expect(isPlaceholderPhoneNumber("+447911123456")).toBe(false); // non-NANP
    expect(isPlaceholderPhoneNumber(null)).toBe(false);
  });
});

describe("settings routes reject bad From numbers", () => {
  it("rejects a placeholder From number on the tenant settings route", async () => {
    const res = await agent
      .patch(`/api/tenants/${tenantId}/settings`)
      .send({ smsFromNumber: "+15550100000" })
      .expect(400);
    expect(res.body.message).toMatch(/placeholder/i);

    const [row] = await db
      .select({ smsFromNumber: sosSettingsTable.smsFromNumber })
      .from(sosSettingsTable)
      .where(eq(sosSettingsTable.tenantId, tenantId));
    expect(row.smsFromNumber ?? null).toBeNull();
  });

  it("rejects an unparsable From number on the SOS settings route", async () => {
    const res = await agent
      .patch("/api/sos/settings")
      .set("x-tenant-id", String(tenantId))
      .send({ smsFromNumber: "not-a-number" })
      .expect(400);
    expect(res.body.message).toMatch(/not a valid phone number/i);
  });

  it("accepts a real number (normalized to E.164) and allows clearing it", async () => {
    // No Twilio creds under test → ownership is unverifiable → allowed.
    const saved = await agent
      .patch(`/api/tenants/${tenantId}/settings`)
      .send({ smsFromNumber: "(212) 867-5309" })
      .expect(200);
    expect(saved.body.smsFromNumber).toBe("+12128675309");

    const cleared = await agent
      .patch(`/api/tenants/${tenantId}/settings`)
      .send({ smsFromNumber: "" })
      .expect(200);
    expect(cleared.body.smsFromNumber ?? null).toBeNull();
  });

  it("leaves smsFromNumber untouched when the update doesn't mention it", async () => {
    await agent
      .patch(`/api/tenants/${tenantId}/settings`)
      .send({ smsFromNumber: "+12128675309" })
      .expect(200);
    const res = await agent
      .patch(`/api/tenants/${tenantId}/settings`)
      .send({ businessName: `SmsFrom kept ${RUN}` })
      .expect(200);
    expect(res.body.smsFromNumber).toBe("+12128675309");
    // clean up the override for the sweep test below
    await agent
      .patch(`/api/tenants/${tenantId}/settings`)
      .send({ smsFromNumber: "" })
      .expect(200);
  });
});

describe("placeholder cleanup sweep", () => {
  it("clears placeholder rows but keeps real overrides", async () => {
    // Plant a placeholder directly (bypassing the now-guarded API).
    await db
      .update(sosSettingsTable)
      .set({ smsFromNumber: "+15550100000" })
      .where(eq(sosSettingsTable.tenantId, tenantId));

    const cleared = await clearPlaceholderFromNumbers();
    expect(cleared).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({ smsFromNumber: sosSettingsTable.smsFromNumber })
      .from(sosSettingsTable)
      .where(eq(sosSettingsTable.tenantId, tenantId));
    expect(row.smsFromNumber).toBeNull();

    // A real override survives the sweep.
    await db
      .update(sosSettingsTable)
      .set({ smsFromNumber: "+12128675309" })
      .where(eq(sosSettingsTable.tenantId, tenantId));
    await clearPlaceholderFromNumbers();
    const [kept] = await db
      .select({ smsFromNumber: sosSettingsTable.smsFromNumber })
      .from(sosSettingsTable)
      .where(eq(sosSettingsTable.tenantId, tenantId));
    expect(kept.smsFromNumber).toBe("+12128675309");
  });

  it("a placeholder planted in settings is ignored by the effective From number", async () => {
    await db
      .update(sosSettingsTable)
      .set({ smsFromNumber: "+15550100000" })
      .where(eq(sosSettingsTable.tenantId, tenantId));

    const res = await agent
      .get(`/api/tenants/${tenantId}/settings`)
      .expect(200);
    // Placeholder override must never become the active number; it is
    // reported as ignored so the UI can flag it.
    expect(res.body.smsActiveFromNumber).not.toBe("+15550100000");
    expect(res.body.smsIgnoredFromNumber).toBe("+15550100000");
  });
});
