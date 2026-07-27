import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  coopPlazaConflictsTable,
  merchantCoopPartnershipsTable,
  usersTable,
  userTenantMembershipsTable,
} from "@workspace/db";
import { eq, inArray, or } from "drizzle-orm";
import { randomBytes } from "crypto";

// ---------------------------------------------------------------------------
// Plaza exclusivity for the co-op network: businesses sharing a commercial
// complex (same street address block + postal code, or lat/long proximity)
// can't both pair with the same anchor's category. Covers: same-plaza invite
// blocking (both directions), the directory pre-flags, in-app notifications
// for both sides, the admin conflicts list + release override, and that
// cross-plaza / missing-address pairings are untouched.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `plaza-${Date.now()}-${process.pid}`;
const PLAZA_MESSAGE =
  "Plaza exclusivity: this business category is already represented by an active partnership in your commercial complex. Only one partner per category within the same plaza.";

let agent: ReturnType<typeof request.agent>;
// Same plaza (100-block of Main St, postal 90210): barber + two restaurants.
let barberId: number;
let restaurantAId: number;
let restaurantBId: number;
// Different plaza / postal / no address at all.
let restaurantFarId: number;
let restaurantNextPostalId: number;
let restaurantNoAddressId: number;
// Same-plaza-by-coordinates only (no street address).
let dinerByCoordsId: number;

let allIds: number[] = [];

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
      { brandName: `Plaza Barber ${RUN}`, subdomain: `${RUN}-barber`, status: "active" },
      { brandName: `Plaza Resto A ${RUN}`, subdomain: `${RUN}-resto-a`, status: "active" },
      { brandName: `Plaza Resto B ${RUN}`, subdomain: `${RUN}-resto-b`, status: "active" },
      { brandName: `Far Resto ${RUN}`, subdomain: `${RUN}-resto-far`, status: "active" },
      { brandName: `NextPostal Resto ${RUN}`, subdomain: `${RUN}-resto-np`, status: "active" },
      { brandName: `NoAddress Resto ${RUN}`, subdomain: `${RUN}-resto-na`, status: "active" },
      { brandName: `Coords Diner ${RUN}`, subdomain: `${RUN}-diner`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [
    barberId,
    restaurantAId,
    restaurantBId,
    restaurantFarId,
    restaurantNextPostalId,
    restaurantNoAddressId,
    dinerByCoordsId,
  ] = tenants.map((t) => t.id);
  allIds = tenants.map((t) => t.id);

  const RESTAURANT = `Restaurant-${RUN}`;
  await db.insert(sosSettingsTable).values([
    {
      tenantId: barberId,
      industryType: "barber",
      businessCategory: `Barber-${RUN}`,
      streetAddress: "120 Main St",
      postalCode: "90210",
      latitude: "40.7128",
      longitude: "-74.0060",
    },
    {
      tenantId: restaurantAId,
      industryType: "restaurant",
      businessCategory: RESTAURANT,
      streetAddress: "148 MAIN STREET, Suite B",
      postalCode: "90210",
    },
    {
      tenantId: restaurantBId,
      industryType: "restaurant",
      businessCategory: RESTAURANT,
      streetAddress: "160 Main Street",
      postalCode: "90210",
    },
    {
      tenantId: restaurantFarId,
      industryType: "restaurant",
      businessCategory: RESTAURANT,
      streetAddress: "900 Oak Ave",
      postalCode: "90299",
    },
    {
      // Same block, adjacent postal code — NOT the same plaza.
      tenantId: restaurantNextPostalId,
      industryType: "restaurant",
      businessCategory: RESTAURANT,
      streetAddress: "130 Main St",
      postalCode: "90211",
    },
    {
      // No address data at all — never matches any plaza.
      tenantId: restaurantNoAddressId,
      industryType: "restaurant",
      businessCategory: RESTAURANT,
    },
    {
      // No street address, but coordinates ~55 m from the barber.
      tenantId: dinerByCoordsId,
      industryType: "restaurant",
      businessCategory: RESTAURANT,
      latitude: "40.7133",
      longitude: "-74.0060",
    },
  ]);
});

afterAll(async () => {
  if (allIds.length) {
    await db
      .delete(coopPlazaConflictsTable)
      .where(
        or(
          inArray(coopPlazaConflictsTable.requesterTenantId, allIds),
          inArray(coopPlazaConflictsTable.blockedPartnerTenantId, allIds)
        )
      );
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, allIds));
  }
});

const invite = (from: number, to: number, perkTitle: string) =>
  agent
    .post("/api/coop/invites")
    .set("x-tenant-id", String(from))
    .send({ partnerTenantId: to, perkTitle });

describe("plaza exclusivity", () => {
  it("allows the first same-plaza pairing and activates it on acceptance", async () => {
    const created = await invite(barberId, restaurantAId, `Anchor perk ${RUN}`).expect(201);
    await agent
      .post(`/api/coop/invites/${created.body.id}/respond`)
      .set("x-tenant-id", String(restaurantAId))
      .send({ action: "accept" })
      .expect(200);
  });

  it("blocks a second same-plaza invite for the already-held category", async () => {
    const res = await invite(barberId, restaurantBId, `Second perk ${RUN}`).expect(403);
    expect(res.body.code).toBe("PLAZA_EXCLUSIVITY_RESTRICTED");
    expect(res.body.message).toBe(PLAZA_MESSAGE);
  });

  it("blocks the reverse direction too — the target already holds the requester's category", async () => {
    const res = await invite(restaurantBId, barberId, `Reverse perk ${RUN}`).expect(403);
    expect(res.body.code).toBe("PLAZA_EXCLUSIVITY_RESTRICTED");
  });

  it("blocks via lat/long proximity fallback when street data is missing", async () => {
    const res = await invite(barberId, dinerByCoordsId, `Coords perk ${RUN}`).expect(403);
    expect(res.body.code).toBe("PLAZA_EXCLUSIVITY_RESTRICTED");
  });

  it("leaves cross-plaza, adjacent-postal, and missing-address pairings untouched", async () => {
    await invite(barberId, restaurantFarId, `Far perk ${RUN}`).expect(201);
    await invite(barberId, restaurantNextPostalId, `Next-postal perk ${RUN}`).expect(201);
    await invite(barberId, restaurantNoAddressId, `No-address perk ${RUN}`).expect(201);
  });

  it("flags the conflict in the directory before an invite is attempted", async () => {
    const res = await agent
      .get("/api/coop/directory")
      .set("x-tenant-id", String(barberId))
      .expect(200);
    const byId = new Map(
      (res.body as { id: number; samePlaza: boolean; plazaConflict: boolean }[]).map((e) => [
        e.id,
        e,
      ])
    );
    expect(byId.get(restaurantBId)).toMatchObject({ samePlaza: true, plazaConflict: true });
    // The partner already holding the category is same-plaza but not a conflict.
    expect(byId.get(restaurantAId)).toMatchObject({ samePlaza: true, plazaConflict: false });
    expect(byId.get(restaurantFarId)).toMatchObject({ samePlaza: false, plazaConflict: false });
    expect(byId.get(restaurantNextPostalId)).toMatchObject({
      samePlaza: false,
      plazaConflict: false,
    });
    expect(byId.get(restaurantNoAddressId)).toMatchObject({
      samePlaza: false,
      plazaConflict: false,
    });
  });

  it("notifies both affected businesses about the exclusivity rule", async () => {
    const mine = await agent
      .get("/api/coop/plaza-notifications")
      .set("x-tenant-id", String(barberId))
      .expect(200);
    const asRequester = mine.body.find(
      (n: { role: string; otherBusinessName: string }) =>
        n.role === "requester" && n.otherBusinessName === `Plaza Resto B ${RUN}`
    );
    expect(asRequester).toBeDefined();
    expect(asRequester.message).toContain("plaza exclusivity");

    const theirs = await agent
      .get("/api/coop/plaza-notifications")
      .set("x-tenant-id", String(restaurantBId))
      .expect(200);
    const asBlocked = theirs.body.find(
      (n: { role: string; otherBusinessName: string }) =>
        n.role === "blocked" && n.otherBusinessName === `Plaza Barber ${RUN}`
    );
    expect(asBlocked).toBeDefined();
    expect(asBlocked.message).toContain("plaza exclusivity");
  });

  it("shows the conflict to admins and releases it, unblocking a retried invite", async () => {
    const list = await agent.get("/api/coop/plaza-conflicts").expect(200);
    const conflict = list.body.find(
      (c: { requesterTenantId: number; blockedPartnerTenantId: number }) =>
        c.requesterTenantId === barberId && c.blockedPartnerTenantId === restaurantBId
    );
    expect(conflict).toMatchObject({
      status: "active",
      requesterTenantName: `Plaza Barber ${RUN}`,
      blockedPartnerTenantName: `Plaza Resto B ${RUN}`,
      existingPartnerTenantName: `Plaza Resto A ${RUN}`,
    });

    const released = await agent
      .post(`/api/coop/plaza-conflicts/${conflict.id}/release`)
      .expect(200);
    expect(released.body.status).toBe("released");
    expect(released.body.releasedAt).toBeTruthy();

    // Double-release is rejected.
    await agent.post(`/api/coop/plaza-conflicts/${conflict.id}/release`).expect(409);

    // The exact pairing can now be retried.
    await invite(barberId, restaurantBId, `Retried perk ${RUN}`).expect(201);

    // And the directory no longer flags it.
    const dir = await agent
      .get("/api/coop/directory")
      .set("x-tenant-id", String(barberId))
      .expect(200);
    const entry = dir.body.find((e: { id: number }) => e.id === restaurantBId);
    expect(entry).toMatchObject({ samePlaza: true, plazaConflict: false });
  });

  it("returns 404 releasing an unknown conflict", async () => {
    await agent.post("/api/coop/plaza-conflicts/999999999/release").expect(404);
  });

  it("requires the x-tenant-id scope for notifications", async () => {
    await agent.get("/api/coop/plaza-notifications").expect(400);
  });
});

describe("plaza conflict console is platform-admin-only", () => {
  let memberAgent: ReturnType<typeof request.agent>;
  let memberUserId: number;

  beforeAll(async () => {
    // A non-admin member of one of the plaza tenants.
    const app = (await import("../../app")).default;
    const loginToken = `tok-${RUN}-${randomBytes(12).toString("hex")}`;
    const [user] = await db
      .insert(usersTable)
      .values({ username: `member-${RUN}`, isPlatformAdmin: false, loginToken })
      .returning({ id: usersTable.id });
    memberUserId = user.id;
    await db.insert(userTenantMembershipsTable).values({ userId: memberUserId, tenantId: barberId });
    memberAgent = request.agent(app);
    await memberAgent.post("/api/auth/login").send({ loginToken }).expect(200);
  });

  afterAll(async () => {
    await db.delete(usersTable).where(eq(usersTable.id, memberUserId));
  });

  it("rejects a member session listing plaza conflicts", async () => {
    await memberAgent.get("/api/coop/plaza-conflicts").expect(403);
  });

  it("rejects a member session releasing a conflict, even one involving its own tenant", async () => {
    const [conflict] = await db
      .select({ id: coopPlazaConflictsTable.id })
      .from(coopPlazaConflictsTable)
      .where(eq(coopPlazaConflictsTable.requesterTenantId, barberId));
    // Fall back to a bogus id if the earlier suite's row is gone — the auth
    // gate must fire before any lookup either way.
    const id = conflict?.id ?? 999999998;
    await memberAgent.post(`/api/coop/plaza-conflicts/${id}/release`).expect(403);
  });

  it("still serves the admin session", async () => {
    await agent.get("/api/coop/plaza-conflicts").expect(200);
  });
});
