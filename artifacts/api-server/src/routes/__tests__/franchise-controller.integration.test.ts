import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  usersTable,
  franchiseOrgsTable,
  franchiseTemplateDeploymentsTable,
  merchantCoopPartnershipsTable,
  coopEventsTable,
  platformLedgerEntriesTable,
  modulesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Multi-Location Franchise Co-Op Controller against the real dev DB. Covers:
// module catalog registration, hierarchy management, role scoping (super
// admin / regional manager / storefront operator), global template
// propagation (deploy → surfaces on /coop/perks → update → retire) and its
// idempotency, the local-autonomy policy + zip-code enforcement + approval
// queue, roll-up aggregation math, and that tenants outside any org keep
// existing single-tenant co-op behavior untouched.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `frctl-${Date.now()}-${process.pid}`;

let app: any;
let admin: ReturnType<typeof request.agent>;
let manager: ReturnType<typeof request.agent>; // regional manager (east)
let operator: ReturnType<typeof request.agent>; // storefront operator (east1)
let outsider: ReturnType<typeof request.agent>; // user with no org role

let orgId: number;
let eastRegionId: number;
let east1Id: number; // storefront, zip 10001
let east2Id: number; // storefront, zip 10002 (east region)
let westId: number; // storefront, zip 90210 (unassigned region)
let neighborId: number; // NOT in org, zip 10001 (valid local partner)
let farAwayId: number; // NOT in org, zip 60601
let soloId: number; // untouched single-tenant control
let managerUserId: number;
let operatorUserId: number;
let tenantIds: number[] = [];
let userIds: number[] = [];

const login = async (token: string) => {
  const a = request.agent(app);
  await a.post("/api/auth/login").send({ loginToken: token }).expect(200);
  return a;
};

beforeAll(async () => {
  app = (await import("../../app")).default;
  admin = request.agent(app);
  await admin
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `East One ${RUN}`, subdomain: `${RUN}-east1`, status: "active" },
      { brandName: `East Two ${RUN}`, subdomain: `${RUN}-east2`, status: "active" },
      { brandName: `West One ${RUN}`, subdomain: `${RUN}-west1`, status: "active" },
      { brandName: `Neighbor ${RUN}`, subdomain: `${RUN}-neighbor`, status: "active" },
      { brandName: `Far Away ${RUN}`, subdomain: `${RUN}-far`, status: "active" },
      { brandName: `Solo ${RUN}`, subdomain: `${RUN}-solo`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [east1Id, east2Id, westId, neighborId, farAwayId, soloId] = tenants.map((t) => t.id);
  tenantIds = tenants.map((t) => t.id);

  await db.insert(sosSettingsTable).values([
    { tenantId: east1Id, businessCategory: `Barber-${RUN}`, postalCode: "10001" },
    { tenantId: east2Id, businessCategory: `Barber-${RUN}`, postalCode: "10002" },
    { tenantId: westId, businessCategory: `Barber-${RUN}`, postalCode: "90210" },
    { tenantId: neighborId, businessCategory: `Cafe-${RUN}`, postalCode: "10001" },
    { tenantId: farAwayId, businessCategory: `Cafe-${RUN}`, postalCode: "60601" },
  ]);

  const users = await db
    .insert(usersTable)
    .values([
      { username: `${RUN}-manager`, loginToken: `${RUN}-manager-token` },
      { username: `${RUN}-operator`, loginToken: `${RUN}-operator-token` },
      { username: `${RUN}-outsider`, loginToken: `${RUN}-outsider-token` },
    ])
    .returning({ id: usersTable.id });
  [managerUserId, operatorUserId] = users.map((u) => u.id);
  userIds = users.map((u) => u.id);

  manager = await login(`${RUN}-manager-token`);
  operator = await login(`${RUN}-operator-token`);
  outsider = await login(`${RUN}-outsider-token`);
});

afterAll(async () => {
  if (orgId) await db.delete(franchiseOrgsTable).where(eq(franchiseOrgsTable.id, orgId));
  if (tenantIds.length)
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
  if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
});

describe("module catalog registration", () => {
  it("registers the controller module in the marketplace seed", async () => {
    const [mod] = await db
      .select()
      .from(modulesTable)
      .where(eq(modulesTable.slug, "franchise_coop_controller"));
    expect(mod).toBeDefined();
    expect(mod.categorySlug).toBe("operations");
    expect(mod.upstreamVendor).toBeNull();
    expect(mod.markupPercentOverride).toBeNull(); // standard agency markup
  });
});

describe("hierarchy management & role scoping", () => {
  it("creates an org, regions, and attaches storefronts", async () => {
    const orgRes = await admin
      .post("/api/franchise/orgs")
      .send({ name: `Empire ${RUN}` })
      .expect(201);
    orgId = orgRes.body.id;
    expect(orgRes.body.autonomyPolicy).toBe("allowed");

    const regionRes = await admin
      .post(`/api/franchise/orgs/${orgId}/regions`)
      .send({ name: "East" })
      .expect(201);
    eastRegionId = regionRes.body.id;

    for (const [tenantId, regionId] of [
      [east1Id, eastRegionId],
      [east2Id, eastRegionId],
      [westId, undefined],
    ] as const) {
      await admin
        .post(`/api/franchise/orgs/${orgId}/storefronts`)
        .send({ storefrontTenantId: tenantId, ...(regionId ? { regionId } : {}) })
        .expect(201);
    }
    const detail = await admin.get(`/api/franchise/orgs/${orgId}`).expect(200);
    expect(detail.body.storefronts).toHaveLength(3);
    expect(detail.body.myRole).toBe("super_admin");
  });

  it("rejects attaching a tenant that is already in an organization", async () => {
    const other = await admin
      .post("/api/franchise/orgs")
      .send({ name: `Rival ${RUN}` })
      .expect(201);
    await admin
      .post(`/api/franchise/orgs/${other.body.id}/storefronts`)
      .send({ storefrontTenantId: east1Id })
      .expect(409);
    await db.delete(franchiseOrgsTable).where(eq(franchiseOrgsTable.id, other.body.id));
  });

  it("assigns hierarchy roles and scopes reads to region / storefront", async () => {
    await admin
      .post(`/api/franchise/orgs/${orgId}/roles`)
      .send({ userId: managerUserId, role: "regional_manager", regionId: eastRegionId })
      .expect(201);
    await admin
      .post(`/api/franchise/orgs/${orgId}/roles`)
      .send({ userId: operatorUserId, role: "storefront_operator", tenantId: east1Id })
      .expect(201);

    const mgrView = await manager.get(`/api/franchise/orgs/${orgId}`).expect(200);
    expect(mgrView.body.myRole).toBe("regional_manager");
    expect(mgrView.body.storefronts.map((s: any) => s.tenantId).sort()).toEqual(
      [east1Id, east2Id].sort(),
    );

    const opView = await operator.get(`/api/franchise/orgs/${orgId}`).expect(200);
    expect(opView.body.myRole).toBe("storefront_operator");
    expect(opView.body.storefronts.map((s: any) => s.tenantId)).toEqual([east1Id]);

    // No role at all → 403; and org invisible in the list.
    await outsider.get(`/api/franchise/orgs/${orgId}`).expect(403);
    const list = await outsider.get("/api/franchise/orgs").expect(200);
    expect(list.body.find((o: any) => o.id === orgId)).toBeUndefined();
  });

  it("a non-admin cannot bootstrap an org to seize tenants they don't belong to", async () => {
    // Any user may create an org (they become its super admin)…
    const res = await outsider
      .post("/api/franchise/orgs")
      .send({ name: `Hijack ${RUN}` })
      .expect(201);
    const hijackOrgId = res.body.id;
    // …but attaching a tenant requires membership of THAT tenant, so an
    // outsider can never pull someone else's business under their org.
    await outsider
      .post(`/api/franchise/orgs/${hijackOrgId}/storefronts`)
      .send({ storefrontTenantId: soloId })
      .expect(403);
    const detail = await outsider.get(`/api/franchise/orgs/${hijackOrgId}`).expect(200);
    expect(detail.body.storefronts).toHaveLength(0);
    await db.delete(franchiseOrgsTable).where(eq(franchiseOrgsTable.id, hijackOrgId));
  });

  it("a tenant member CAN attach their own business to their org", async () => {
    const { userTenantMembershipsTable } = await import("@workspace/db");
    const [u] = await db
      .insert(usersTable)
      .values({ username: `${RUN}-owner`, loginToken: `${RUN}-owner-token` })
      .returning({ id: usersTable.id });
    userIds.push(u.id);
    await db
      .insert(userTenantMembershipsTable)
      .values({ userId: u.id, tenantId: soloId });
    const owner = await login(`${RUN}-owner-token`);
    const orgRes = await owner
      .post("/api/franchise/orgs")
      .send({ name: `Owner Org ${RUN}` })
      .expect(201);
    await owner
      .post(`/api/franchise/orgs/${orgRes.body.id}/storefronts`)
      .send({ storefrontTenantId: soloId })
      .expect(201);
    // Detach again so the "single-tenant untouched" checks below stay valid.
    await owner
      .delete(`/api/franchise/orgs/${orgRes.body.id}/storefronts/${soloId}`)
      .expect(204);
    await db.delete(franchiseOrgsTable).where(eq(franchiseOrgsTable.id, orgRes.body.id));
  });

  it("restricts write surfaces to the super admin", async () => {
    await manager
      .patch(`/api/franchise/orgs/${orgId}`)
      .send({ autonomyPolicy: "locked" })
      .expect(403);
    await operator
      .post(`/api/franchise/orgs/${orgId}/templates`)
      .send({ title: "nope" })
      .expect(403);
    await manager.get(`/api/franchise/orgs/${orgId}/roles`).expect(403);
  });
});

describe("template propagation engine", () => {
  let templateId: number;

  const perkTitles = async (tenantId: number) => {
    const res = await admin
      .get("/api/coop/perks")
      .set("x-tenant-id", String(tenantId))
      .expect(200);
    return res.body.perks.map((p: any) => p.perkTitle);
  };

  it("deploys a live perk to every storefront", async () => {
    const res = await admin
      .post(`/api/franchise/orgs/${orgId}/templates`)
      .send({ title: `Franchise VIP ${RUN}`, redemptionTerms: "One per visit" })
      .expect(201);
    templateId = res.body.id;
    expect(res.body.deployments).toHaveLength(3);
    expect(res.body.deployments.every((d: any) => d.status === "deployed")).toBe(true);

    for (const tid of [east1Id, east2Id, westId]) {
      expect(await perkTitles(tid)).toContain(`Franchise VIP ${RUN}`);
    }
    // A tenant outside the org never sees the franchise perk.
    expect(await perkTitles(soloId)).not.toContain(`Franchise VIP ${RUN}`);
  });

  it("is idempotent: re-propagating never duplicates perk rows", async () => {
    // Update triggers a full re-propagation over already-deployed rows.
    await admin
      .patch(`/api/franchise/orgs/${orgId}/templates/${templateId}`)
      .send({ title: `Franchise VIP v2 ${RUN}` })
      .expect(200);
    const deployments = await db
      .select()
      .from(franchiseTemplateDeploymentsTable)
      .where(eq(franchiseTemplateDeploymentsTable.templateId, templateId));
    expect(deployments).toHaveLength(3);
    const titles = await perkTitles(east1Id);
    expect(titles).toContain(`Franchise VIP v2 ${RUN}`);
    expect(titles).not.toContain(`Franchise VIP ${RUN}`);
    expect(titles.filter((t: string) => t.startsWith("Franchise VIP"))).toHaveLength(1);
  });

  it("retirement propagates down and reactivation restores the perk", async () => {
    await admin
      .patch(`/api/franchise/orgs/${orgId}/templates/${templateId}`)
      .send({ status: "retired" })
      .expect(200);
    expect(await perkTitles(east1Id)).not.toContain(`Franchise VIP v2 ${RUN}`);
    const deployments = await db
      .select()
      .from(franchiseTemplateDeploymentsTable)
      .where(eq(franchiseTemplateDeploymentsTable.templateId, templateId));
    expect(deployments.every((d) => d.status === "retired")).toBe(true);

    await admin
      .patch(`/api/franchise/orgs/${orgId}/templates/${templateId}`)
      .send({ status: "active" })
      .expect(200);
    expect(await perkTitles(east1Id)).toContain(`Franchise VIP v2 ${RUN}`);
  });

  it("operators see deployment status only for their own location", async () => {
    const res = await operator.get(`/api/franchise/orgs/${orgId}/templates`).expect(200);
    const t = res.body.find((x: any) => x.id === templateId);
    expect(t.deployments.map((d: any) => d.tenantId)).toEqual([east1Id]);
  });
});

describe("local autonomy policy, zip enforcement & approval queue", () => {
  it("franchise requests cannot bypass the same-industry guardrail", async () => {
    // A rival barbershop in east1's own zip: zip check passes, but the
    // firewall must reject the pairing exactly like /coop/invites would.
    const [rival] = await db
      .insert(tenantsTable)
      .values({ brandName: `Rival Barber ${RUN}`, subdomain: `${RUN}-rival`, status: "active" })
      .returning({ id: tenantsTable.id });
    tenantIds.push(rival.id);
    await db
      .insert(sosSettingsTable)
      .values({ tenantId: rival.id, businessCategory: `Barber-${RUN}`, postalCode: "10001" });
    const res = await operator
      .post(`/api/franchise/orgs/${orgId}/requests`)
      .send({
        storefrontTenantId: east1Id,
        targetTenantId: rival.id,
        perkTitle: `Rival pact ${RUN}`,
      })
      .expect(403);
    expect(res.body.code).toBe("SAME_INDUSTRY_RESTRICTED");
  });

  it("under 'allowed', an operator creates an invite in their own zip only", async () => {
    // Wrong zip → rejected.
    await operator
      .post(`/api/franchise/orgs/${orgId}/requests`)
      .send({
        storefrontTenantId: east1Id,
        targetTenantId: farAwayId,
        perkTitle: `No ${RUN}`,
      })
      .expect(400);
    // Own zip → approved immediately, pending invite created.
    const res = await operator
      .post(`/api/franchise/orgs/${orgId}/requests`)
      .send({
        storefrontTenantId: east1Id,
        targetTenantId: neighborId,
        perkTitle: `Coffee pact ${RUN}`,
      })
      .expect(201);
    expect(res.body.status).toBe("approved");
    expect(res.body.partnershipId).not.toBeNull();
    const [p] = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, res.body.partnershipId));
    expect(p.status).toBe("pending"); // existing invite lifecycle unchanged
    expect(p.isActive).toBe(false); // pending invites go live only on acceptance
    expect(p.hostTrackingCode).toMatch(/^CPT-/); // attribution codes at insert time
    expect(p.partnerTrackingCode).toMatch(/^CPT-/);
    expect(p.hostTenantId).toBe(east1Id);
    expect(p.partnerTenantId).toBe(neighborId);
  });

  it("operators cannot act for storefronts outside their scope", async () => {
    await operator
      .post(`/api/franchise/orgs/${orgId}/requests`)
      .send({
        storefrontTenantId: east2Id,
        targetTenantId: neighborId,
        perkTitle: `Nope ${RUN}`,
      })
      .expect(403);
  });

  it("under 'approval_required', requests queue and a regional manager decides", async () => {
    await admin
      .patch(`/api/franchise/orgs/${orgId}`)
      .send({ autonomyPolicy: "approval_required" })
      .expect(200);
    const res = await operator
      .post(`/api/franchise/orgs/${orgId}/requests`)
      .send({
        storefrontTenantId: east1Id,
        targetTenantId: neighborId,
        perkTitle: `Queued pact ${RUN}`,
      })
      .expect(201);
    expect(res.body.status).toBe("pending");
    expect(res.body.partnershipId).toBeNull();

    // Operators cannot decide.
    await operator
      .post(`/api/franchise/orgs/${orgId}/requests/${res.body.id}/decide`)
      .send({ action: "approve" })
      .expect(403);
    // Regional manager of the east region approves; invite materializes.
    const decided = await manager
      .post(`/api/franchise/orgs/${orgId}/requests/${res.body.id}/decide`)
      .send({ action: "approve" })
      .expect(200);
    expect(decided.body.status).toBe("approved");
    expect(decided.body.partnershipId).not.toBeNull();
    // Double-decision is rejected.
    await manager
      .post(`/api/franchise/orgs/${orgId}/requests/${res.body.id}/decide`)
      .send({ action: "reject" })
      .expect(409);
  });

  it("two concurrent approvals create exactly one invite (one wins, one 409s)", async () => {
    const res = await operator
      .post(`/api/franchise/orgs/${orgId}/requests`)
      .send({
        storefrontTenantId: east1Id,
        targetTenantId: neighborId,
        perkTitle: `Race pact ${RUN}`,
      })
      .expect(201);
    const [a, b] = await Promise.all([
      manager
        .post(`/api/franchise/orgs/${orgId}/requests/${res.body.id}/decide`)
        .send({ action: "approve" }),
      admin
        .post(`/api/franchise/orgs/${orgId}/requests/${res.body.id}/decide`)
        .send({ action: "approve" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const invites = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.perkTitle, `Race pact ${RUN}`));
    expect(invites).toHaveLength(1);
  });

  it("under 'locked', operators cannot initiate at all", async () => {
    await admin
      .patch(`/api/franchise/orgs/${orgId}`)
      .send({ autonomyPolicy: "locked" })
      .expect(200);
    await operator
      .post(`/api/franchise/orgs/${orgId}/requests`)
      .send({
        storefrontTenantId: east1Id,
        targetTenantId: neighborId,
        perkTitle: `Locked ${RUN}`,
      })
      .expect(403);
  });
});

describe("corporate roll-up report", () => {
  beforeAll(async () => {
    // Seed analytics + ledger rows: east1 gets 2 impressions + 1 crossover
    // with $100 revenue; east2 gets 1 claim; west gets a $250 ledger entry.
    const [p] = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.hostTenantId, east1Id))
      .limit(1);
    await db.insert(coopEventsTable).values([
      { tenantId: east1Id, partnershipId: p.id, partnerTenantId: east1Id, eventType: "impression" },
      { tenantId: east1Id, partnershipId: p.id, partnerTenantId: east1Id, eventType: "impression" },
      { tenantId: east1Id, partnershipId: p.id, partnerTenantId: east1Id, eventType: "crossover", revenueAmount: "100.00" },
      { tenantId: east2Id, partnershipId: p.id, partnerTenantId: east1Id, eventType: "claim" },
    ]);
    await db.insert(platformLedgerEntriesTable).values({
      source: "visit_checkout",
      sourceRef: `test:${RUN}`,
      tenantId: westId,
      category: "Visits",
      amount: "250.00",
      occurredAt: new Date(),
    });
  });

  // No ledger cleanup: platform_ledger_entries is append-only by trigger.
  // Deleting the run's tenants sets the row's tenant_id to NULL (legacy
  // scope), so it can never leak into another org's roll-up.

  it("aggregates across the whole org for super admins with drill-down", async () => {
    const res = await admin.get(`/api/franchise/orgs/${orgId}/rollup`).expect(200);
    expect(res.body.totals.impressions).toBeGreaterThanOrEqual(2);
    expect(res.body.totals.claims).toBeGreaterThanOrEqual(1);
    expect(res.body.totals.crossovers).toBeGreaterThanOrEqual(1);
    expect(res.body.totals.revenueInfluenced).toBeGreaterThanOrEqual(100);
    expect(res.body.totals.ledgerRevenue).toBeGreaterThanOrEqual(250);
    const east = res.body.regions.find((r: any) => r.regionId === eastRegionId);
    expect(east.storefronts.map((s: any) => s.tenantId).sort()).toEqual(
      [east1Id, east2Id].sort(),
    );
    const east1 = east.storefronts.find((s: any) => s.tenantId === east1Id);
    expect(east1.totals.crossovers).toBe(1);
    expect(east1.totals.revenueInfluenced).toBe(100);
    // Storefront totals sum into their region.
    expect(east.totals.impressions).toBe(
      east.storefronts.reduce((n: number, s: any) => n + s.totals.impressions, 0),
    );
  });

  it("region-scopes the roll-up for regional managers", async () => {
    const res = await manager.get(`/api/franchise/orgs/${orgId}/rollup`).expect(200);
    const tenantIdsSeen = res.body.regions.flatMap((r: any) =>
      r.storefronts.map((s: any) => s.tenantId),
    );
    expect(tenantIdsSeen.sort()).toEqual([east1Id, east2Id].sort());
    // West's ledger revenue never leaks into the region-scoped totals.
    expect(res.body.totals.ledgerRevenue).toBeLessThan(250);
  });
});

describe("single-tenant co-op behavior is untouched", () => {
  it("a tenant outside any org still uses the normal perk surface", async () => {
    const res = await admin
      .get("/api/coop/perks")
      .set("x-tenant-id", String(soloId))
      .expect(200);
    // No franchise perks, no errors — plain empty perk list for a fresh tenant.
    expect(res.body.perks.filter((p: any) => p.perkTitle.includes("Franchise"))).toHaveLength(0);
  });

  it("detaching a storefront retires its template-derived perks", async () => {
    await admin.delete(`/api/franchise/orgs/${orgId}/storefronts/${westId}`).expect(204);
    const res = await admin
      .get("/api/coop/perks")
      .set("x-tenant-id", String(westId))
      .expect(200);
    expect(res.body.perks.filter((p: any) => p.perkTitle.startsWith("Franchise VIP"))).toHaveLength(0);
  });
});
