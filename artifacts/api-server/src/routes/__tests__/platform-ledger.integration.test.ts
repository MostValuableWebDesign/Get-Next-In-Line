import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  tenantModulesTable,
  tenantActivitiesTable,
  platformLedgerEntriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Platform compliance ledger — append-only capture of money-relevant events
// plus the admin-only aggregation/export endpoints.
//
// Other integration tests run in parallel against the same database, so this
// suite never asserts on global aggregates — it only asserts on ledger rows
// and per-tenant contributions belonging to tenants it created itself.
// Runs against the REAL Postgres dev database.
// NOTE: ledger rows are immutable by design (DB trigger blocks UPDATE/DELETE)
// so cleanup deletes the tenants only; the tenant FK nulls out on delete.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // session cookies over plain HTTP in supertest

const RUN = `ledger-${Date.now()}-${process.pid}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

let app: import("express").Express;
const tenantIds: number[] = [];

async function freshTenant(tag: string) {
  const [t] = await db
    .insert(tenantsTable)
    .values({ brandName: `Ledger ${tag} ${RUN}`, subdomain: `lg-${tag}-${RUN}`, status: "active", mrr: "0" })
    .returning({ id: tenantsTable.id });
  tenantIds.push(t.id);
  return t.id;
}

beforeAll(async () => {
  app = (await import("../../app")).default;
});

afterAll(async () => {
  for (const id of tenantIds) {
    await db.delete(tenantActivitiesTable).where(eq(tenantActivitiesTable.tenantId, id));
    await db.delete(tenantModulesTable).where(eq(tenantModulesTable.tenantId, id));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id));
  }
});

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

async function ledgerRowsForTenant(tenantId: number) {
  return db
    .select()
    .from(platformLedgerEntriesTable)
    .where(eq(platformLedgerEntriesTable.tenantId, tenantId));
}

describe("platform ledger event capture", () => {
  it("a marked-up checkout lands as an immutable module_subscription entry with realized amounts", async () => {
    const agent = await loggedInAgent();
    const tenantId = await freshTenant("mk");
    const pricing = (await agent.get("/api/modules/pricing")).body;
    const modules = (await agent.get("/api/modules")).body;
    const mod = modules.find((m: { name: string }) => m.name === "Smart Booking System");
    const price = pricing.find((p: { id: number }) => p.id === mod.id);

    const res = await agent
      .post("/api/billing/checkout")
      .send({ tenantId, moduleIds: [mod.id], applyMarkup: true });
    expect(res.status).toBe(200);

    const rows = await ledgerRowsForTenant(tenantId);
    expect(rows).toHaveLength(1);
    const entry = rows[0];
    expect(entry.source).toBe("module_subscription");
    expect(entry.category).toBe(mod.category);
    expect(parseFloat(entry.amount)).toBe(price.resalePrice);
    expect(parseFloat(entry.wholesaleAmount!)).toBe(price.wholesalePrice);
    expect(parseFloat(entry.platformMargin)).toBe(round2(price.resalePrice - price.wholesalePrice));

    // Append-only contract: the DB itself refuses mutation of ledger rows.
    // (Drizzle wraps the trigger's message, so assert the failure and then
    // that the row is bit-for-bit unchanged.)
    await expect(
      db
        .update(platformLedgerEntriesTable)
        .set({ amount: "999999.00" })
        .where(eq(platformLedgerEntriesTable.id, entry.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(platformLedgerEntriesTable).where(eq(platformLedgerEntriesTable.id, entry.id)),
    ).rejects.toThrow();
    const [after] = await db
      .select()
      .from(platformLedgerEntriesTable)
      .where(eq(platformLedgerEntriesTable.id, entry.id));
    expect(after).toEqual(entry);
  });

  it("a pass-through checkout (applyMarkup: false) records zero platform margin", async () => {
    const agent = await loggedInAgent();
    const tenantId = await freshTenant("nomk");
    const modules = (await agent.get("/api/modules")).body;
    const mod = modules.find((m: { name: string }) => m.name === "Commission & Split Tracker");

    const res = await agent
      .post("/api/billing/checkout")
      .send({ tenantId, moduleIds: [mod.id], applyMarkup: false });
    expect(res.status).toBe(200);

    const rows = await ledgerRowsForTenant(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(rows[0].wholesaleAmount);
    expect(parseFloat(rows[0].platformMargin)).toBe(0);
  });

  it("a partner-category checkout is always pass-through with zero platform margin", async () => {
    const agent = await loggedInAgent();
    const tenantId = await freshTenant("ptr");
    const modules = (await agent.get("/api/modules")).body;
    const partner = modules.find((m: { categorySlug: string }) => m.categorySlug === "partners");
    expect(partner, "no partner-category module found").toBeDefined();

    // Even with markup explicitly requested, partner billing is contractual
    // pass-through — the ledger must record zero margin.
    const res = await agent
      .post("/api/billing/checkout")
      .send({ tenantId, moduleIds: [partner.id], applyMarkup: true });
    expect(res.status).toBe(200);

    const rows = await ledgerRowsForTenant(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("module_subscription");
    expect(rows[0].amount).toBe(rows[0].wholesaleAmount);
    expect(parseFloat(rows[0].platformMargin)).toBe(0);
  });
});

describe("admin compliance summary and export", () => {
  it("rejects an invalid or missing period", async () => {
    const agent = await loggedInAgent();
    expect((await agent.get("/api/admin/compliance/summary")).status).toBe(400);
    expect(
      (
        await agent.get(
          "/api/admin/compliance/summary?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z",
        )
      ).status,
    ).toBe(400);
    expect((await agent.get("/api/admin/compliance/export?from=bogus&to=alsobogus")).status).toBe(400);
  });

  it("requires an authenticated session", async () => {
    const res = await request(app).get(
      "/api/admin/compliance/summary?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z",
    );
    expect(res.status).toBe(401);
  });

  it("aggregates this tenant's checkout into per-tenant contributions and source volume", async () => {
    const agent = await loggedInAgent();
    const tenantId = await freshTenant("agg");
    const modules = (await agent.get("/api/modules")).body;
    const mod = modules.find((m: { name: string }) => m.name === "Smart Booking System");

    const from = new Date(Date.now() - 60_000).toISOString();
    await agent.post("/api/billing/checkout").send({ tenantId, moduleIds: [mod.id], applyMarkup: true });
    const to = new Date(Date.now() + 60_000).toISOString();

    const res = await agent.get(
      `/api/admin/compliance/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    expect(res.status).toBe(200);

    const [entry] = await ledgerRowsForTenant(tenantId);
    const mine = res.body.tenantContributions.find(
      (t: { tenantId: number | null }) => t.tenantId === tenantId,
    );
    expect(mine).toBeDefined();
    expect(mine.entryCount).toBe(1);
    expect(mine.amount).toBe(parseFloat(entry.amount));
    expect(mine.platformMargin).toBe(parseFloat(entry.platformMargin));

    const subSource = res.body.bySource.find(
      (s: { source: string }) => s.source === "module_subscription",
    );
    expect(subSource.entryCount).toBeGreaterThanOrEqual(1);
    expect(res.body.totals.entryCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.mrrByCategory)).toBe(true);
  });

  it("exports a server-side CSV containing this tenant's ledger entry", async () => {
    const agent = await loggedInAgent();
    const tenantId = await freshTenant("csv");
    const modules = (await agent.get("/api/modules")).body;
    const mod = modules.find((m: { name: string }) => m.name === "Smart Booking System");

    const from = new Date(Date.now() - 60_000).toISOString();
    await agent.post("/api/billing/checkout").send({ tenantId, moduleIds: [mod.id], applyMarkup: true });
    const to = new Date(Date.now() + 60_000).toISOString();

    const res = await agent.get(
      `/api/admin/compliance/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("compliance-report-");

    const [entry] = await ledgerRowsForTenant(tenantId);
    const lines = res.text.split("\r\n");
    expect(lines[0]).toBe(
      "Entry ID,Source,Reference,Tenant ID,Tenant,Category,Description,Amount,Wholesale Amount,Platform Margin,Occurred At,Recorded At",
    );
    const myLine = lines.find((l) => l.includes(`,${entry.sourceRef},`));
    expect(myLine).toBeDefined();
    expect(myLine).toContain(`,${tenantId},`);
    expect(myLine).toContain(parseFloat(entry.amount).toFixed(2));
  });
});
