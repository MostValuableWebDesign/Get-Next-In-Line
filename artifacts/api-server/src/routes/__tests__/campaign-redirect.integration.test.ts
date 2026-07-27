import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, campaignsTable, attributionEventsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Campaign redirect links (/r/:code) + admin campaign CRUD, against the real
// dev DB. Covers: successful redirect + logged attribution event, inactive /
// unknown / malformed codes → 404, the route being reachable without a
// session, and admin listing with click counts.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `campred-${Date.now()}-${process.pid}`;
const SLUG = `${RUN}-a`;
const CODE = `${RUN}-spring-promo`;

let agent: ReturnType<typeof request.agent>;
let anon: ReturnType<typeof request>;
let tenantId: number;
let campaignId: number;

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  anon = request(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `Campaign Redirect ${RUN}`, subdomain: SLUG, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;
});

afterAll(async () => {
  await db.delete(attributionEventsTable).where(eq(attributionEventsTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

describe("admin campaign management", () => {
  it("requires a session", async () => {
    await anon.get("/api/admin/campaigns").expect(401);
    await anon
      .post("/api/admin/campaigns")
      .send({ tenantId, name: "x" })
      .expect(401);
  });

  it("creates a campaign with an explicit code", async () => {
    const res = await agent
      .post("/api/admin/campaigns")
      .send({ tenantId, name: `Spring Promo ${RUN}`, code: CODE })
      .expect(201);
    campaignId = res.body.id;
    expect(res.body).toMatchObject({
      code: CODE,
      tenantId,
      isActive: true,
      clickCount: 0,
    });
  });

  it("rejects duplicate codes and unknown tenants", async () => {
    await agent
      .post("/api/admin/campaigns")
      .send({ tenantId, name: "Dup", code: CODE })
      .expect(400);
    await agent
      .post("/api/admin/campaigns")
      .send({ tenantId: 99999999, name: "Ghost" })
      .expect(404);
  });

  it("generates a code from the name when omitted", async () => {
    const res = await agent
      .post("/api/admin/campaigns")
      .send({ tenantId, name: `Yelp Listing ${RUN}` })
      .expect(201);
    expect(res.body.code).toMatch(/^yelp-listing-campred-/);
    // Clean up this extra campaign (tenant cascade also covers it).
    await db.delete(campaignsTable).where(eq(campaignsTable.id, res.body.id));
  });
});

describe("public redirect /r/:code", () => {
  it("redirects without a session and logs an attribution event", async () => {
    const res = await anon.get(`/api/r/${CODE}`).expect(302);
    expect(res.headers.location).toBe(
      `/api/public/landing/${SLUG}?ref=${encodeURIComponent(CODE)}`,
    );

    const events = await db
      .select()
      .from(attributionEventsTable)
      .where(eq(attributionEventsTable.campaignCode, CODE));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tenantId, eventType: "click" });
  });

  it("404s for unknown and malformed codes", async () => {
    await anon.get(`/api/r/no-such-code-${RUN}`).expect(404);
    await anon.get("/api/r/bad_code!").expect(404);
    await anon.get("/api/r/x").expect(404); // too short
  });

  it("404s once the campaign is deactivated, without logging events", async () => {
    await agent
      .patch(`/api/admin/campaigns/${campaignId}`)
      .send({ isActive: false })
      .expect(200);
    await anon.get(`/api/r/${CODE}`).expect(404);

    const events = await db
      .select()
      .from(attributionEventsTable)
      .where(eq(attributionEventsTable.campaignCode, CODE));
    expect(events).toHaveLength(1); // still just the first click

    // Reactivation restores the redirect.
    const upd = await agent
      .patch(`/api/admin/campaigns/${campaignId}`)
      .send({ isActive: true })
      .expect(200);
    expect(upd.body).toMatchObject({ isActive: true, clickCount: 1 });
    await anon.get(`/api/r/${CODE}`).expect(302);
  });

  it("shows click counts in the admin listing", async () => {
    const res = await agent.get("/api/admin/campaigns").expect(200);
    const mine = res.body.find((c: { id: number }) => c.id === campaignId);
    expect(mine).toBeTruthy();
    expect(mine.clickCount).toBe(2);
    expect(mine.tenantName).toBe(`Campaign Redirect ${RUN}`);
  });
});
