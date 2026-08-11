import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  modulesTable,
  tenantModulesTable,
  agencySettingsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { seedConnectorMapping, CONNECTOR_MAPPING } from "../../lib/connectorSeed";

// ---------------------------------------------------------------------------
// Integration tests: per-module markup overrides against the REAL dev DB.
//
// Contract (Task: partner-direct at cost, resale engines at 25%):
//   - modules with markupPercentOverride "0" resell at wholesale everywhere
//   - modules with override "25" use 25% regardless of the agency setting
//   - modules without an override keep following the agency-wide markup
//   - connector seed applies the overrides idempotently (no duplicate rows)
//
// Isolation: throwaway tenant + modules with unique per-run names; afterAll
// deletes them. Agency settings are only read, never mutated.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;

const RUN = `pmm-${Date.now()}-${process.pid}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

let app: import("express").Express;

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}
let agencyMarkup: number;

const seededTenantIds: number[] = [];
const seededModuleIds: number[] = [];

let zeroMod: { id: number; name: string }; // override 0% — pass-through
let resaleMod: { id: number; name: string }; // override 25%
let plainMod: { id: number; name: string }; // no override — agency markup

beforeAll(async () => {
  app = (await import("../../app")).default;

  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  agencyMarkup = parseFloat(settings?.markupPercent ?? "25");

  const mods = await db
    .insert(modulesTable)
    .values([
      {
        name: `ZeroMarkup ${RUN}`,
        category: "Test",
        categorySlug: "test",
        description: "partner-direct style pass-through module",
        wholesalePrice: "120.00",
        markupPercentOverride: "0",
        slug: `zero-${RUN}`,
      },
      {
        name: `ResaleEngine ${RUN}`,
        category: "Test",
        categorySlug: "test",
        description: "resale engine style module",
        wholesalePrice: "80.00",
        markupPercentOverride: "25",
        slug: `resale-${RUN}`,
      },
      {
        name: `PlainMod ${RUN}`,
        category: "Test",
        categorySlug: "test",
        description: "module with no override",
        wholesalePrice: "60.00",
        slug: `plain-${RUN}`,
      },
    ])
    .returning({ id: modulesTable.id, name: modulesTable.name });
  [zeroMod, resaleMod, plainMod] = mods;
  seededModuleIds.push(...mods.map((m) => m.id));
});

afterAll(async () => {
  if (seededTenantIds.length > 0)
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, seededTenantIds));
  if (seededModuleIds.length > 0)
    await db.delete(modulesTable).where(inArray(modulesTable.id, seededModuleIds));
});

describe("GET /api/modules/pricing honors per-module markup overrides", () => {
  it("prices 0%-override at wholesale, 25%-override at 1.25x, no-override at agency markup", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/modules/pricing");
    expect(res.status).toBe(200);
    const byId = new Map<number, any>(res.body.map((r: any) => [r.id, r]));

    const zero = byId.get(zeroMod.id);
    expect(zero.markupPercent).toBe(0);
    expect(zero.resalePrice).toBe(120);
    expect(zero.margin).toBe(0);

    const resale = byId.get(resaleMod.id);
    expect(resale.markupPercent).toBe(25);
    expect(resale.resalePrice).toBe(100);
    expect(resale.margin).toBe(20);

    const plain = byId.get(plainMod.id);
    expect(plain.markupPercent).toBe(agencyMarkup);
    expect(plain.resalePrice).toBe(round2(60 * (1 + agencyMarkup / 100)));
  });
});

describe("POST /api/billing/checkout charges the effective markup", () => {
  it("persists charged_wholesale/charged_resale per the module override", async () => {
    const [tenant] = await db
      .insert(tenantsTable)
      .values({
        brandName: `PMM Tenant ${RUN}`,
        subdomain: `pmm-${RUN}`,
        status: "active",
        mrr: "0",
      })
      .returning({ id: tenantsTable.id });
    seededTenantIds.push(tenant.id);

    const agent = await loggedInAgent();
    const res = await agent
      .post("/api/billing/checkout")
      .send({ tenantId: tenant.id, moduleIds: [zeroMod.id, resaleMod.id, plainMod.id] });
    expect(res.status).toBe(200);

    const expectedResale = round2(120 + 100 + 60 * (1 + agencyMarkup / 100));
    expect(res.body.totalWholesale).toBe(260);
    expect(res.body.totalResale).toBe(expectedResale);
    expect(res.body.margin).toBe(round2(expectedResale - 260));

    const rows = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.tenantId, tenant.id));
    const byModule = new Map(rows.map((r) => [r.moduleId, r]));

    expect(parseFloat(byModule.get(zeroMod.id)!.chargedWholesale!)).toBe(120);
    expect(parseFloat(byModule.get(zeroMod.id)!.chargedResale!)).toBe(120);
    expect(parseFloat(byModule.get(resaleMod.id)!.chargedResale!)).toBe(100);
    expect(parseFloat(byModule.get(plainMod.id)!.chargedResale!)).toBe(
      round2(60 * (1 + agencyMarkup / 100))
    );
  });
});

describe("connector seed applies markup overrides idempotently", () => {
  const PARTNER_DIRECT = ["simply_insured", "gusto", "quickbooks"];
  const RESALE_ENGINES = [
    "qujam",
    "vibe_co",
    "adroll",
    "audiogo",
    "wondercraft_ai",
    "creatify_ai",
    "metricool",
  ];

  it("mapping declares 0% for the three partner-direct modules and 25% for the seven resale engines", () => {
    for (const slug of PARTNER_DIRECT) {
      const entry = CONNECTOR_MAPPING.find((e) => e.slug === slug);
      expect(entry, slug).toBeDefined();
      expect(entry!.markupPercentOverride, slug).toBe("0");
    }
    for (const slug of RESALE_ENGINES) {
      const entry = CONNECTOR_MAPPING.find((e) => e.slug === slug);
      expect(entry, slug).toBeDefined();
      expect(entry!.markupPercentOverride, slug).toBe("25");
    }
  });

  it("re-running the seed keeps overrides applied without duplicating rows", async () => {
    const mappedSlugs = CONNECTOR_MAPPING.map((e) => e.slug);
    await seedConnectorMapping();
    await seedConnectorMapping();
    const all = await db
      .select()
      .from(modulesTable)
      .where(inArray(modulesTable.slug, mappedSlugs));

    // Exactly one row per mapped slug — reseeding never duplicates.
    for (const slug of mappedSlugs) {
      expect(all.filter((m) => m.slug === slug).length, slug).toBe(1);
    }
    for (const slug of PARTNER_DIRECT) {
      const row = all.find((m) => m.slug === slug)!;
      expect(parseFloat(row.markupPercentOverride!), slug).toBe(0);
    }
    for (const slug of RESALE_ENGINES) {
      const row = all.find((m) => m.slug === slug)!;
      expect(parseFloat(row.markupPercentOverride!), slug).toBe(25);
    }

    // API spot-check: a partner-direct module resells at wholesale.
    const agent = await loggedInAgent();
    const simplyInsured = all.find((m) => m.slug === "simply_insured")!;
    const res = await agent.get("/api/modules/pricing");
    const priced = res.body.find((r: any) => r.id === simplyInsured.id);
    expect(priced.resalePrice).toBe(priced.wholesalePrice);
    expect(priced.markupPercent).toBe(0);
  });
});
