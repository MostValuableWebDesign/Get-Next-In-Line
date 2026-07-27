import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  platformInvitesTable,
  merchantCoopPartnershipsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Platform invites — inviting OFF-platform businesses to join and partner.
// Covers: invite creation + trackable link + incentive message, tracking
// status transitions (sent → clicked → registered), the public fast-track
// registration (tenant + storefront creation), the auto-created pending
// partnership, single-use + expiry enforcement, and friendly failures.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `platinv-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let anon: ReturnType<typeof request>;
let inviterId: number;
const createdTenantIds: number[] = [];

beforeAll(async () => {
  const app = (await import("../../app")).default;
  const { __resetPlatformInviteRateLimit } = await import("../platformInviteJoin");
  __resetPlatformInviteRateLimit();
  agent = request.agent(app);
  anon = request(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const [inviter] = await db
    .insert(tenantsTable)
    .values({ brandName: `Inviter Salon ${RUN}`, subdomain: `${RUN}-inviter`, status: "active" })
    .returning({ id: tenantsTable.id });
  inviterId = inviter.id;
  createdTenantIds.push(inviterId);
  await db.insert(sosSettingsTable).values({
    tenantId: inviterId,
    industryType: "salon",
    businessCategory: `HairSalon-${RUN}`,
  });
});

afterAll(async () => {
  if (createdTenantIds.length) {
    // Cascades clean up settings, invites, and partnerships.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, createdTenantIds));
  }
});

describe("platform invite creation", () => {
  it("requires the x-tenant-id scope", async () => {
    await agent
      .post("/api/coop/platform-invites")
      .send({ businessName: "Riverside Florist" })
      .expect(400);
  });

  it("creates an invite with a trackable link and the personalized incentive message", async () => {
    const res = await agent
      .post("/api/coop/platform-invites")
      .set("x-tenant-id", String(inviterId))
      .send({ businessName: `Riverside Florist ${RUN}`, contact: "florist@example.com" })
      .expect(201);
    expect(res.body.status).toBe("sent");
    expect(res.body.invitedBusinessName).toBe(`Riverside Florist ${RUN}`);
    expect(res.body.invitedContact).toBe("florist@example.com");
    expect(res.body.inviteUrl).toMatch(/\/api\/join\/[a-f0-9]{48}$/);
    expect(res.body.message).toContain(
      `Join the local merchant network to unlock automated customer cross-promotion with Inviter Salon ${RUN}.`
    );
    expect(res.body.message).toContain(res.body.inviteUrl);
    expect(res.body.resultingTenantId).toBeNull();
    // Token never leaks beyond the URL fields.
    expect(res.body.token).toBeUndefined();
  });

  it("lists the tenant's sent invites with status", async () => {
    const res = await agent
      .get("/api/coop/platform-invites")
      .set("x-tenant-id", String(inviterId))
      .expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].status).toBe("sent");
  });
});

async function createInvite(businessName: string): Promise<{ id: number; token: string }> {
  const res = await agent
    .post("/api/coop/platform-invites")
    .set("x-tenant-id", String(inviterId))
    .send({ businessName })
    .expect(201);
  const [row] = await db
    .select({ id: platformInvitesTable.id, token: platformInvitesTable.token })
    .from(platformInvitesTable)
    .where(eq(platformInvitesTable.id, res.body.id));
  return row;
}

describe("trackable link and token validation", () => {
  it("marks the invite clicked when the link is opened and redirects to the fast-track page", async () => {
    const invite = await createInvite(`Clicked Cafe ${RUN}`);
    const res = await anon.get(`/api/join/${invite.token}`).expect(302);
    expect(res.headers.location).toBe(`/join/${invite.token}`);

    const pub = await anon.get(`/api/public/coop/invites/${invite.token}`).expect(200);
    expect(pub.body.status).toBe("clicked");
    expect(pub.body.inviterBusinessName).toBe(`Inviter Salon ${RUN}`);
    expect(pub.body.invitedBusinessName).toBe(`Clicked Cafe ${RUN}`);
  });

  it("unknown or malformed tokens get a friendly 404", async () => {
    await anon.get(`/api/join/${"0".repeat(48)}`).expect(404);
    await anon.get("/api/join/not-a-token").expect(404);
    await anon.get(`/api/public/coop/invites/${"0".repeat(48)}`).expect(404);
  });

  it("expired invites report expired and block registration with 410", async () => {
    const invite = await createInvite(`Expired Gym ${RUN}`);
    await db
      .update(platformInvitesTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(platformInvitesTable.id, invite.id));

    const pub = await anon.get(`/api/public/coop/invites/${invite.token}`).expect(200);
    expect(pub.body.status).toBe("expired");

    await anon
      .post(`/api/public/coop/invites/${invite.token}/register`)
      .send({ businessName: `Expired Gym ${RUN}`, subdomain: `${RUN}-expired` })
      .expect(410);
  });
});

describe("public fast-track registration", () => {
  it("creates the tenant + storefront and the pending partnership from the inviter", async () => {
    const invite = await createInvite(`Corner Cafe ${RUN}`);
    const res = await anon
      .post(`/api/public/coop/invites/${invite.token}/register`)
      .send({
        businessName: `Corner Cafe ${RUN}`,
        contactName: "Casey Owner",
        contactEmail: "casey@example.com",
        category: `CafeOrCoffeeShop-${RUN}`,
        subdomain: `${RUN}-cafe`,
      })
      .expect(201);
    createdTenantIds.push(res.body.tenantId);
    expect(res.body.brandName).toBe(`Corner Cafe ${RUN}`);
    expect(res.body.subdomain).toBe(`${RUN}-cafe`);
    expect(res.body.partnershipCreated).toBe(true);
    expect(res.body.partnershipBlockedReason).toBeNull();

    // Tenant is active with contact details; storefront settings row exists.
    const [tenant] = await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, res.body.tenantId));
    expect(tenant.status).toBe("active");
    expect(tenant.contactEmail).toBe("casey@example.com");
    const [settings] = await db
      .select()
      .from(sosSettingsTable)
      .where(eq(sosSettingsTable.tenantId, res.body.tenantId));
    expect(settings.businessName).toBe(`Corner Cafe ${RUN}`);
    expect(settings.businessCategory).toBe(`CafeOrCoffeeShop-${RUN}`);

    // Invite is now registered and linked to the new tenant.
    const list = await agent
      .get("/api/coop/platform-invites")
      .set("x-tenant-id", String(inviterId))
      .expect(200);
    const mine = list.body.find((i: { id: number }) => i.id === invite.id);
    expect(mine.status).toBe("registered");
    expect(mine.resultingTenantId).toBe(res.body.tenantId);

    // Pending partnership requested by the inviter, visible to both hubs.
    const partnerships = await agent
      .get(`/api/coop/partnerships?tenantId=${res.body.tenantId}`)
      .expect(200);
    expect(partnerships.body.length).toBe(1);
    const p = partnerships.body[0];
    expect(p.status).toBe("pending");
    expect(p.isActive).toBe(false);
    expect(p.hostTenantId).toBe(inviterId);
    expect(p.partnerTenantId).toBe(res.body.tenantId);
    expect(p.requestedByTenantId).toBe(inviterId);

    // The new owner can accept it and the perk goes live (existing lifecycle).
    const accepted = await agent
      .post(`/api/coop/invites/${p.id}/respond`)
      .set("x-tenant-id", String(res.body.tenantId))
      .send({ action: "accept" })
      .expect(200);
    expect(accepted.body.status).toBe("accepted");
    expect(accepted.body.isActive).toBe(true);
  });

  it("tokens are single-use: a second registration gets a friendly 409", async () => {
    const invite = await createInvite(`Once Only ${RUN}`);
    const first = await anon
      .post(`/api/public/coop/invites/${invite.token}/register`)
      .send({ businessName: `Once Only ${RUN}`, subdomain: `${RUN}-once` })
      .expect(201);
    createdTenantIds.push(first.body.tenantId);
    await anon
      .post(`/api/public/coop/invites/${invite.token}/register`)
      .send({ businessName: `Once Only Again ${RUN}`, subdomain: `${RUN}-once-again` })
      .expect(409);
  });

  it("rejects taken subdomains and bad bodies without consuming the invite", async () => {
    const invite = await createInvite(`Validation Biz ${RUN}`);
    await anon
      .post(`/api/public/coop/invites/${invite.token}/register`)
      .send({ businessName: `Validation Biz ${RUN}`, subdomain: `${RUN}-inviter` })
      .expect(409);
    await anon
      .post(`/api/public/coop/invites/${invite.token}/register`)
      .send({ businessName: "", subdomain: "x" })
      .expect(400);
    await anon
      .post(`/api/public/coop/invites/${invite.token}/register`)
      .send({ businessName: "Ok", subdomain: `${RUN}-ok`, contactEmail: "not-an-email" })
      .expect(400);
    // Still usable afterwards.
    const pub = await anon.get(`/api/public/coop/invites/${invite.token}`).expect(200);
    expect(["sent", "clicked"]).toContain(pub.body.status);
  });

  it("same-industry guardrail: registration succeeds but no partnership is auto-created", async () => {
    const invite = await createInvite(`Rival Salon ${RUN}`);
    const res = await anon
      .post(`/api/public/coop/invites/${invite.token}/register`)
      .send({
        businessName: `Rival Salon ${RUN}`,
        category: `HairSalon-${RUN}`,
        subdomain: `${RUN}-rival`,
      })
      .expect(201);
    createdTenantIds.push(res.body.tenantId);
    expect(res.body.partnershipCreated).toBe(false);
    expect(res.body.partnershipBlockedReason).toBe(
      "Same-industry pairings are restricted by platform guidelines."
    );
    const rows = await db
      .select({ id: merchantCoopPartnershipsTable.id })
      .from(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.partnerTenantId, res.body.tenantId));
    expect(rows.length).toBe(0);
  });
});
