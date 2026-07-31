import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, modulesTable, tenantsTable, partnerConnectionsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { decryptToken } from "../../lib/partnerCrypto";
import { computePartnerWebhookSignature, PARTNER_WEBHOOK_SIGNATURE_HEADER } from "../partners";

// ---------------------------------------------------------------------------
// Partner-Direct proxy engine (/api/v1/partners/{partnerId}) integration tests
// against the REAL dev database:
//   - connection state machine: not_connected → pending → active → not_connected
//   - handshake state validation (mismatch → error state + audit event)
//   - credentials stored encrypted, NEVER present in any API response
//   - webhook listener updates lastSyncAt and appends audit events (session-exempt)
//   - tenant scoping: x-tenant-id connections don't leak into the legacy scope
//
// Isolation: a throwaway partner module + tenant with unique per-run names.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;

const RUN = `pconn-${Date.now()}-${process.pid}`;
const BRAND = `TestPartner ${RUN}`;
const PARTNER_ID = `testpartner-${RUN}`;

let app: import("express").Express;
let moduleId: number;
let tenantId: number;

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

/** Deep-scan any JSON payload for credential/token leakage. */
function assertNoCredentialLeak(payload: unknown) {
  const text = JSON.stringify(payload);
  expect(text).not.toMatch(/accessToken/i);
  expect(text).not.toMatch(/refreshToken/i);
  expect(text).not.toMatch(/sandbox_access/);
  expect(text).not.toMatch(/sandbox_refresh/);
  expect(text).not.toMatch(/oauthState/);
  expect(text).not.toMatch(/webhookSecret/i);
  expect(text).not.toMatch(/whsec_/);
}

/** Look up the connection's webhook signing secret straight from the DB (test-only). */
async function webhookSecretFor(tenant: number | null): Promise<string> {
  const rows = await db
    .select()
    .from(partnerConnectionsTable)
    .where(eq(partnerConnectionsTable.moduleId, moduleId));
  const row = rows.find((r) => r.tenantId === tenant);
  expect(row?.webhookSecretEncrypted).toBeTruthy();
  return decryptToken(row!.webhookSecretEncrypted!);
}

/** Deliver a signed webhook exactly as a real partner gateway would. */
function signedHook(payload: unknown, secret: string, tenantHeader?: string) {
  const raw = JSON.stringify(payload);
  let r = request(app)
    .post(`/api/v1/partners/${PARTNER_ID}/webhook`)
    .set("content-type", "application/json")
    .set(PARTNER_WEBHOOK_SIGNATURE_HEADER, computePartnerWebhookSignature(secret, Buffer.from(raw)));
  if (tenantHeader) r = r.set("x-tenant-id", tenantHeader);
  return r.send(raw);
}

beforeAll(async () => {
  app = (await import("../../app")).default;
  const [mod] = await db
    .insert(modulesTable)
    .values({
      name: `Partner Module ${RUN}`,
      category: "Partner-Direct Integrations",
      categorySlug: "partners",
      description: "throwaway partner module for connection tests",
      wholesalePrice: "0.00",
      isActive: true,
      partnerBrand: BRAND,
      markupPercentOverride: "0",
    })
    .returning({ id: modulesTable.id });
  moduleId = mod.id;

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `Conn Tenant ${RUN}`, subdomain: `${RUN}-t` })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;
});

afterAll(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  await db.delete(modulesTable).where(eq(modulesTable.id, moduleId));
});

describe("partner connection lifecycle", () => {
  it("lists the partner as not_connected initially and requires auth", async () => {
    const unauthed = await request(app).get("/api/v1/partners");
    expect(unauthed.status).toBe(401);

    const agent = await loggedInAgent();
    const res = await agent.get("/api/v1/partners");
    expect(res.status).toBe(200);
    const entry = res.body.find((p: { moduleId: number }) => p.moduleId === moduleId);
    expect(entry).toBeDefined();
    expect(entry.partnerId).toBe(PARTNER_ID);
    expect(entry.partnerBrand).toBe(BRAND);
    expect(entry.status).toBe("not_connected");
    assertNoCredentialLeak(res.body);
  });

  it("connect → pending, callback with valid state → active, disconnect → not_connected", async () => {
    const agent = await loggedInAgent();

    // 1. initiate
    const connectRes = await agent.post(`/api/v1/partners/${PARTNER_ID}/connect`);
    expect(connectRes.status).toBe(200);
    expect(connectRes.body.status).toBe("pending");
    expect(connectRes.body.state).toMatch(/^st_/);
    expect(connectRes.body.authorizationUrl).toContain(PARTNER_ID);
    assertNoCredentialLeak(connectRes.body);

    // wrong state must NOT activate — flips to error and records an audit event
    const badCb = await agent
      .post(`/api/v1/partners/${PARTNER_ID}/callback`)
      .send({ state: "st_wrong", code: "code-x" });
    expect(badCb.status).toBe(400);
    let status = await agent.get(`/api/v1/partners/${PARTNER_ID}/status`);
    expect(status.body.status).toBe("error");
    expect(status.body.lastError).toBeTruthy();
    expect(status.body.events.some((e: { eventType: string }) => e.eventType === "connection_error")).toBe(true);

    // 2. restart + authorize with the correct state
    const retry = await agent.post(`/api/v1/partners/${PARTNER_ID}/connect`);
    const cb = await agent
      .post(`/api/v1/partners/${PARTNER_ID}/callback`)
      .send({ state: retry.body.state, code: "code-ok" });
    expect(cb.status).toBe(200);
    expect(cb.body.status).toBe("active");
    expect(cb.body.connectedAt).toBeTruthy();
    expect(cb.body.lastSyncAt).toBeTruthy();
    assertNoCredentialLeak(cb.body);

    // credentials are stored encrypted at rest (never plaintext)
    const [row] = await db
      .select()
      .from(partnerConnectionsTable)
      .where(eq(partnerConnectionsTable.moduleId, moduleId));
    expect(row.accessTokenEncrypted).toMatch(/^v1:/);
    expect(row.refreshTokenEncrypted).toMatch(/^v1:/);
    expect(row.accessTokenEncrypted).not.toContain("sandbox_access");
    expect(row.oauthState).toBeNull();

    // a webhook signing secret is issued at authorization time (encrypted at rest)
    expect(row.webhookSecretEncrypted).toMatch(/^v1:/);
    expect(row.webhookSecretEncrypted).not.toContain("whsec_");
    const secret = decryptToken(row.webhookSecretEncrypted!);
    expect(secret).toMatch(/^whsec_/);

    // 3a. UNSIGNED webhook is rejected and never touches the audit log
    const unsigned = await request(app)
      .post(`/api/v1/partners/${PARTNER_ID}/webhook`)
      .send({ event: `unsigned.event.${RUN}` });
    expect(unsigned.status).toBe(401);

    // 3b. wrong signature is rejected too
    const badSig = await request(app)
      .post(`/api/v1/partners/${PARTNER_ID}/webhook`)
      .set(PARTNER_WEBHOOK_SIGNATURE_HEADER, "deadbeef".repeat(8))
      .set("content-type", "application/json")
      .send(JSON.stringify({ event: `badsig.event.${RUN}` }));
    expect(badSig.status).toBe(401);

    // 3c. properly signed webhook (no session) records event + bumps lastSyncAt
    const before = row.lastSyncAt!.getTime();
    await new Promise((r) => setTimeout(r, 15));
    const hook = await signedHook({ event: "payroll.synced" }, secret);
    expect(hook.status).toBe(200);
    expect(hook.body.received).toBe(true);

    status = await agent.get(`/api/v1/partners/${PARTNER_ID}/status`);
    expect(status.body.status).toBe("active");
    expect(new Date(status.body.lastSyncAt).getTime()).toBeGreaterThan(before);
    const types = status.body.events.map((e: { eventType: string }) => e.eventType);
    expect(types).toContain("webhook_received");
    // rejected unsigned/mis-signed deliveries never reached the audit log
    const details = status.body.events.map((e: { details: string | null }) => e.details);
    expect(details).not.toContain(`unsigned.event.${RUN}`);
    expect(details).not.toContain(`badsig.event.${RUN}`);
    expect(types).toContain("connection_authorized");
    expect(types).toContain("connection_initiated");
    assertNoCredentialLeak(status.body);

    // 4. disconnect purges credentials
    const disc = await agent.post(`/api/v1/partners/${PARTNER_ID}/disconnect`);
    expect(disc.status).toBe(200);
    expect(disc.body.status).toBe("not_connected");
    const [after] = await db
      .select()
      .from(partnerConnectionsTable)
      .where(eq(partnerConnectionsTable.moduleId, moduleId));
    expect(after.accessTokenEncrypted).toBeNull();
    expect(after.refreshTokenEncrypted).toBeNull();

    // webhook against a non-active connection is rejected
    const deadHook = await request(app)
      .post(`/api/v1/partners/${PARTNER_ID}/webhook`)
      .send({ event: "noop" });
    expect(deadHook.status).toBe(404);
  });

  it("scopes connections by x-tenant-id (tenant vs legacy NULL)", async () => {
    const agent = await loggedInAgent();

    const connect = await agent
      .post(`/api/v1/partners/${PARTNER_ID}/connect`)
      .set("x-tenant-id", String(tenantId));
    const cb = await agent
      .post(`/api/v1/partners/${PARTNER_ID}/callback`)
      .set("x-tenant-id", String(tenantId))
      .send({ state: connect.body.state, code: "tenant-code" });
    expect(cb.status).toBe(200);
    expect(cb.body.status).toBe("active");

    // Legacy (no header) scope must not see the tenant's active connection.
    const legacy = await agent.get(`/api/v1/partners/${PARTNER_ID}/status`);
    expect(legacy.body.status).not.toBe("active");

    const scoped = await agent
      .get(`/api/v1/partners/${PARTNER_ID}/status`)
      .set("x-tenant-id", String(tenantId));
    expect(scoped.body.status).toBe("active");
  });

  it("ignores a spoofed tenantId in the webhook body", async () => {
    const agent = await loggedInAgent();

    // No header + a body tenantId naming the tenant with the active
    // connection: the body must NOT redirect scope, so the legacy (NULL)
    // scope matches nothing and the event is rejected.
    const spoof = await request(app)
      .post(`/api/v1/partners/${PARTNER_ID}/webhook`)
      .send({ event: `spoofed.event.${RUN}`, tenantId });
    expect(spoof.status).toBe(404);
    const scoped = await agent
      .get(`/api/v1/partners/${PARTNER_ID}/status`)
      .set("x-tenant-id", String(tenantId));
    expect(
      scoped.body.events.some((e: { details: string | null }) => e.details === `spoofed.event.${RUN}`)
    ).toBe(false);

    // Header-scoped, properly signed webhook with a mismatched body tenantId
    // still lands on the header-derived connection — the body value is
    // ignored, not honored.
    const secret = await webhookSecretFor(tenantId);
    const hook = await signedHook(
      { event: `real.event.${RUN}`, tenantId: 99999999 },
      secret,
      String(tenantId)
    );
    expect(hook.status).toBe(200);
    const after = await agent
      .get(`/api/v1/partners/${PARTNER_ID}/status`)
      .set("x-tenant-id", String(tenantId));
    expect(
      after.body.events.some((e: { details: string | null }) => e.details === `real.event.${RUN}`)
    ).toBe(true);
  });

  it("404s for an unknown partner", async () => {
    const agent = await loggedInAgent();
    const res = await agent.post(`/api/v1/partners/not-a-partner-${RUN}/connect`);
    expect(res.status).toBe(404);
  });

  it("hides retired (inactive) partner modules: not listed, not connectable", async () => {
    // Retire the throwaway module the way the connector seed does — the row
    // survives (history intact) but every partner surface must go dark.
    await db.update(modulesTable).set({ isActive: false }).where(eq(modulesTable.id, moduleId));
    try {
      const agent = await loggedInAgent();

      const list = await agent.get("/api/v1/partners");
      expect(list.status).toBe(200);
      expect(list.body.find((p: { moduleId: number }) => p.moduleId === moduleId)).toBeUndefined();

      const connect = await agent.post(`/api/v1/partners/${PARTNER_ID}/connect`);
      expect(connect.status).toBe(404);
      const status = await agent.get(`/api/v1/partners/${PARTNER_ID}/status`);
      expect(status.status).toBe(404);
    } finally {
      await db.update(modulesTable).set({ isActive: true }).where(eq(modulesTable.id, moduleId));
    }
  });
});
