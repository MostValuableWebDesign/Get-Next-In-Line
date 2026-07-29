import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  perkPassesTable,
  coopPerkRedemptionsTable,
  coopAttributionEventsTable,
  gatewayApiCallsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-Op Developer API Gateway — tokenized public API.
//
//   - merchant token lifecycle: create (shown once) / rotate / revoke,
//     session-required, tenant-scoped isolation
//   - bearer auth on /v1/gateway: missing, invalid, revoked, rotated-away
//   - tenant binding: partner directory is the token tenant's, x-tenant-id
//     header on public calls is ignored, cross-tenant vouchers are opaque
//   - redemption push mirrors native integrity: participant enforcement,
//     single-use lock, attribution, replay is an ignored no-op
//   - sandbox tokens: fixture partners/vouchers, responses flagged, no live
//     perk/redemption writes
//   - every call (including auth failures) lands in the merchant call log
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;

const RUN = `gwapi-${Date.now()}-${process.pid}`;

let app: import("express").Express;
let tenantId: number;
let partnerTenantId: number;
let outsiderTenantId: number;
let partnershipId: number;

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

interface TokenRow {
  id: number;
  label: string;
  tokenPrefix: string;
  sandbox: boolean;
  status: string;
  token?: string;
}

async function createToken(
  forTenantId: number,
  label: string,
  sandbox = false
): Promise<TokenRow & { token: string }> {
  const agent = await loggedInAgent();
  const res = await agent
    .post("/api/gateway/tokens")
    .set("x-tenant-id", String(forTenantId))
    .send({ label, sandbox });
  expect(res.status).toBe(201);
  expect(res.body.token).toMatch(sandbox ? /^gwk_test_/ : /^gwk_live_/);
  return res.body;
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function grantPass(token: string, expiresInMs = 24 * 60 * 60 * 1000) {
  const [pass] = await db
    .insert(perkPassesTable)
    .values({
      partnershipId,
      grantedByTenantId: tenantId,
      customerPhone: "+15553010001",
      token,
      expiresAt: new Date(Date.now() + expiresInMs),
    })
    .returning();
  return pass;
}

beforeAll(async () => {
  app = (await import("../../app")).default;
  const rows = await db
    .insert(tenantsTable)
    .values([
      { brandName: `GW Tenant ${RUN}`, subdomain: `${RUN}-a` },
      { brandName: `GW Partner ${RUN}`, subdomain: `${RUN}-b` },
      { brandName: `GW Outsider ${RUN}`, subdomain: `${RUN}-c` },
    ])
    .returning({ id: tenantsTable.id });
  tenantId = rows[0].id;
  partnerTenantId = rows[1].id;
  outsiderTenantId = rows[2].id;
  const [p] = await db
    .insert(merchantCoopPartnershipsTable)
    .values({
      hostTenantId: tenantId,
      partnerTenantId,
      perkTitle: `GW perk ${RUN}`,
      redemptionCode: `GWPERK-${RUN}`,
      status: "accepted",
      isActive: true,
    })
    .returning({ id: merchantCoopPartnershipsTable.id });
  partnershipId = p.id;
});

afterAll(async () => {
  for (const id of [tenantId, partnerTenantId, outsiderTenantId]) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id));
  }
});

describe("token management", () => {
  it("requires a session for the merchant token/call surfaces", async () => {
    expect((await request(app).get("/api/gateway/tokens")).status).toBe(401);
    expect((await request(app).post("/api/gateway/tokens").send({ label: "x" })).status).toBe(401);
    expect((await request(app).get("/api/gateway/calls")).status).toBe(401);
  });

  it("creates a token: full value shown once, list only exposes the prefix", async () => {
    const created = await createToken(tenantId, `List ${RUN}`);
    const agent = await loggedInAgent();
    const res = await agent.get("/api/gateway/tokens").set("x-tenant-id", String(tenantId));
    expect(res.status).toBe(200);
    const row = (res.body as TokenRow[]).find((t) => t.id === created.id)!;
    expect(row.tokenPrefix).toMatch(/^gwk_live_/);
    expect(row.tokenPrefix.length).toBeLessThan(20);
    expect(JSON.stringify(res.body)).not.toContain(created.token);
  });

  it("token lists are tenant-isolated", async () => {
    const mine = await createToken(tenantId, `Iso ${RUN}`);
    const agent = await loggedInAgent();
    const other = await agent
      .get("/api/gateway/tokens")
      .set("x-tenant-id", String(outsiderTenantId));
    expect((other.body as TokenRow[]).some((t) => t.id === mine.id)).toBe(false);
    // Rotate/revoke against a foreign tenant scope 404s.
    const rot = await agent
      .post(`/api/gateway/tokens/${mine.id}/rotate`)
      .set("x-tenant-id", String(outsiderTenantId));
    expect(rot.status).toBe(404);
  });

  it("rotation invalidates the old value and issues a new one", async () => {
    const created = await createToken(tenantId, `Rotate ${RUN}`);
    const agent = await loggedInAgent();
    const rot = await agent
      .post(`/api/gateway/tokens/${created.id}/rotate`)
      .set("x-tenant-id", String(tenantId));
    expect(rot.status).toBe(200);
    expect(rot.body.token).toMatch(/^gwk_live_/);
    expect(rot.body.token).not.toBe(created.token);
    const oldRes = await request(app).get("/api/v1/gateway/partners").set(bearer(created.token));
    expect(oldRes.status).toBe(401);
    const newRes = await request(app).get("/api/v1/gateway/partners").set(bearer(rot.body.token));
    expect(newRes.status).toBe(200);
  });

  it("revocation rejects callers and blocks further rotation", async () => {
    const created = await createToken(tenantId, `Revoke ${RUN}`);
    const agent = await loggedInAgent();
    const rev = await agent
      .post(`/api/gateway/tokens/${created.id}/revoke`)
      .set("x-tenant-id", String(tenantId));
    expect(rev.status).toBe(200);
    expect(rev.body.status).toBe("revoked");
    const res = await request(app).get("/api/v1/gateway/partners").set(bearer(created.token));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("revoked_token");
    const rot = await agent
      .post(`/api/gateway/tokens/${created.id}/rotate`)
      .set("x-tenant-id", String(tenantId));
    expect(rot.status).toBe(409);
  });
});

describe("public API auth", () => {
  it("rejects missing and malformed bearer tokens with clear errors", async () => {
    const missing = await request(app).get("/api/v1/gateway/partners");
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe("missing_token");
    const invalid = await request(app)
      .get("/api/v1/gateway/partners")
      .set(bearer("gwk_live_totally-bogus"));
    expect(invalid.status).toBe(401);
    expect(invalid.body.error).toBe("invalid_token");
  });

  it("logs auth failures and successful calls to the merchant call log", async () => {
    const created = await createToken(tenantId, `Log ${RUN}`);
    await request(app).get("/api/v1/gateway/partners").set(bearer(created.token));
    const agent = await loggedInAgent();
    const res = await agent.get("/api/gateway/calls").set("x-tenant-id", String(tenantId));
    expect(res.status).toBe(200);
    const mine = (res.body as { tokenLabel: string | null; outcome: string }[]).filter(
      (c) => c.tokenLabel === `Log ${RUN}`
    );
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0].outcome).toBe("ok");
    // Tokenless auth failures are recorded too (tenantId NULL scope).
    const [failRow] = await db
      .select()
      .from(gatewayApiCallsTable)
      .where(eq(gatewayApiCallsTable.outcome, "auth_failed"))
      .limit(1);
    expect(failRow).toBeTruthy();
  });
});

describe("partner directory", () => {
  it("returns the token tenant's live partners and ignores x-tenant-id", async () => {
    const created = await createToken(tenantId, `Dir ${RUN}`);
    const res = await request(app)
      .get("/api/v1/gateway/partners")
      .set(bearer(created.token))
      // Attempted cross-tenant redirect must be ignored: scope is the token's.
      .set("x-tenant-id", String(outsiderTenantId));
    expect(res.status).toBe(200);
    expect(res.body.sandbox).toBe(false);
    const titles = res.body.partners.map((p: { perkTitle: string }) => p.perkTitle);
    expect(titles).toContain(`GW perk ${RUN}`);
    // Outsider token sees none of this tenant's partnerships.
    const outsider = await createToken(outsiderTenantId, `DirOut ${RUN}`);
    const res2 = await request(app).get("/api/v1/gateway/partners").set(bearer(outsider.token));
    expect(
      res2.body.partners.map((p: { perkTitle: string }) => p.perkTitle)
    ).not.toContain(`GW perk ${RUN}`);
  });
});

describe("voucher validation and redemption push", () => {
  it("validates a live voucher and hides other tenants' vouchers", async () => {
    const pass = await grantPass(`WPASS-${RUN}-VALIDATE`);
    const created = await createToken(tenantId, `Val ${RUN}`);
    const ok = await request(app)
      .post("/api/v1/gateway/vouchers/validate")
      .set(bearer(created.token))
      .send({ code: pass.token });
    expect(ok.status).toBe(200);
    expect(ok.body.valid).toBe(true);
    expect(ok.body.perkTitle).toBe(`GW perk ${RUN}`);
    // A non-participant tenant's token learns nothing beyond "not valid".
    const outsider = await createToken(outsiderTenantId, `ValOut ${RUN}`);
    const hidden = await request(app)
      .post("/api/v1/gateway/vouchers/validate")
      .set(bearer(outsider.token))
      .send({ code: pass.token });
    expect(hidden.body.valid).toBe(false);
    expect(hidden.body.perkTitle).toBeNull();
  });

  it("redeems once with attribution; replay is an ignored no-op; outsiders rejected", async () => {
    const pass = await grantPass(`WPASS-${RUN}-REDEEM`);
    const outsider = await createToken(outsiderTenantId, `RedOut ${RUN}`);
    const blocked = await request(app)
      .post("/api/v1/gateway/redemptions")
      .set(bearer(outsider.token))
      .send({ code: pass.token });
    expect(blocked.body.status).toBe("error");
    const created = await createToken(partnerTenantId, `Red ${RUN}`);
    const first = await request(app)
      .post("/api/v1/gateway/redemptions")
      .set(bearer(created.token))
      .send({ code: pass.token });
    expect(first.body.status).toBe("processed");
    const replay = await request(app)
      .post("/api/v1/gateway/redemptions")
      .set(bearer(created.token))
      .send({ code: pass.token });
    expect(replay.body.status).toBe("ignored");
    const [row] = await db
      .select()
      .from(perkPassesTable)
      .where(eq(perkPassesTable.id, pass.id));
    expect(row.redeemedAt).not.toBeNull();
    expect(row.redeemedByTenantId).toBe(partnerTenantId);
    const redemptions = await db
      .select()
      .from(coopPerkRedemptionsTable)
      .where(eq(coopPerkRedemptionsTable.passCode, pass.token));
    expect(redemptions).toHaveLength(1);
    const attributions = await db
      .select()
      .from(coopAttributionEventsTable)
      .where(eq(coopAttributionEventsTable.redemptionId, redemptions[0].id));
    expect(attributions).toHaveLength(1);
    expect(attributions[0].direction).toBe("host_to_partner");
    expect(attributions[0].receivingTenantId).toBe(partnerTenantId);
  });

  it("rejects expired vouchers without writes", async () => {
    const pass = await grantPass(`WPASS-${RUN}-EXPIRED`, -1000);
    const created = await createToken(tenantId, `Exp ${RUN}`);
    const res = await request(app)
      .post("/api/v1/gateway/redemptions")
      .set(bearer(created.token))
      .send({ code: pass.token });
    expect(res.body.status).toBe("error");
    const [row] = await db.select().from(perkPassesTable).where(eq(perkPassesTable.id, pass.id));
    expect(row.redeemedAt).toBeNull();
  });
});

describe("sandbox mode", () => {
  it("serves flagged fixture data and never touches live rows", async () => {
    const sb = await createToken(tenantId, `Sandbox ${RUN}`, true);
    const dir = await request(app).get("/api/v1/gateway/partners").set(bearer(sb.token));
    expect(dir.body.sandbox).toBe(true);
    // Fixture directory, not this tenant's live partnership.
    expect(
      dir.body.partners.map((p: { perkTitle: string }) => p.perkTitle)
    ).not.toContain(`GW perk ${RUN}`);
    expect(dir.body.partners.length).toBeGreaterThan(0);

    const val = await request(app)
      .post("/api/v1/gateway/vouchers/validate")
      .set(bearer(sb.token))
      .send({ code: "WPASS-SANDBOX-VALID" });
    expect(val.body).toMatchObject({ sandbox: true, valid: true });

    // A sandbox token can never redeem a LIVE pass — the fixture path never
    // reads live rows at all.
    const livePass = await grantPass(`WPASS-${RUN}-SBISO`);
    const red = await request(app)
      .post("/api/v1/gateway/redemptions")
      .set(bearer(sb.token))
      .send({ code: livePass.token });
    expect(red.body.sandbox).toBe(true);
    const [row] = await db
      .select()
      .from(perkPassesTable)
      .where(eq(perkPassesTable.id, livePass.id));
    expect(row.redeemedAt).toBeNull();

    const sbRedeem = await request(app)
      .post("/api/v1/gateway/redemptions")
      .set(bearer(sb.token))
      .send({ code: "WPASS-SANDBOX-VALID" });
    expect(sbRedeem.body).toMatchObject({ sandbox: true, status: "processed" });
  });
});
