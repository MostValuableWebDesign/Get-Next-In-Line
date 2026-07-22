import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  clientProfilesTable,
  engagementRulesTable,
  messagesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for the concierge endpoints against the real dev
// database. Twilio env/connector lookups are disabled so all sends take the
// simulated path — no real SMS ever leaves this suite.
//
// Isolation: one throwaway tenant per run; all rows are scoped to it and
// deleted in afterAll (client_profiles / engagement_rules / message_logs all
// cascade on tenant delete).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest
delete process.env.REPLIT_CONNECTORS_HOSTNAME; // no Twilio connector lookup
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `concierge-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenantId: number;
let profileSmsId: number;
let profileNoPhoneId: number;
let profileEmailPrefId: number;
let upsellRuleId: number;

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `Concierge ${RUN}`, subdomain: RUN, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;

  const profiles = await db
    .insert(clientProfilesTable)
    .values([
      { tenantId, name: "Sms Client", phone: "+15551230001", preferredChannel: "sms" },
      { tenantId, name: "No Phone", phone: null, preferredChannel: "sms" },
      { tenantId, name: "Email Pref", phone: "+15551230002", preferredChannel: "email" },
    ])
    .returning({ id: clientProfilesTable.id });
  [profileSmsId, profileNoPhoneId, profileEmailPrefId] = profiles.map((p) => p.id);

  const [rule] = await db
    .insert(engagementRulesTable)
    .values({
      tenantId,
      ruleType: "upsell",
      isActive: true,
      config: {
        addOns: [
          { name: "Deep Conditioning", price: 25, compatibleServices: ["Haircut", "color"] },
          { name: "Scalp Massage", price: 15, compatibleServices: ["massage"] },
          { name: "Aromatherapy", price: 10 }, // compatible with everything
        ],
      },
    })
    .returning({ id: engagementRulesTable.id });
  upsellRuleId = rule.id;
});

afterAll(async () => {
  // Cascades to client_profiles, engagement_rules, message_logs.
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  // sos_messages rows written by the shared SMS service are not tenant-scoped.
  await db
    .delete(messagesTable)
    .where(inArray(messagesTable.toNumber, ["+15551230001", "+15551230002"]));
});

describe("POST /api/concierge/suggest-upsells", () => {
  it("requires authentication", async () => {
    const app = (await import("../../app")).default;
    await request(app)
      .post("/api/concierge/suggest-upsells")
      .send({ tenantId, serviceName: "Haircut" })
      .expect(401);
  });

  it("returns add-ons compatible with the service (case-insensitive) plus universal ones", async () => {
    const res = await agent
      .post("/api/concierge/suggest-upsells")
      .send({ tenantId, serviceName: "haircut" })
      .expect(200);
    const names = res.body.suggestions.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(["Aromatherapy", "Deep Conditioning"]);
    expect(res.body.suggestions[0].ruleId).toBe(upsellRuleId);
  });

  it("returns only universal add-ons for an unmatched service", async () => {
    const res = await agent
      .post("/api/concierge/suggest-upsells")
      .send({ tenantId, serviceName: "Manicure" })
      .expect(200);
    expect(res.body.suggestions.map((s: { name: string }) => s.name)).toEqual([
      "Aromatherapy",
    ]);
  });

  it("returns empty suggestions when the upsell rule is inactive", async () => {
    await db
      .update(engagementRulesTable)
      .set({ isActive: false })
      .where(eq(engagementRulesTable.id, upsellRuleId));
    const res = await agent
      .post("/api/concierge/suggest-upsells")
      .send({ tenantId, serviceName: "Haircut" })
      .expect(200);
    expect(res.body.suggestions).toEqual([]);
    await db
      .update(engagementRulesTable)
      .set({ isActive: true })
      .where(eq(engagementRulesTable.id, upsellRuleId));
  });

  it("404s for a missing tenant and 400s for invalid input", async () => {
    await agent
      .post("/api/concierge/suggest-upsells")
      .send({ tenantId: 99999999, serviceName: "Haircut" })
      .expect(404);
    const res = await agent
      .post("/api/concierge/suggest-upsells")
      .send({ tenantId })
      .expect(400);
    expect(res.body.error).toBe("Validation failed");
  });
});

describe("POST /api/concierge/dispatch-message", () => {
  it("dispatches via simulated SMS and records a message log", async () => {
    const res = await agent
      .post("/api/concierge/dispatch-message")
      .send({ tenantId, clientProfileId: profileSmsId, body: `Hello ${RUN}` })
      .expect(201);
    expect(res.body.status).toBe("simulated"); // no Twilio creds in tests
    expect(res.body.channel).toBe("sms");
    expect(res.body.toNumber).toBe("+15551230001");
    expect(res.body.jobType).toBe("manual");

    const [log] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, res.body.id));
    expect(log.tenantId).toBe(tenantId);
    expect(log.status).toBe("simulated");
    expect(log.body).toBe(`Hello ${RUN}`);
  });

  it("skips (409) when the profile has no phone number, still logging the attempt", async () => {
    const res = await agent
      .post("/api/concierge/dispatch-message")
      .send({ tenantId, clientProfileId: profileNoPhoneId, body: "Hi" })
      .expect(409);
    expect(res.body.status).toBe("skipped");
    expect(res.body.errorCode).toBe("no_phone");
  });

  it("skips (409) non-SMS preferred channels instead of silently dropping", async () => {
    const res = await agent
      .post("/api/concierge/dispatch-message")
      .send({ tenantId, clientProfileId: profileEmailPrefId, body: "Hi" })
      .expect(409);
    expect(res.body.status).toBe("skipped");
    expect(res.body.errorCode).toBe("unsupported_channel");
  });

  it("404s when the profile belongs to a different tenant", async () => {
    const [other] = await db
      .insert(tenantsTable)
      .values({ brandName: `Other ${RUN}`, subdomain: `other-${RUN}`, status: "active" })
      .returning({ id: tenantsTable.id });
    try {
      await agent
        .post("/api/concierge/dispatch-message")
        .send({ tenantId: other.id, clientProfileId: profileSmsId, body: "Hi" })
        .expect(404);
    } finally {
      await db.delete(tenantsTable).where(eq(tenantsTable.id, other.id));
    }
  });
});
