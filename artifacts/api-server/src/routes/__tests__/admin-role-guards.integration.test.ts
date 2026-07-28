import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { randomBytes } from "crypto";
import { db, tenantsTable, usersTable, userTenantMembershipsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Route-level platform-role guards on the admin / agency / governance surface.
//
// Authorization used to depend solely on path-string matching inside
// authorizeTenantAccess (isPlatformAdminOnly). Each privileged router now
// carries its own requireRole guard, so renaming or adding an admin route
// cannot silently lose protection. These tests prove:
//   1. Non-admin sessions get 403 on representative admin routes (full app).
//   2. The guard lives on the router itself: with the path-matching
//      middleware absent entirely, the routers still reject non-admins —
//      including routes that previously depended only on path matching.
//   3. Platform admins are unaffected.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `roleguard-${Date.now()}-${process.pid}`;

let adminAgent: ReturnType<typeof request.agent>;
let merchantAgent: ReturnType<typeof request.agent>;
let tenantId: number;
let userId: number;

beforeAll(async () => {
  const app = (await import("../../app")).default;

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `RoleGuard ${RUN}`, subdomain: `${RUN}-t`, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;

  const loginToken = `tok-${RUN}-${randomBytes(12).toString("hex")}`;
  const [user] = await db
    .insert(usersTable)
    .values({ username: `merchant-${RUN}`, isPlatformAdmin: false, role: "merchant", loginToken })
    .returning({ id: usersTable.id });
  userId = user.id;
  await db.insert(userTenantMembershipsTable).values({ userId, tenantId });

  adminAgent = request.agent(app);
  await adminAgent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  merchantAgent = request.agent(app);
  await merchantAgent.post("/api/auth/login").send({ loginToken }).expect(200);
});

afterAll(async () => {
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

// Representative privileged routes across all guarded routers.
const ADMIN_ONLY_GETS = [
  "/api/admin/connector-registry", // admin router
  "/api/admin/campaigns", // admin router
  "/api/admin/coop/disputes", // admin router
  "/api/admin/procurement/vendors", // procurement router (own guard)
  "/api/admin/coop/wallets", // sponsorship router (own guard)
  "/api/agency/dashboard", // agency router
  "/api/agency/master-overview", // settlement router
  "/api/billing/summary", // per-route guard
  "/api/modules/tenant-counts", // per-route guard
  "/api/governance/users", // governance router (requireRole)
];

describe("non-admin sessions are rejected on the admin surface (full app)", () => {
  it("403s a merchant on every representative admin route", async () => {
    for (const path of ADMIN_ONLY_GETS) {
      const res = await merchantAgent.get(path);
      expect(res.status, path).toBe(403);
    }
  });

  it("403s a merchant on privileged mutations", async () => {
    await merchantAgent
      .post("/api/tenants")
      .send({ brandName: `Nope ${RUN}`, subdomain: `${RUN}-nope` })
      .expect(403);
    await merchantAgent
      .patch("/api/coop/partnerships/999999")
      .set("x-tenant-id", String(tenantId))
      .send({ isActive: false })
      .expect(403);
  });

  it("platform admin still passes the guards", async () => {
    await adminAgent.get("/api/admin/connector-registry").expect(200);
    await adminAgent.get("/api/billing/summary").expect(200);
    await adminAgent.get("/api/modules/tenant-counts").expect(200);
    await adminAgent.get("/api/governance/users").expect(200);
  });
});

// The core regression: mount the privileged routers WITHOUT the path-matching
// tenant-access middleware. If protection lived only in the path list, these
// requests would succeed; the route-level guards must reject them on their own.
describe("guards travel with the routers (no path-matching backstop mounted)", () => {
  async function bareAppWith(routerModule: string) {
    const { default: r } = await import(routerModule);
    const app = express();
    app.use(express.json());
    // Authenticated non-admin session stub — no authorizeTenantAccess mounted.
    app.use((req, _res, next) => {
      (req as unknown as { session: object }).session = {
        authenticated: true,
        userId: 424242,
        role: "merchant",
        isPlatformAdmin: false,
      };
      next();
    });
    app.use("/api", r);
    return app;
  }

  it("admin router rejects non-admins by itself", async () => {
    const app = await bareAppWith("../admin");
    await request(app).get("/api/admin/connector-registry").expect(403);
    await request(app).get("/api/admin/compliance/summary").expect(403);
  });

  it("routes that previously relied only on path matching now self-reject", async () => {
    // /admin/procurement/* and /admin/coop/* had no in-router protection at
    // all before — they were covered purely by the "/admin" path prefix match.
    const procurement = await bareAppWith("../procurement");
    await request(procurement).get("/api/admin/procurement/vendors").expect(403);
    const sponsorship = await bareAppWith("../coopSponsorship");
    await request(sponsorship).get("/api/admin/coop/wallets").expect(403);
    // Same for the agency console and settlement clearinghouse.
    const agency = await bareAppWith("../agency");
    await request(agency).get("/api/agency/dashboard").expect(403);
    const settlement = await bareAppWith("../settlement");
    await request(settlement).get("/api/agency/master-overview").expect(403);
  });

  it("a newly added /admin route on the admin router is protected automatically", async () => {
    const { default: adminRouter } = await import("../admin");
    // Simulate a future route added without touching any path list.
    (adminRouter as unknown as express.Router).get("/admin/__role-guard-probe", (_req, res) => {
      res.json({ leaked: true });
    });
    const app = await bareAppWith("../admin");
    await request(app).get("/api/admin/__role-guard-probe").expect(403);
    // And through the full app for a non-admin session too.
    await merchantAgent.get("/api/admin/__role-guard-probe").expect(403);
    // A platform admin can reach it (guard authorizes, doesn't hide).
    await adminAgent.get("/api/admin/__role-guard-probe").expect(200);
  });
});
