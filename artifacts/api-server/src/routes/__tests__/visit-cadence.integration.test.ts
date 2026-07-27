import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  clientProfilesTable,
  sosCustomersTable,
  sosVisitsTable,
  sosSettingsTable,
  engagementRulesTable,
  messagesTable,
} from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import { handleRebookingNudge } from "../../workers/concierge";
import { backfillVisitCadence } from "../../lib/visitCadence";

// ---------------------------------------------------------------------------
// Integration tests for automatic visit-cadence detection:
//  - checkout recomputes the linked profile's lastVisitAt + averageCycleDays
//  - manual overrides are never clobbered by the computation
//  - the rebooking scan falls back to the tenant default cycle for clients
//    with too little history (lapsed → nudged, fresh → not)
//  - the startup backfill fills cadence from pre-existing history
//  - PATCHing averageCycleDays by hand sets/clears the override flag
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `cadence-${Date.now()}-${process.pid}`;
const PHONE_PREFIX = "+1555941";
const SERVICE = `cadence-svc-${RUN}`;

const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000);

let agent: ReturnType<typeof request.agent>;
let tenantId: number;

async function makeProfile(values: Partial<typeof clientProfilesTable.$inferInsert> & { name: string; phone: string }) {
  const [p] = await db
    .insert(clientProfilesTable)
    .values({ tenantId, ...values })
    .returning();
  return p;
}

async function makeCustomerWithVisits(
  name: string,
  phone: string,
  clientProfileId: number | null,
  checkoutDates: Date[],
) {
  const [customer] = await db
    .insert(sosCustomersTable)
    .values({ tenantId, name, phone, clientProfileId })
    .returning();
  for (const d of checkoutDates) {
    await db.insert(sosVisitsTable).values({
      tenantId,
      customerId: customer.id,
      serviceType: SERVICE,
      status: "checked_out",
      checkedInAt: d,
      checkedOutAt: d,
    });
  }
  return customer;
}

async function checkoutNewVisit(customerId: number) {
  const [visit] = await db
    .insert(sosVisitsTable)
    .values({
      tenantId,
      customerId,
      serviceType: SERVICE,
      status: "in_service",
      checkedInAt: new Date(),
      serviceStartedAt: new Date(),
    })
    .returning();
  await agent
    .post(`/api/sos/visits/${visit.id}/advance`)
    .set("x-tenant-id", String(tenantId))
    .send({ action: "check_out" })
    .expect(200);
}

const getProfile = async (id: number) =>
  (await db.select().from(clientProfilesTable).where(eq(clientProfilesTable.id, id)))[0];

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `Cadence ${RUN}`, subdomain: RUN, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;

  // Tenant settings with a short default cycle for the fallback assertions.
  await db.insert(sosSettingsTable).values({ tenantId, defaultCycleDays: 20 });
});

afterAll(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId)); // cascades
  await db.delete(messagesTable).where(like(messagesTable.toNumber, `${PHONE_PREFIX}%`));
});

describe("cadence computation on visit checkout", () => {
  it("updates lastVisitAt and computes averageCycleDays from real history", async () => {
    const profile = await makeProfile({ name: "Cadence Carla", phone: `${PHONE_PREFIX}0001` });
    const customer = await makeCustomerWithVisits(
      "Cadence Carla",
      `${PHONE_PREFIX}0001`,
      profile.id,
      [daysAgo(40), daysAgo(20)],
    );

    await checkoutNewVisit(customer.id);

    const updated = await getProfile(profile.id);
    // 3 completed visits spanning ~40 days → ~20-day average cycle.
    expect(updated.averageCycleDays).toBe(20);
    expect(updated.cycleOverride).toBe(false);
    expect(updated.lastVisitAt).not.toBeNull();
    expect(NOW - updated.lastVisitAt!.getTime()).toBeLessThan(60_000 * 5);
  });

  it("leaves averageCycleDays alone with too little history, but still stamps lastVisitAt", async () => {
    const profile = await makeProfile({ name: "Fresh Fiona", phone: `${PHONE_PREFIX}0002` });
    const customer = await makeCustomerWithVisits(
      "Fresh Fiona",
      `${PHONE_PREFIX}0002`,
      profile.id,
      [],
    );

    await checkoutNewVisit(customer.id);

    const updated = await getProfile(profile.id);
    expect(updated.averageCycleDays).toBeNull();
    expect(updated.lastVisitAt).not.toBeNull();
  });

  it("never clobbers a manually overridden cycle", async () => {
    const profile = await makeProfile({
      name: "Override Olga",
      phone: `${PHONE_PREFIX}0003`,
      averageCycleDays: 99,
      cycleOverride: true,
    });
    const customer = await makeCustomerWithVisits(
      "Override Olga",
      `${PHONE_PREFIX}0003`,
      profile.id,
      [daysAgo(40), daysAgo(20)],
    );

    await checkoutNewVisit(customer.id);

    const updated = await getProfile(profile.id);
    expect(updated.averageCycleDays).toBe(99);
    expect(updated.cycleOverride).toBe(true);
    expect(updated.lastVisitAt).not.toBeNull();
  });
});

describe("rebooking scan default-cycle fallback", () => {
  it("nudges a lapsed no-history client via the tenant default and skips a fresh one", async () => {
    const lapsed = await makeProfile({
      name: "Lapsed Larry",
      phone: `${PHONE_PREFIX}0004`,
      lastVisitAt: daysAgo(30), // past the 20-day tenant default
    });
    const fresh = await makeProfile({
      name: "Fresh Frank",
      phone: `${PHONE_PREFIX}0005`,
      lastVisitAt: daysAgo(5), // well inside the default cycle
    });
    await db.insert(engagementRulesTable).values({
      tenantId,
      ruleType: "rebooking_nudge",
      isActive: true,
      config: { cooldownDays: 7, template: "{{name}}, it has been {{days}} days!" },
    });

    await handleRebookingNudge(new Date(NOW));

    const nudges = async (profileId: number) =>
      db
        .select()
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.clientProfileId, profileId),
            eq(messagesTable.kind, "rebooking_nudge"),
          ),
        );

    const lapsedLogs = await nudges(lapsed.id);
    expect(lapsedLogs).toHaveLength(1);
    expect(lapsedLogs[0].status).toBe("simulated");
    expect(await nudges(fresh.id)).toHaveLength(0);
  });
});

describe("startup backfill", () => {
  it("fills cadence for profiles with pre-existing visit history", async () => {
    const profile = await makeProfile({ name: "Backfill Bea", phone: `${PHONE_PREFIX}0006` });
    await makeCustomerWithVisits("Backfill Bea", `${PHONE_PREFIX}0006`, profile.id, [
      daysAgo(60),
      daysAgo(35),
      daysAgo(10),
    ]);

    await backfillVisitCadence();

    const updated = await getProfile(profile.id);
    expect(updated.averageCycleDays).toBe(25); // 50-day span / 2 gaps
    expect(updated.lastVisitAt?.getTime()).toBe(daysAgo(10).getTime());
  });
});

describe("manual override via API", () => {
  it("PATCHing a cycle sets the override flag; clearing it hands control back", async () => {
    const profile = await makeProfile({ name: "Manual Mel", phone: `${PHONE_PREFIX}0007` });

    await agent
      .patch(`/api/tenants/${tenantId}/client-profiles/${profile.id}`)
      .send({ averageCycleDays: 45 })
      .expect(200);
    let updated = await getProfile(profile.id);
    expect(updated.averageCycleDays).toBe(45);
    expect(updated.cycleOverride).toBe(true);

    await agent
      .patch(`/api/tenants/${tenantId}/client-profiles/${profile.id}`)
      .send({ averageCycleDays: null })
      .expect(200);
    updated = await getProfile(profile.id);
    expect(updated.averageCycleDays).toBeNull();
    expect(updated.cycleOverride).toBe(false);
  });
});
