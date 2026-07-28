import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "crypto";
import {
  db,
  tenantsTable,
  usersTable,
  userTenantMembershipsTable,
  sosReviewsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Route-level role guards on tenant-scoped write routes.
//
// Tenant membership alone must not grant write access:
//  - Brand settings (PATCH /tenants/:id/settings) and review curation
//    (POST/PATCH/DELETE /tenants/:id/reviews*) are owner/admin surface —
//    merchants, district managers, and platform admins may write; staff are
//    read-only.
//  - The tenant record itself (PATCH/DELETE /tenants/:id) is platform-level,
//    same bar as provisioning — even a merchant member may not rewrite or
//    delete their own tenant row.
//
// Isolation: throwaway tenants + users per run; rows cascade on delete.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `twrole-${Date.now()}-${process.pid}`;

let adminAgent: ReturnType<typeof request.agent>;
let districtAgent: ReturnType<typeof request.agent>;
let merchantAgent: ReturnType<typeof request.agent>;
let staffAgent: ReturnType<typeof request.agent>;
let tenantA: number;
const userIds: number[] = [];

async function mkUser(role: string, tenantIds: number[]): Promise<string> {
  const loginToken = `tok-${RUN}-${randomBytes(12).toString("hex")}`;
  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${role}-${RUN}`,
      role,
      isPlatformAdmin: false,
      loginToken,
    })
    .returning({ id: usersTable.id });
  userIds.push(user.id);
  if (tenantIds.length > 0) {
    await db
      .insert(userTenantMembershipsTable)
      .values(tenantIds.map((tenantId) => ({ userId: user.id, tenantId })));
  }
  return loginToken;
}

beforeAll(async () => {
  const app = (await import("../../app")).default;

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `Role Guard ${RUN}`, subdomain: `${RUN}-a`, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantA = tenant.id;

  const [districtToken, merchantToken, staffToken] = await Promise.all([
    mkUser("district_manager", [tenantA]),
    mkUser("merchant", [tenantA]),
    mkUser("staff", [tenantA]),
  ]);

  adminAgent = request.agent(app);
  await adminAgent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const login = async (loginToken: string) => {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ loginToken }).expect(200);
    return agent;
  };
  districtAgent = await login(districtToken);
  merchantAgent = await login(merchantToken);
  staffAgent = await login(staffToken);
});

afterAll(async () => {
  await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantA));
});

describe("tenant brand settings (PATCH /tenants/:id/settings)", () => {
  it("staff can read but not write settings", async () => {
    await staffAgent.get(`/api/tenants/${tenantA}/settings`).expect(200);
    const res = await staffAgent
      .patch(`/api/tenants/${tenantA}/settings`)
      .send({ businessName: "staff-hijack" });
    expect(res.status).toBe(403);
  });

  it("merchant, district manager, and admin can write settings", async () => {
    await merchantAgent
      .patch(`/api/tenants/${tenantA}/settings`)
      .send({ businessName: `Merchant ${RUN}` })
      .expect(200);
    await districtAgent
      .patch(`/api/tenants/${tenantA}/settings`)
      .send({ businessName: `District ${RUN}` })
      .expect(200);
    await adminAgent
      .patch(`/api/tenants/${tenantA}/settings`)
      .send({ businessName: `Admin ${RUN}` })
      .expect(200);
  });
});

describe("tenant record management (PATCH/DELETE /tenants/:id)", () => {
  it("membership does not grant record writes — merchant/district/staff all get 403", async () => {
    for (const agent of [merchantAgent, districtAgent, staffAgent]) {
      const patch = await agent
        .patch(`/api/tenants/${tenantA}`)
        .send({ brandName: "renamed" });
      expect(patch.status).toBe(403);
      const del = await agent.delete(`/api/tenants/${tenantA}`);
      expect(del.status).toBe(403);
    }
    // The tenant row is untouched.
    const [row] = await db
      .select({ brandName: tenantsTable.brandName })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantA));
    expect(row.brandName).toBe(`Role Guard ${RUN}`);
  });

  it("platform admin can update the tenant record", async () => {
    const res = await adminAgent
      .patch(`/api/tenants/${tenantA}`)
      .send({ contactName: "Ops Admin" })
      .expect(200);
    expect(res.body.contactName).toBe("Ops Admin");
  });
});

describe("review curation (POST/PATCH/DELETE /tenants/:id/reviews)", () => {
  it("staff can list but not create, edit, or delete reviews", async () => {
    // Seed a review directly so PATCH/DELETE have a target.
    const [review] = await db
      .insert(sosReviewsTable)
      .values({ tenantId: tenantA, authorName: `Reader ${RUN}`, rating: 5, body: "ok" })
      .returning({ id: sosReviewsTable.id });

    await staffAgent.get(`/api/tenants/${tenantA}/reviews`).expect(200);
    const create = await staffAgent
      .post(`/api/tenants/${tenantA}/reviews`)
      .send({ authorName: "Staff", rating: 5 });
    expect(create.status).toBe(403);
    const edit = await staffAgent
      .patch(`/api/tenants/${tenantA}/reviews/${review.id}`)
      .send({ isVisible: false });
    expect(edit.status).toBe(403);
    const del = await staffAgent.delete(`/api/tenants/${tenantA}/reviews/${review.id}`);
    expect(del.status).toBe(403);
  });

  it("merchant can curate reviews for their own tenant", async () => {
    const created = await merchantAgent
      .post(`/api/tenants/${tenantA}/reviews`)
      .send({ authorName: `Customer ${RUN}`, rating: 4, body: "great" })
      .expect(201);
    await merchantAgent
      .patch(`/api/tenants/${tenantA}/reviews/${created.body.id}`)
      .send({ isVisible: false })
      .expect(200);
    await merchantAgent
      .delete(`/api/tenants/${tenantA}/reviews/${created.body.id}`)
      .expect(204);
  });
});
