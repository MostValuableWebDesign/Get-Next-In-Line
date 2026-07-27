import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, sosSettingsTable } from "@workspace/db";
import { inArray, eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for the automatic co-op radius: suburban defaults on
// settings-row creation, merchant radius override persistence + revert, manual
// coordinate precedence, and radius-based directory filtering/sorting.
//
// Detection never hits real external services here: NODE_ENV=test disables
// the fire-and-forget trigger, so persisted values are fully deterministic.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `cooprad-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
// me: Manhattan; near: ~1.2 mi away; far: Philadelphia (~80 mi); nocoords.
let me: number;
let near: number;
let far: number;
let nocoords: number;

async function setCoords(tenantId: number, lat: string, lng: string) {
  await db
    .update(sosSettingsTable)
    .set({ latitude: lat, longitude: lng, coordinatesSource: "manual" })
    .where(eq(sosSettingsTable.tenantId, tenantId));
}

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Radius Me ${RUN}`, subdomain: `${RUN}-me`, status: "active" },
      { brandName: `Radius Near ${RUN}`, subdomain: `${RUN}-near`, status: "active" },
      { brandName: `Radius Far ${RUN}`, subdomain: `${RUN}-far`, status: "active" },
      { brandName: `Radius NoCoords ${RUN}`, subdomain: `${RUN}-nc`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [me, near, far, nocoords] = tenants.map((t) => t.id);

  // Materialize settings rows (auto-created on first access).
  for (const id of [me, near, far, nocoords]) {
    await agent.get(`/api/tenants/${id}/settings`).expect(200);
  }
  await setCoords(me, "40.712800", "-74.006000"); // lower Manhattan
  await setCoords(near, "40.730000", "-74.000000"); // ~1.2 mi north
  await setCoords(far, "41.050000", "-73.700000"); // White Plains (~28 mi)
});

afterAll(async () => {
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [me, near, far, nocoords]));
});

describe("radius defaults & override", () => {
  it("assigns the Suburban default automatically at settings creation", async () => {
    const res = await agent.get(`/api/tenants/${nocoords}/settings`).expect(200);
    expect(res.body.densityClassification).toBe("suburban");
    expect(res.body.coopRadiusAutoMiles).toBe(4);
    expect(res.body.coopRadiusOverrideMiles).toBeNull();
    expect(res.body.coopRadiusEffectiveMiles).toBe(4);
  });

  it("persists a merchant override and it wins as the effective radius", async () => {
    const res = await agent
      .patch(`/api/tenants/${me}/settings`)
      .send({ coopRadiusOverrideMiles: 2.5 })
      .expect(200);
    expect(res.body.coopRadiusOverrideMiles).toBe(2.5);
    expect(res.body.coopRadiusEffectiveMiles).toBe(2.5);
    // Survives an unrelated settings save.
    const after = await agent
      .patch(`/api/tenants/${me}/settings`)
      .send({ businessName: `Radius Me ${RUN}` })
      .expect(200);
    expect(after.body.coopRadiusOverrideMiles).toBe(2.5);
  });

  it("reverts to automatic when the override is cleared with null", async () => {
    const res = await agent
      .patch(`/api/tenants/${me}/settings`)
      .send({ coopRadiusOverrideMiles: null })
      .expect(200);
    expect(res.body.coopRadiusOverrideMiles).toBeNull();
    expect(res.body.coopRadiusEffectiveMiles).toBe(res.body.coopRadiusAutoMiles);
  });

  it("marks typed coordinates as manual so auto-detection never clobbers them", async () => {
    await agent
      .patch(`/api/tenants/${me}/settings`)
      .send({ latitude: "40.712800", longitude: "-74.006000" })
      .expect(200);
    const [row] = await db
      .select({ coordinatesSource: sosSettingsTable.coordinatesSource })
      .from(sosSettingsTable)
      .where(eq(sosSettingsTable.tenantId, me));
    expect(row.coordinatesSource).toBe("manual");
  });
});

describe("directory radius filtering", () => {
  const inDirectory = async () => {
    const res = await agent
      .get("/api/coop/directory")
      .set("x-tenant-id", String(me))
      .expect(200);
    return res.body as Array<{ id: number; distanceMiles: number | null }>;
  };

  it("includes nearby businesses with distance, excludes ones beyond the radius", async () => {
    // Override to 5 miles: near (~1.2mi) in, far (~28mi) out.
    await agent
      .patch(`/api/tenants/${me}/settings`)
      .send({ coopRadiusOverrideMiles: 5 })
      .expect(200);
    const entries = await inDirectory();
    const ids = entries.map((e) => e.id);
    expect(ids).toContain(near);
    expect(ids).not.toContain(far);
    const nearEntry = entries.find((e) => e.id === near)!;
    expect(nearEntry.distanceMiles).toBeGreaterThan(0.5);
    expect(nearEntry.distanceMiles).toBeLessThan(3);
  });

  it("keeps coordinate-less businesses listed (graceful degradation)", async () => {
    const entries = await inDirectory();
    const nc = entries.find((e) => e.id === nocoords);
    expect(nc).toBeDefined();
    expect(nc!.distanceMiles).toBeNull();
  });

  it("sorts nearest-first with coordinate-less entries after", async () => {
    // Widen the radius so both coordinate businesses appear.
    await agent
      .patch(`/api/tenants/${me}/settings`)
      .send({ coopRadiusOverrideMiles: 50 })
      .expect(200);
    const wide = (await inDirectory()).filter((e) => [near, far, nocoords].includes(e.id));
    expect(wide.map((e) => e.id)).toEqual([near, far, nocoords]);
  });
});
