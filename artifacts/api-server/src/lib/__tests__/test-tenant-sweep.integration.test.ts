import { describe, it, expect, afterAll } from "vitest";
import { db, tenantsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  isStaleTestTenant,
  sweepStaleTestTenants,
  MIN_AGE_MS,
} from "../testTenantSweep";

// Guard for the stale test-tenant sweep: it must delete a stranded test-run
// tenant (stale timestamped subdomain) while never touching normally-named
// tenants or fresh test tenants from a live run.

const RUN = `sweepguard-${Date.now()}-${process.pid}`;
const STALE_TS = Date.now() - 24 * 60 * 60 * 1000; // "crashed yesterday"
const staleSubdomain = `stale-e2e-${STALE_TS}-${process.pid}`;
const realSubdomain = `real-biz-${RUN.replace(/[^a-z0-9]/g, "")}`.slice(0, 40);

const createdIds: number[] = [];

afterAll(async () => {
  if (createdIds.length > 0) {
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, createdIds));
  }
});

describe("isStaleTestTenant pattern matching", () => {
  const now = Date.now();
  const old = now - MIN_AGE_MS - 1000;

  it("matches the known test-run subdomain shapes when stale", () => {
    for (const sub of [
      `stop-e2e-${old}-4142`,
      `nss-${old}-4142`,
      `cust-link-${old}-4142`,
      `${old}-4142`, // subdomain = RUN with no prefix would still start with prefix, but bare is also test-shaped
      `stop-e2e-${old}-4142-b`, // suffixed variants (-a/-b/-o)
      `dp-tag-${old}-99`,
    ]) {
      expect(isStaleTestTenant(sub, now), sub).toBe(true);
    }
  });

  it("never matches real-looking subdomains", () => {
    for (const sub of [
      "luxelocks",
      "glow-med-spa",
      "salon-2024",
      "barber365",
      "the-1234567890123", // 13 digits but no PID segment
      realSubdomain,
    ]) {
      expect(isStaleTestTenant(sub, now), sub).toBe(false);
    }
  });

  it("spares fresh test tenants (live parallel runs)", () => {
    expect(isStaleTestTenant(`nss-${now - 1000}-4142`, now)).toBe(false);
  });

  it("spares implausible timestamps (future or pre-2020)", () => {
    expect(isStaleTestTenant(`x-${now + 10 * MIN_AGE_MS}-1`, now)).toBe(false);
    expect(isStaleTestTenant(`x-1000000000000-1`, now)).toBe(false);
  });
});

describe("sweepStaleTestTenants", () => {
  it("refuses to delete anything in production mode", async () => {
    const [row] = await db
      .insert(tenantsTable)
      .values({
        brandName: `ProdGuard ${RUN}`,
        subdomain: `prod-guard-${STALE_TS}-${process.pid}`,
        status: "active",
      })
      .returning({ id: tenantsTable.id });
    createdIds.push(row.id);
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const swept = await sweepStaleTestTenants();
      expect(swept).toEqual([]);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
    const still = await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(inArray(tenantsTable.id, [row.id]));
    expect(still).toHaveLength(1);
    // Cleaned up by the non-production sweep below (and afterAll).
  });

  it("deletes a stale test tenant but leaves a real tenant untouched", async () => {
    const rows = await db
      .insert(tenantsTable)
      .values([
        { brandName: `StaleGuard ${RUN}`, subdomain: staleSubdomain, status: "active" },
        { brandName: `Real Guard ${RUN}`, subdomain: realSubdomain, status: "active" },
      ])
      .returning({ id: tenantsTable.id, subdomain: tenantsTable.subdomain });
    createdIds.push(...rows.map((r) => r.id));
    const staleId = rows.find((r) => r.subdomain === staleSubdomain)!.id;
    const realId = rows.find((r) => r.subdomain === realSubdomain)!.id;

    const swept = await sweepStaleTestTenants();
    expect(swept.map((t) => t.id)).toContain(staleId);
    expect(swept.map((t) => t.id)).not.toContain(realId);

    const remaining = await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(inArray(tenantsTable.id, [staleId, realId]));
    expect(remaining.map((r) => r.id)).toEqual([realId]);
  });
});
