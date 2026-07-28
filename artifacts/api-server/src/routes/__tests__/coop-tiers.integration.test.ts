import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  coopAttributionEventsTable,
  coopPerkRedemptionsTable,
  coopTierEventsTable,
  messagesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  desiredTierState,
  evaluateCoopPartnershipTiers,
  DEFAULT_RECIPROCITY_THRESHOLD,
  TIER_WINDOW_DAYS,
} from "../../lib/coopTiers";

// ---------------------------------------------------------------------------
// Performance-based partnership tiers against the real dev DB. Covers:
// rolling 30-day threshold math, pause on zero traffic, downgrade below
// threshold, promotion to premier, auto-reactivation when traffic resumes,
// idempotent re-runs (single audit row / notification per transition),
// perk-surface gating while paused, own-side reciprocity rule editing, and
// the mutual-agreement reactivation route.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `cooptier-${Date.now()}-${process.pid}`;
const DAY_MS = 24 * 60 * 60 * 1000;

let agent: ReturnType<typeof request.agent>;
let hostId: number;
let partnerId: number;

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
      { brandName: `Tier Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Tier Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [hostId, partnerId] = tenants.map((t) => t.id);
});

afterAll(async () => {
  const ids = [hostId, partnerId].filter((n) => Number.isInteger(n));
  if (ids.length) {
    await db.delete(messagesTable).where(inArray(messagesTable.tenantId, ids));
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

/** Create an accepted partnership backdated past the grace window. */
async function createBackdatedPartnership(suffix: string) {
  const created = await agent
    .post("/api/coop/partnerships")
    .send({ hostTenantId: hostId, partnerTenantId: partnerId, perkTitle: `Tier perk ${RUN}-${suffix}` })
    .expect(201);
  const id: number = created.body.id;
  await db
    .update(merchantCoopPartnershipsTable)
    .set({ createdAt: new Date(Date.now() - (TIER_WINDOW_DAYS + 5) * DAY_MS) })
    .where(eq(merchantCoopPartnershipsTable.id, id));
  return id;
}

/** Insert `n` attribution events for a partnership in the given direction. */
async function addTraffic(
  partnershipId: number,
  direction: "host_to_partner" | "partner_to_host",
  n: number,
  daysAgo = 1
) {
  for (let i = 0; i < n; i++) {
    const [redemption] = await db
      .insert(coopPerkRedemptionsTable)
      .values({
        partnershipId,
        passCode: `${RUN}-${direction}-${daysAgo}-${i}-${Math.random().toString(36).slice(2)}`,
        redeemedByTenantId: direction === "host_to_partner" ? partnerId : hostId,
      })
      .returning({ id: coopPerkRedemptionsTable.id });
    await db.insert(coopAttributionEventsTable).values({
      redemptionId: redemption.id,
      partnershipId,
      direction,
      sendingTenantId: direction === "host_to_partner" ? hostId : partnerId,
      receivingTenantId: direction === "host_to_partner" ? partnerId : hostId,
      occurredAt: new Date(Date.now() - daysAgo * DAY_MS),
    });
  }
}

const rowFor = async (id: number) => {
  const [row] = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.id, id));
  return row;
};

const tierEventsFor = (id: number) =>
  db.select().from(coopTierEventsTable).where(eq(coopTierEventsTable.partnershipId, id));

describe("threshold math (desiredTierState)", () => {
  const noRules = { hostReciprocityThreshold: null, partnerReciprocityThreshold: null };

  it("zero traffic in both directions pauses", () => {
    expect(desiredTierState(noRules, { hostToPartner: 0, partnerToHost: 0 })).toEqual({
      paused: true,
      tier: "standard",
    });
  });

  it("defaults apply when no thresholds are set", () => {
    expect(DEFAULT_RECIPROCITY_THRESHOLD).toBe(5);
    expect(
      desiredTierState(noRules, { hostToPartner: 5, partnerToHost: 5 })
    ).toEqual({ paused: false, tier: "premier" });
    expect(
      desiredTierState(noRules, { hostToPartner: 5, partnerToHost: 4 })
    ).toEqual({ paused: false, tier: "standard" });
  });

  it("each side's own threshold applies to the OTHER side's traffic", () => {
    const rules = { hostReciprocityThreshold: 2, partnerReciprocityThreshold: 10 };
    // partner→host meets the host's demand (2), host→partner meets the partner's (10).
    expect(desiredTierState(rules, { hostToPartner: 10, partnerToHost: 2 })).toEqual({
      paused: false,
      tier: "premier",
    });
    expect(desiredTierState(rules, { hostToPartner: 9, partnerToHost: 2 })).toEqual({
      paused: false,
      tier: "standard",
    });
  });
});

describe("scheduled evaluator transitions", () => {
  it("pauses a zero-traffic partnership, audits why, notifies both parties — idempotently", async () => {
    const id = await createBackdatedPartnership("pause");

    await evaluateCoopPartnershipTiers();
    let row = await rowFor(id);
    expect(row.performancePausedAt).not.toBeNull();

    const events = await tierEventsFor(id);
    expect(events).toHaveLength(1);
    expect(events[0].newState).toBe("paused");
    expect(events[0].reason).toContain("no cross-promoted customers");

    const notifications = await db
      .select()
      .from(messagesTable)
      .where(
        and(eq(messagesTable.kind, "coop_tier_change"), inArray(messagesTable.tenantId, [hostId, partnerId]))
      );
    expect(notifications).toHaveLength(2);

    // Re-run: no new audit rows, no new notifications.
    await evaluateCoopPartnershipTiers();
    expect(await tierEventsFor(id)).toHaveLength(1);

    row = await rowFor(id);
    // Paused perk is gated off the customer perk surface for both tenants…
    for (const tid of [hostId, partnerId]) {
      const perks = await agent.get("/api/coop/perks").set("x-tenant-id", String(tid)).expect(200);
      expect(perks.body.perks.map((p: { id: number }) => p.id)).not.toContain(id);
    }
    // …and off the public landing perks surface.
    const [tenant] = await db
      .select({ subdomain: tenantsTable.subdomain })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, hostId));
    const landing = await request((await import("../../app")).default)
      .get(`/api/public/landing/${tenant.subdomain}/perks`)
      .expect(200);
    expect(landing.body.perks).toHaveLength(0);

    // …but the redemption code still validates so traffic CAN resume.
    const validate = await agent
      .get(`/api/coop/redemptions/${row.redemptionCode}`)
      .set("x-tenant-id", String(hostId))
      .expect(200);
    expect(validate.body.valid).toBe(true);

    await db.delete(merchantCoopPartnershipsTable).where(eq(merchantCoopPartnershipsTable.id, id));
  });

  it("auto-reactivates a paused partnership when traffic resumes", async () => {
    const id = await createBackdatedPartnership("resume");
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ performancePausedAt: new Date(Date.now() - 2 * DAY_MS) })
      .where(eq(merchantCoopPartnershipsTable.id, id));

    await addTraffic(id, "partner_to_host", 1);
    await evaluateCoopPartnershipTiers();

    const row = await rowFor(id);
    expect(row.performancePausedAt).toBeNull();
    expect(row.tier).toBe("standard");
    const events = await tierEventsFor(id);
    expect(events).toHaveLength(1);
    expect(events[0].previousState).toBe("paused");
    expect(events[0].reason).toContain("traffic resumed");

    await db.delete(merchantCoopPartnershipsTable).where(eq(merchantCoopPartnershipsTable.id, id));
  });

  it("promotes to premier when both directions meet thresholds, and downgrades when they stop", async () => {
    const id = await createBackdatedPartnership("promote");
    // Custom rules: host demands 2 partner→host, partner demands 3 host→partner.
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ hostReciprocityThreshold: 2, partnerReciprocityThreshold: 3 })
      .where(eq(merchantCoopPartnershipsTable.id, id));

    // Recent traffic meets both rules → premier.
    await addTraffic(id, "partner_to_host", 2, 1);
    await addTraffic(id, "host_to_partner", 3, 1);
    await evaluateCoopPartnershipTiers();
    let row = await rowFor(id);
    expect(row.tier).toBe("premier");
    expect(row.performancePausedAt).toBeNull();

    // Idempotent: unchanged traffic re-run writes nothing new.
    await evaluateCoopPartnershipTiers();
    expect(await tierEventsFor(id)).toHaveLength(1);

    // Window rolls: the same events evaluated 40 days later fall out of the
    // window; simulate by evaluating "now + 40 days".
    const future = new Date(Date.now() + 40 * DAY_MS);
    await evaluateCoopPartnershipTiers(future, { partnershipIds: [id] });
    row = await rowFor(id);
    expect(row.performancePausedAt).not.toBeNull(); // zero traffic in the shifted window

    const events = await tierEventsFor(id);
    expect(events.map((e) => e.newState)).toEqual(["premier", "paused"]);
    expect(events[0].hostToPartnerCount).toBe(3);
    expect(events[0].partnerToHostCount).toBe(2);

    await db.delete(merchantCoopPartnershipsTable).where(eq(merchantCoopPartnershipsTable.id, id));
  });

  it("downgrades premier→standard when traffic drops below threshold (but not to zero)", async () => {
    const id = await createBackdatedPartnership("downgrade");
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ tier: "premier", hostReciprocityThreshold: 3, partnerReciprocityThreshold: 1 })
      .where(eq(merchantCoopPartnershipsTable.id, id));
    // Only 1 partner→host customer — below the host's demand of 3.
    await addTraffic(id, "partner_to_host", 1);
    await addTraffic(id, "host_to_partner", 1);

    await evaluateCoopPartnershipTiers();
    const row = await rowFor(id);
    expect(row.tier).toBe("standard");
    expect(row.performancePausedAt).toBeNull();
    const events = await tierEventsFor(id);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toContain("below the reciprocity threshold");

    await db.delete(merchantCoopPartnershipsTable).where(eq(merchantCoopPartnershipsTable.id, id));
  });

  it("never touches partnerships younger than the grace window", async () => {
    const created = await agent
      .post("/api/coop/partnerships")
      .send({ hostTenantId: hostId, partnerTenantId: partnerId, perkTitle: `Tier perk ${RUN}-young` })
      .expect(201);
    const id: number = created.body.id;

    await evaluateCoopPartnershipTiers();
    const row = await rowFor(id);
    expect(row.performancePausedAt).toBeNull();
    expect(await tierEventsFor(id)).toHaveLength(0);

    await db.delete(merchantCoopPartnershipsTable).where(eq(merchantCoopPartnershipsTable.id, id));
  });
});

describe("reciprocity rule editing", () => {
  it("each side edits only its own threshold", async () => {
    const created = await agent
      .post("/api/coop/partnerships")
      .send({ hostTenantId: hostId, partnerTenantId: partnerId, perkTitle: `Tier perk ${RUN}-rules` })
      .expect(201);
    const id: number = created.body.id;

    const ok = await agent
      .patch(`/api/coop/partnerships/${id}`)
      .set("x-tenant-id", String(hostId))
      .send({ hostReciprocityThreshold: 7 })
      .expect(200);
    expect(ok.body.hostReciprocityThreshold).toBe(7);
    expect(ok.body.tier).toBe("standard");

    // Host cannot set the partner's rule, and vice versa.
    await agent
      .patch(`/api/coop/partnerships/${id}`)
      .set("x-tenant-id", String(hostId))
      .send({ partnerReciprocityThreshold: 9 })
      .expect(403);
    await agent
      .patch(`/api/coop/partnerships/${id}`)
      .set("x-tenant-id", String(partnerId))
      .send({ hostReciprocityThreshold: 9 })
      .expect(403);

    // Partner sets its own; null restores the default.
    await agent
      .patch(`/api/coop/partnerships/${id}`)
      .set("x-tenant-id", String(partnerId))
      .send({ partnerReciprocityThreshold: 12 })
      .expect(200);
    const cleared = await agent
      .patch(`/api/coop/partnerships/${id}`)
      .set("x-tenant-id", String(hostId))
      .send({ hostReciprocityThreshold: null })
      .expect(200);
    expect(cleared.body.hostReciprocityThreshold).toBeNull();
    expect(cleared.body.partnerReciprocityThreshold).toBe(12);

    await db.delete(merchantCoopPartnershipsTable).where(eq(merchantCoopPartnershipsTable.id, id));
  });
});

describe("mutual-agreement reactivation", () => {
  it("first request records, the other side's request lifts the pause", async () => {
    const id = await createBackdatedPartnership("mutual");
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ performancePausedAt: new Date() })
      .where(eq(merchantCoopPartnershipsTable.id, id));

    // Non-participant cannot touch it.
    await agent
      .post(`/api/coop/partnerships/${id}/reactivate`)
      .set("x-tenant-id", "999999")
      .expect(403);

    const first = await agent
      .post(`/api/coop/partnerships/${id}/reactivate`)
      .set("x-tenant-id", String(hostId))
      .expect(200);
    expect(first.body.performancePausedAt).not.toBeNull();
    expect(first.body.reactivationRequestedByTenantId).toBe(hostId);

    // Same side again: still waiting.
    const again = await agent
      .post(`/api/coop/partnerships/${id}/reactivate`)
      .set("x-tenant-id", String(hostId))
      .expect(200);
    expect(again.body.performancePausedAt).not.toBeNull();

    const second = await agent
      .post(`/api/coop/partnerships/${id}/reactivate`)
      .set("x-tenant-id", String(partnerId))
      .expect(200);
    expect(second.body.performancePausedAt).toBeNull();
    expect(second.body.reactivationRequestedByTenantId).toBeNull();
    expect(second.body.tier).toBe("standard");

    const events = await tierEventsFor(id);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toContain("mutual agreement");

    // Reactivating a non-paused partnership conflicts.
    await agent
      .post(`/api/coop/partnerships/${id}/reactivate`)
      .set("x-tenant-id", String(hostId))
      .expect(409);

    await db.delete(merchantCoopPartnershipsTable).where(eq(merchantCoopPartnershipsTable.id, id));
  });
});
