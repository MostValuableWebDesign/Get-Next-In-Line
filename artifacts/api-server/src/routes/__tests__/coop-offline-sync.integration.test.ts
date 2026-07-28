import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { webcrypto } from "crypto";
import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  coopPerkRedemptionsTable,
  coopAttributionEventsTable,
  coopEventsTable,
  coopOfflineSyncAuditTable,
  coopSigningKeysTable,
  coopTenantSuspensionsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  COOP_PASS_QR_PREFIX,
  parseCoopPassPayload,
  rotateCoopSigningKey,
  signCoopPassPayload,
  verifyCoopPassSignature,
} from "../../lib/coopPassSigning";

// ---------------------------------------------------------------------------
// Co-op offline fallback mode: signed pass payloads, public key distribution
// with rotation, and the idempotent offline-redemption sync endpoint
// (duplicates, conflicts, tenant scoping, and metric parity with online scans).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `offsync-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let anon: ReturnType<typeof request>;
let hostId: number;
let partnerId: number;
let outsiderId: number;
let partnershipId: number;
let redemptionCode: string;

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  anon = request(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Offline Host ${RUN}`, subdomain: `${RUN}-host`, status: "active" },
      { brandName: `Offline Partner ${RUN}`, subdomain: `${RUN}-partner`, status: "active" },
      { brandName: `Offline Outsider ${RUN}`, subdomain: `${RUN}-outsider`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [hostId, partnerId, outsiderId] = tenants.map((t) => t.id);

  const res = await agent
    .post("/api/coop/partnerships")
    .send({ hostTenantId: hostId, partnerTenantId: partnerId, perkTitle: `Offline perk ${RUN}` })
    .expect(201);
  partnershipId = res.body.id;
  redemptionCode = res.body.redemptionCode;
});

afterAll(async () => {
  const ids = [hostId, partnerId, outsiderId].filter((n) => Number.isInteger(n));
  if (ids.length) await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
});

describe("signed pass payloads & key distribution", () => {
  it("signs a payload that round-trips: parse + server-side verify", async () => {
    const exp = new Date(Date.now() + 60 * 60 * 1000);
    const qr = await signCoopPassPayload({ code: redemptionCode, passCode: "C42", expiresAt: exp });
    expect(qr.startsWith(COOP_PASS_QR_PREFIX)).toBe(true);

    const payload = parseCoopPassPayload(qr);
    expect(payload).not.toBeNull();
    expect(payload!.c).toBe(redemptionCode);
    expect(payload!.p).toBe("C42");
    expect(payload!.exp).toBe(Math.floor(exp.getTime() / 1000));
    expect(payload!.kid).toBeTruthy();

    const [key] = await db
      .select()
      .from(coopSigningKeysTable)
      .where(eq(coopSigningKeysTable.keyId, payload!.kid));
    expect(key).toBeDefined();
    expect(verifyCoopPassSignature(qr, key.publicKeyPem)).toBe(true);

    // A tampered payload never verifies.
    const [prefixAndPayload, sig] = [qr.slice(0, qr.lastIndexOf(".")), qr.slice(qr.lastIndexOf(".") + 1)];
    const forged = `${COOP_PASS_QR_PREFIX}${Buffer.from(
      JSON.stringify({ ...payload, p: "C43" })
    ).toString("base64url")}.${sig}`;
    expect(prefixAndPayload).toBeTruthy();
    expect(verifyCoopPassSignature(forged, key.publicKeyPem)).toBe(false);
  });

  it("serves public keys (never private) and the signature verifies with Web Crypto", async () => {
    const res = await agent.get("/api/coop/pass-keys").expect(200);
    expect(res.body.keys.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain("PRIVATE");
    const active = res.body.keys.find((k: { status: string }) => k.status === "active");
    expect(active).toBeDefined();

    // Verify exactly like a merchant browser would: importKey("jwk") + verify.
    const qr = await signCoopPassPayload({ code: redemptionCode, passCode: "C777" });
    const kid = parseCoopPassPayload(qr)!.kid;
    const keyEntry = res.body.keys.find((k: { keyId: string }) => k.keyId === kid);
    expect(keyEntry).toBeDefined();
    const cryptoKey = await webcrypto.subtle.importKey(
      "jwk",
      keyEntry.publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const [encodedPayload, encodedSig] = qr.slice(COOP_PASS_QR_PREFIX.length).split(".");
    const ok = await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      Buffer.from(encodedSig, "base64url"),
      Buffer.from(encodedPayload, "utf8")
    );
    expect(ok).toBe(true);
  });

  it("rotation retires the old key but keeps serving it; new signatures use the new kid", async () => {
    const before = await signCoopPassPayload({ code: redemptionCode, passCode: "Crot" });
    const oldKid = parseCoopPassPayload(before)!.kid;

    await rotateCoopSigningKey();
    const after = await signCoopPassPayload({ code: redemptionCode, passCode: "Crot2" });
    const newKid = parseCoopPassPayload(after)!.kid;
    expect(newKid).not.toBe(oldKid);

    const res = await agent.get("/api/coop/pass-keys").expect(200);
    const byId = new Map(res.body.keys.map((k: { keyId: string; status: string }) => [k.keyId, k.status]));
    expect(byId.get(oldKid)).toBe("retired");
    expect(byId.get(newKid)).toBe("active");
  });

  it("pass-signatures endpoint signs only codes the tenant participates in", async () => {
    const res = await agent
      .post("/api/coop/pass-signatures")
      .set("x-tenant-id", String(hostId))
      .send({ passCode: "C55", codes: [redemptionCode, `NOPE-${RUN}`] })
      .expect(200);
    expect(res.body.signatures.length).toBe(1);
    expect(res.body.signatures[0].code).toBe(redemptionCode);
    const payload = parseCoopPassPayload(res.body.signatures[0].qrPayload);
    expect(payload!.p).toBe("C55");

    // A non-participant tenant gets nothing signed for this code.
    const foreign = await agent
      .post("/api/coop/pass-signatures")
      .set("x-tenant-id", String(outsiderId))
      .send({ passCode: "C55", codes: [redemptionCode] })
      .expect(200);
    expect(foreign.body.signatures.length).toBe(0);

    await agent.post("/api/coop/pass-signatures").send({ passCode: "C55", codes: [redemptionCode] }).expect(400);
  });
});

describe("offline redemption sync", () => {
  const item = (overrides: Partial<Record<string, unknown>> = {}) => ({
    clientRedemptionId: `cr-${RUN}-${Math.random().toString(36).slice(2)}`,
    code: redemptionCode,
    passCode: `P-${RUN}-${Math.random().toString(36).slice(2)}`,
    scannedAt: new Date().toISOString(),
    ...overrides,
  });

  it("requires auth and tenant scope", async () => {
    await anon.post("/api/coop/redemptions/sync").send({ redemptions: [item()] }).expect(401);
    await agent.post("/api/coop/redemptions/sync").send({ redemptions: [item()] }).expect(400);
  });

  it("accepts a queued redemption with full metric parity, and retries are duplicates", async () => {
    const one = item({ passCode: `P-${RUN}-parity` });
    const first = await agent
      .post("/api/coop/redemptions/sync")
      .set("x-tenant-id", String(partnerId))
      .send({ redemptions: [one] })
      .expect(200);
    expect(first.body.results[0].outcome).toBe("accepted");
    expect(first.body.results[0].redeemedAt).toBeTruthy();

    // Redemption row carries the client id; attribution + claim/crossover
    // analytics exist — same records as an online scan.
    const [red] = await db
      .select()
      .from(coopPerkRedemptionsTable)
      .where(eq(coopPerkRedemptionsTable.clientRedemptionId, one.clientRedemptionId as string));
    expect(red).toBeDefined();
    expect(red.partnershipId).toBe(partnershipId);
    expect(red.redeemedByTenantId).toBe(partnerId);
    const [attr] = await db
      .select()
      .from(coopAttributionEventsTable)
      .where(eq(coopAttributionEventsTable.redemptionId, red.id));
    expect(attr).toBeDefined();
    expect(attr.receivingTenantId).toBe(partnerId);
    expect(attr.sendingTenantId).toBe(hostId);
    const events = await db
      .select()
      .from(coopEventsTable)
      .where(eq(coopEventsTable.partnershipId, partnershipId));
    const types = events.filter((e) => e.tenantId === partnerId).map((e) => e.eventType);
    expect(types).toContain("claim");
    expect(types).toContain("crossover");

    // Retrying the exact same batch is idempotent — no second row.
    const second = await agent
      .post("/api/coop/redemptions/sync")
      .set("x-tenant-id", String(partnerId))
      .send({ redemptions: [one] })
      .expect(200);
    expect(second.body.results[0].outcome).toBe("duplicate");
    const rows = await db
      .select()
      .from(coopPerkRedemptionsTable)
      .where(eq(coopPerkRedemptionsTable.clientRedemptionId, one.clientRedemptionId as string));
    expect(rows.length).toBe(1);
  });

  it("flags a pass already redeemed elsewhere as a conflict with an audit trail", async () => {
    const passCode = `P-${RUN}-conflict`;
    // Device A's scan synced (or an online scan happened) first.
    await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(partnerId))
      .send({ code: redemptionCode, passCode })
      .expect(200);

    const losing = item({ passCode });
    const res = await agent
      .post("/api/coop/redemptions/sync")
      .set("x-tenant-id", String(partnerId))
      .send({ redemptions: [losing] })
      .expect(200);
    expect(res.body.results[0].outcome).toBe("conflict");
    expect(res.body.results[0].winningRedeemedAt).toBeTruthy();

    // The losing entry is recorded for audit, not silently dropped.
    const [audit] = await db
      .select()
      .from(coopOfflineSyncAuditTable)
      .where(eq(coopOfflineSyncAuditTable.clientRedemptionId, losing.clientRedemptionId as string));
    expect(audit).toBeDefined();
    expect(audit.outcome).toBe("conflict");
    expect(audit.winningRedemptionId).not.toBeNull();
    expect(audit.tenantId).toBe(partnerId);

    // Retrying the losing item returns the recorded conflict again.
    const retry = await agent
      .post("/api/coop/redemptions/sync")
      .set("x-tenant-id", String(partnerId))
      .send({ redemptions: [losing] })
      .expect(200);
    expect(retry.body.results[0].outcome).toBe("conflict");
  });

  it("rejects items from a non-participant tenant and records them for audit", async () => {
    const bad = item();
    const res = await agent
      .post("/api/coop/redemptions/sync")
      .set("x-tenant-id", String(outsiderId))
      .send({ redemptions: [bad] })
      .expect(200);
    expect(res.body.results[0].outcome).toBe("rejected");
    expect(res.body.results[0].reason).toMatch(/business in this partnership/i);
    const [audit] = await db
      .select()
      .from(coopOfflineSyncAuditTable)
      .where(eq(coopOfflineSyncAuditTable.clientRedemptionId, bad.clientRedemptionId as string));
    expect(audit).toBeDefined();
    expect(audit.outcome).toBe("rejected");
  });

  it("evaluates the perk window at scan time, not sync time", async () => {
    // Window that was open an hour ago but is closed now.
    const HOUR = 60 * 60 * 1000;
    await db
      .update(merchantCoopPartnershipsTable)
      .set({
        perkStartsAt: new Date(Date.now() - 3 * HOUR),
        perkEndsAt: new Date(Date.now() - 10 * 60 * 1000),
      })
      .where(eq(merchantCoopPartnershipsTable.id, partnershipId));

    const inWindow = item({
      passCode: `P-${RUN}-window`,
      scannedAt: new Date(Date.now() - HOUR).toISOString(),
    });
    const res = await agent
      .post("/api/coop/redemptions/sync")
      .set("x-tenant-id", String(partnerId))
      .send({ redemptions: [inWindow] })
      .expect(200);
    expect(res.body.results[0].outcome).toBe("accepted");

    // A scan claimed after the window closed is rejected.
    const late = item({ passCode: `P-${RUN}-late`, scannedAt: new Date().toISOString() });
    const lateRes = await agent
      .post("/api/coop/redemptions/sync")
      .set("x-tenant-id", String(partnerId))
      .send({ redemptions: [late] })
      .expect(200);
    expect(lateRes.body.results[0].outcome).toBe("rejected");
    expect(lateRes.body.results[0].reason).toMatch(/expired/i);

    await db
      .update(merchantCoopPartnershipsTable)
      .set({ perkStartsAt: null, perkEndsAt: null })
      .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
  });

  it("processes mixed batches in order with per-item outcomes", async () => {
    const a = item({ passCode: `P-${RUN}-mix-a` });
    const b = item({ passCode: `P-${RUN}-mix-a` }); // same pass — second loses
    const c = item({ code: `NOPE-${RUN}`, passCode: `P-${RUN}-mix-c` });
    const res = await agent
      .post("/api/coop/redemptions/sync")
      .set("x-tenant-id", String(partnerId))
      .send({ redemptions: [a, b, c] })
      .expect(200);
    expect(res.body.results.map((r: { outcome: string }) => r.outcome)).toEqual([
      "accepted",
      "conflict",
      "rejected",
    ]);
    expect(res.body.results[0].clientRedemptionId).toBe(a.clientRedemptionId);
    expect(res.body.results[1].clientRedemptionId).toBe(b.clientRedemptionId);
  });

  it("rejects redemptions for a mediation-suspended partnership, same as online scans, and retries replay the audited verdict", async () => {
    const [susp] = await db
      .insert(coopTenantSuspensionsTable)
      .values({ tenantId: hostId, trigger: "manual", reason: `Offline test ${RUN}` })
      .returning({ id: coopTenantSuspensionsTable.id });
    const one = item({ passCode: `P-${RUN}-susp` });
    try {
      const res = await agent
        .post("/api/coop/redemptions/sync")
        .set("x-tenant-id", String(partnerId))
        .send({ redemptions: [one] })
        .expect(200);
      expect(res.body.results[0].outcome).toBe("rejected");
      expect(res.body.results[0].reason).toMatch(/suspended pending platform mediation/i);
      // No redemption row was written for the suspended pass.
      const rows = await db
        .select()
        .from(coopPerkRedemptionsTable)
        .where(eq(coopPerkRedemptionsTable.clientRedemptionId, one.clientRedemptionId));
      expect(rows).toHaveLength(0);
      // Retry (even after the suspension is lifted) replays the audited verdict
      // instead of re-evaluating — the outcome is stable.
      await db
        .update(coopTenantSuspensionsTable)
        .set({ status: "lifted", liftedAt: new Date() })
        .where(eq(coopTenantSuspensionsTable.id, susp.id));
      const retry = await agent
        .post("/api/coop/redemptions/sync")
        .set("x-tenant-id", String(partnerId))
        .send({ redemptions: [one] })
        .expect(200);
      expect(retry.body.results[0].outcome).toBe("rejected");
      expect(retry.body.results[0].reason).toMatch(/suspended pending platform mediation/i);
    } finally {
      await db
        .delete(coopTenantSuspensionsTable)
        .where(eq(coopTenantSuspensionsTable.id, susp.id));
    }
  });
});
