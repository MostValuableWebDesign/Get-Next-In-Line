import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, sosCustomersTable, messagesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Bulk recovery after a Twilio outage: POST /api/sos/messages/retry-failed
// retries ALL of today's failed operational outbound SMS for the tenant in
// one click, through the same per-message resend path (new row linked via
// payload.retryOf). Messages that already have a successful retry — or whose
// failed retry is itself in the batch (chain tip) — are skipped so no
// customer is ever double-texted. Returns { retried, skipped } counts.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `bulkretry-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenantId: number;
let otherTenantId: number;
let customerId: number;

async function insertMessage(values: Partial<typeof messagesTable.$inferInsert>) {
  const [row] = await db
    .insert(messagesTable)
    .values({
      tenantId,
      customerId,
      direction: "outbound",
      kind: "manual",
      channel: "sms",
      toNumber: "+15550109888",
      body: `bulk retry test ${RUN}`,
      status: "failed",
      errorCode: "30003",
      ...values,
    } as typeof messagesTable.$inferInsert)
    .returning();
  return row;
}

async function retriesOf(originalId: number) {
  return db
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.tenantId, tenantId),
        sql`(${messagesTable.payload}->>'retryOf')::int = ${originalId}`,
      ),
    );
}

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .set("x-tenant-id", "legacy")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `BulkRetry A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `BulkRetry B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  tenantId = tenants[0].id;
  otherTenantId = tenants[1].id;

  const customers = await db
    .insert(sosCustomersTable)
    .values([{ tenantId, name: `BulkRetry ${RUN}`, phone: "+15550109888" }])
    .returning({ id: sosCustomersTable.id });
  customerId = customers[0].id;
});

afterAll(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, otherTenantId));
});

describe("POST /api/sos/messages/retry-failed", () => {
  it("retries today's failed texts, skips already-retried ones, and never double-sends a chain", async () => {
    // (a) plain failed message → should be retried
    const plain = await insertMessage({});
    // (b) failed message that already has a SUCCESSFUL retry → skipped
    const alreadyRetried = await insertMessage({});
    await insertMessage({
      status: "sent",
      errorCode: null,
      payload: { retryOf: alreadyRetried.id },
    });
    // (c) failed message whose retry ALSO failed → only the chain tip
    //     (the failed retry) is resent; the original is skipped.
    const chainRoot = await insertMessage({});
    const chainTip = await insertMessage({ payload: { retryOf: chainRoot.id } });
    // (d) yesterday's failure → out of scope, untouched
    const yesterday = await insertMessage({});
    await db
      .update(messagesTable)
      .set({ createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000) })
      .where(eq(messagesTable.id, yesterday.id));
    // (e) another tenant's failure → untouched
    const foreign = await insertMessage({ tenantId: otherTenantId, customerId: null });

    const res = await agent
      .post("/api/sos/messages/retry-failed")
      .set("x-tenant-id", String(tenantId))
      .expect(200);

    // Retried: plain + chainTip. Skipped: alreadyRetried + chainRoot.
    expect(res.body).toEqual({ retried: 2, skipped: 2 });

    const plainRetries = await retriesOf(plain.id);
    expect(plainRetries).toHaveLength(1);
    expect(plainRetries[0].status).toBe("simulated"); // no Twilio creds in tests
    expect(plainRetries[0].body).toBe(plain.body);

    // Already-successfully-retried message got NO new retry (still just 1).
    expect(await retriesOf(alreadyRetried.id)).toHaveLength(1);

    // Chain: root untouched (still one failed retry pointing at it), tip resent once.
    expect(await retriesOf(chainRoot.id)).toHaveLength(1);
    expect(await retriesOf(chainTip.id)).toHaveLength(1);

    // Yesterday's and the other tenant's failures untouched.
    expect(await retriesOf(yesterday.id)).toHaveLength(0);
    const foreignRetries = await db
      .select()
      .from(messagesTable)
      .where(sql`(${messagesTable.payload}->>'retryOf')::int = ${foreign.id}`);
    expect(foreignRetries).toHaveLength(0);

    // Idempotent second click: everything now has a successful retry.
    const res2 = await agent
      .post("/api/sos/messages/retry-failed")
      .set("x-tenant-id", String(tenantId))
      .expect(200);
    expect(res2.body).toEqual({ retried: 0, skipped: 4 });
    expect(await retriesOf(plain.id)).toHaveLength(1);
    expect(await retriesOf(chainTip.id)).toHaveLength(1);
  });

  it("is tenant-scoped: the other tenant retries only its own failure, then reports it skipped", async () => {
    // The other tenant's single failed message (inserted in the first test)
    // is ITS candidate — the first bulk call retries exactly that one.
    const res = await agent
      .post("/api/sos/messages/retry-failed")
      .set("x-tenant-id", String(otherTenantId))
      .expect(200);
    expect(res.body).toEqual({ retried: 1, skipped: 0 });

    // Second click: the successful retry exists, nothing is re-sent.
    const res2 = await agent
      .post("/api/sos/messages/retry-failed")
      .set("x-tenant-id", String(otherTenantId))
      .expect(200);
    expect(res2.body).toEqual({ retried: 0, skipped: 1 });
  });
});
