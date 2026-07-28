import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  usersTable,
  coopApplicationsTable,
  sosSettingsTable,
} from "@workspace/db";
import { eq, inArray, like } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Network Governance integration tests: hierarchical roles (super_admin,
// district_manager, merchant, staff) gating governance/tenant/co-op surfaces,
// plus the co-op join-application lifecycle including approval-triggered
// tenant provisioning.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `gov-${Date.now()}-${process.pid}`;

let adminAgent: ReturnType<typeof request.agent>;
let districtAgent: ReturnType<typeof request.agent>;
let merchantAgent: ReturnType<typeof request.agent>;
let staffAgent: ReturnType<typeof request.agent>;
let tenantA: number;
let tenantB: number;
let tenantC: number; // outside the district
const createdUserIds: number[] = [];

async function loginWithToken(app: unknown, token: string) {
  const agent = request.agent(app as Parameters<typeof request.agent>[0]);
  await agent.post("/api/auth/login").send({ loginToken: token }).expect(200);
  return agent;
}

beforeAll(async () => {
  const { __resetCoopApplicationRateLimit } = await import("../coopApplications");
  __resetCoopApplicationRateLimit();
  const app = (await import("../../app")).default;

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Gov A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `Gov B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
      { brandName: `Gov C ${RUN}`, subdomain: `${RUN}-c`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [tenantA, tenantB, tenantC] = tenants.map((t) => t.id);

  adminAgent = request.agent(app);
  await adminAgent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  // Create the three lower tiers via the governance API itself.
  const mkUser = async (role: string, tenantIds: number[]) => {
    const res = await adminAgent
      .post("/api/governance/users")
      .send({ username: `${role}-${RUN}`, role, tenantIds })
      .expect(201);
    createdUserIds.push(res.body.id);
    return res.body.loginToken as string;
  };
  const districtToken = await mkUser("district_manager", [tenantA, tenantB]);
  const merchantToken = await mkUser("merchant", [tenantA]);
  const staffToken = await mkUser("staff", [tenantA]);

  districtAgent = await loginWithToken(app, districtToken);
  merchantAgent = await loginWithToken(app, merchantToken);
  staffAgent = await loginWithToken(app, staffToken);
});

afterAll(async () => {
  await db.delete(coopApplicationsTable).where(like(coopApplicationsTable.subdomain, `${RUN}%`));
  if (createdUserIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  }
  const runTenants = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(like(tenantsTable.subdomain, `${RUN}%`));
  const ids = runTenants.map((t) => t.id);
  if (ids.length) {
    await db.delete(sosSettingsTable).where(inArray(sosSettingsTable.tenantId, ids));
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

describe("session role", () => {
  it("auth/me reports each session's governance role", async () => {
    expect((await adminAgent.get("/api/auth/me")).body.role).toBe("super_admin");
    expect((await districtAgent.get("/api/auth/me")).body.role).toBe("district_manager");
    expect((await merchantAgent.get("/api/auth/me")).body.role).toBe("merchant");
    expect((await staffAgent.get("/api/auth/me")).body.role).toBe("staff");
  });
});

describe("governance user management (super-admin only)", () => {
  it("non-super-admins cannot touch governance user management", async () => {
    for (const agent of [districtAgent, merchantAgent, staffAgent]) {
      expect((await agent.get("/api/governance/users")).status).toBe(403);
      expect(
        (await agent.post("/api/governance/users").send({ username: "x", role: "staff" })).status,
      ).toBe(403);
    }
  });

  it("super-admin lists users with roles and scopes", async () => {
    const res = await adminAgent.get("/api/governance/users").expect(200);
    const district = res.body.find((u: { username: string }) => u.username === `district_manager-${RUN}`);
    expect(district.role).toBe("district_manager");
    expect(district.tenants.map((t: { id: number }) => t.id).sort()).toEqual([tenantA, tenantB].sort());
  });

  it("enforces scope cardinality per role", async () => {
    const bad1 = await adminAgent
      .post("/api/governance/users")
      .send({ username: `bad1-${RUN}`, role: "merchant", tenantIds: [tenantA, tenantB] });
    expect(bad1.status).toBe(400);
    const bad2 = await adminAgent
      .post("/api/governance/users")
      .send({ username: `bad2-${RUN}`, role: "district_manager", tenantIds: [] });
    expect(bad2.status).toBe(400);
  });

  it("rejects duplicate usernames with 409", async () => {
    const res = await adminAgent
      .post("/api/governance/users")
      .send({ username: `staff-${RUN}`, role: "staff", tenantIds: [tenantA] });
    expect(res.status).toBe(409);
  });

  it("super-admin can edit role/scope and rotate a login token", async () => {
    const create = await adminAgent
      .post("/api/governance/users")
      .send({ username: `edit-${RUN}`, role: "staff", tenantIds: [tenantA] })
      .expect(201);
    createdUserIds.push(create.body.id);
    const oldToken = create.body.loginToken as string;

    const updated = await adminAgent
      .patch(`/api/governance/users/${create.body.id}`)
      .send({ role: "district_manager", tenantIds: [tenantA, tenantB] })
      .expect(200);
    expect(updated.body.role).toBe("district_manager");
    expect(updated.body.tenants).toHaveLength(2);

    const rotated = await adminAgent
      .post(`/api/governance/users/${create.body.id}/rotate-token`)
      .expect(200);
    expect(rotated.body.loginToken).not.toBe(oldToken);

    const app = (await import("../../app")).default;
    const anon = request.agent(app);
    await anon.post("/api/auth/login").send({ loginToken: oldToken }).expect(401);
    await anon.post("/api/auth/login").send({ loginToken: rotated.body.loginToken }).expect(200);
  });

  it("super-admin can delete a user; their login stops working", async () => {
    const create = await adminAgent
      .post("/api/governance/users")
      .send({ username: `del-${RUN}`, role: "staff", tenantIds: [tenantA] })
      .expect(201);
    await adminAgent.delete(`/api/governance/users/${create.body.id}`).expect(204);
    const app = (await import("../../app")).default;
    await request
      .agent(app)
      .post("/api/auth/login")
      .send({ loginToken: create.body.loginToken })
      .expect(401);
  });
});

describe("role-gated tenant & co-op access", () => {
  it("district manager sees only their assigned tenants in the list", async () => {
    const res = await districtAgent.get("/api/tenants").expect(200);
    const ids = res.body.map((t: { id: number }) => t.id);
    expect(ids).toContain(tenantA);
    expect(ids).toContain(tenantB);
    expect(ids).not.toContain(tenantC);
  });

  it("merchant sees only their own business", async () => {
    const res = await merchantAgent.get("/api/tenants").expect(200);
    const ids = res.body.map((t: { id: number }) => t.id);
    expect(ids).toEqual([tenantA]);
  });

  it("merchant/district cannot provision or act on foreign tenants", async () => {
    expect(
      (await merchantAgent.post("/api/tenants").send({ brandName: "x", subdomain: `${RUN}-x` }))
        .status,
    ).toBe(403);
    expect((await merchantAgent.get(`/api/tenants/${tenantB}/settings`)).status).toBe(403);
    expect((await districtAgent.get(`/api/tenants/${tenantC}/settings`)).status).toBe(403);
    await districtAgent.get(`/api/tenants/${tenantB}/settings`).expect(200);
  });

  it("staff have read-only access on tenant and co-op surfaces", async () => {
    await staffAgent.get("/api/tenants").expect(200);
    await staffAgent.get(`/api/tenants/${tenantA}/settings`).expect(200);
    const patch = await staffAgent
      .patch(`/api/tenants/${tenantA}/settings`)
      .send({ businessName: "nope" });
    expect(patch.status).toBe(403);
    const coopWrite = await staffAgent
      .post("/api/coop/partnerships")
      .send({ hostTenantId: tenantA, partnerTenantId: tenantB });
    expect(coopWrite.status).toBe(403);
    // Merchant CAN write within their own tenant.
    await merchantAgent
      .patch(`/api/tenants/${tenantA}/settings`)
      .send({ businessName: `Gov A ${RUN}` })
      .expect(200);
  });
});

describe("co-op join application lifecycle", () => {
  it("public submit → review → approve provisions the tenant; status page tracks it", async () => {
    const app = (await import("../../app")).default;
    const pub = request.agent(app);

    const submitted = await pub
      .post("/api/public/coop/applications")
      .send({
        businessName: `Applicant ${RUN}`,
        subdomain: `${RUN}-app`,
        contactName: "Alice Applicant",
        contactEmail: "alice@example.com",
        category: "florist",
        pitch: "We arrange flowers.",
      })
      .expect(201);
    const { statusToken, id } = submitted.body;
    expect(submitted.body.status).toBe("submitted");

    // Applicant status page (unauthenticated).
    const status1 = await pub.get(`/api/public/coop/applications/${statusToken}`).expect(200);
    expect(status1.body.status).toBe("submitted");

    // Queue is not public and not staff/merchant-visible.
    expect((await pub.get("/api/governance/applications")).status).toBe(401);
    expect((await merchantAgent.get("/api/governance/applications")).status).toBe(403);
    expect((await staffAgent.get("/api/governance/applications")).status).toBe(403);

    // District manager works the queue: under review with vetting notes.
    const queue = await districtAgent.get("/api/governance/applications").expect(200);
    expect(queue.body.some((a: { id: number }) => a.id === id)).toBe(true);
    const reviewed = await districtAgent
      .patch(`/api/governance/applications/${id}`)
      .send({ status: "under_review", reviewNotes: "Storefront verified." })
      .expect(200);
    expect(reviewed.body.status).toBe("under_review");
    expect(reviewed.body.reviewNotes).toBe("Storefront verified.");

    // Approve → tenant provisioned via the standard creation path.
    const approved = await districtAgent
      .patch(`/api/governance/applications/${id}`)
      .send({ status: "approved" })
      .expect(200);
    expect(approved.body.status).toBe("approved");
    const newTenantId = approved.body.resultingTenantId as number;
    expect(newTenantId).toBeTypeOf("number");

    const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, newTenantId));
    expect(tenant.subdomain).toBe(`${RUN}-app`);
    expect(tenant.brandName).toBe(`Applicant ${RUN}`);
    const [settings] = await db
      .select()
      .from(sosSettingsTable)
      .where(eq(sosSettingsTable.tenantId, newTenantId));
    expect(settings).toBeTruthy();

    // Decided applications are terminal.
    const reopen = await adminAgent
      .patch(`/api/governance/applications/${id}`)
      .send({ status: "rejected", rejectionReason: "changed my mind" });
    expect(reopen.status).toBe(409);

    const status2 = await pub.get(`/api/public/coop/applications/${statusToken}`).expect(200);
    expect(status2.body.status).toBe("approved");
  });

  it("rejection requires a reason and surfaces it to the applicant only when rejected", async () => {
    const app = (await import("../../app")).default;
    const pub = request.agent(app);
    const submitted = await pub
      .post("/api/public/coop/applications")
      .send({ businessName: `Reject ${RUN}`, subdomain: `${RUN}-rej` })
      .expect(201);
    const { statusToken, id } = submitted.body;

    const noReason = await adminAgent
      .patch(`/api/governance/applications/${id}`)
      .send({ status: "rejected" });
    expect(noReason.status).toBe(400);

    await adminAgent
      .patch(`/api/governance/applications/${id}`)
      .send({ status: "rejected", rejectionReason: "Insufficient business history." })
      .expect(200);

    const status = await pub.get(`/api/public/coop/applications/${statusToken}`).expect(200);
    expect(status.body.status).toBe("rejected");
    expect(status.body.rejectionReason).toBe("Insufficient business history.");
    // Internal vetting notes never leak to the applicant.
    expect(status.body.reviewNotes).toBeUndefined();
  });

  it("duplicate subdomains are refused at submit and at approval", async () => {
    const app = (await import("../../app")).default;
    const pub = request.agent(app);
    // Submit-time check against existing tenants.
    const dupe = await pub
      .post("/api/public/coop/applications")
      .send({ businessName: "Dupe", subdomain: `${RUN}-a` });
    expect(dupe.status).toBe(409);

    // Approval-time check: two applications for the same new subdomain.
    const first = await pub
      .post("/api/public/coop/applications")
      .send({ businessName: `First ${RUN}`, subdomain: `${RUN}-race` })
      .expect(201);
    const second = await pub
      .post("/api/public/coop/applications")
      .send({ businessName: `Second ${RUN}`, subdomain: `${RUN}-race` })
      .expect(201);
    await adminAgent
      .patch(`/api/governance/applications/${first.body.id}`)
      .send({ status: "approved" })
      .expect(200);
    const clash = await adminAgent
      .patch(`/api/governance/applications/${second.body.id}`)
      .send({ status: "approved" });
    expect(clash.status).toBe(409);
  });

  it("bogus status tokens 404", async () => {
    const app = (await import("../../app")).default;
    await request.agent(app).get("/api/public/coop/applications/deadbeef").expect(404);
    await request
      .agent(app)
      .get(`/api/public/coop/applications/${"0".repeat(32)}`)
      .expect(404);
  });
});
