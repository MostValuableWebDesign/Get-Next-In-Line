import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  sosCustomersTable,
  sosAppointmentsTable,
  messagesTable,
  coopSuggestionsTable,
  coopSuggestionDismissalsTable,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-Op Matchmaking & Smart Recommendations (/coop/suggestions) against the
// real dev DB. Covers: scoring & ranking (complementarity, proximity,
// activity), exclusion rules (self, same-sub-category competitors,
// existing/pending partnerships, dismissals), auto-population when profile
// fields change, auto-generated proposal terms, invite delivery (in-app
// pending invite + SMS through the unified pipeline with simulated fallback),
// and the one-tap Accept & Launch path activating perks on both sides.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `coopmatch-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let barberId: number; // viewer — curated "barbershop"
let boutiqueId: number; // complementary + high activity
let coffeeId: number; // complementary, no activity
let rivalBarberId: number; // same sub-category — never suggested

const allIds = () => [barberId, boutiqueId, coffeeId, rivalBarberId];

type Suggestion = {
  tenantId: number;
  name: string;
  category: string | null;
  city: string | null;
  distanceMiles: number | null;
  score: number;
  reasons: string[];
  proposal: { perkTitle: string; perkDescription: string; mutualRewardTerms: string };
};

const mine = (arr: Suggestion[]) => arr.filter((s) => allIds().includes(s.tenantId));

const feedFor = async (tenantId: number): Promise<Suggestion[]> => {
  const res = await agent
    .get("/api/coop/suggestions")
    .set("x-tenant-id", String(tenantId))
    .expect(200);
  return mine(res.body);
};

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
      { brandName: `Match Barber ${RUN}`, subdomain: `${RUN}-barber`, status: "active" },
      { brandName: `Match Boutique ${RUN}`, subdomain: `${RUN}-boutique`, status: "active" },
      { brandName: `Match Coffee ${RUN}`, subdomain: `${RUN}-coffee`, status: "active" },
      { brandName: `Match Rival ${RUN}`, subdomain: `${RUN}-rival`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [barberId, boutiqueId, coffeeId, rivalBarberId] = tenants.map((t) => t.id);

  // All within ~1 mile; curated taxonomy slugs drive complementarity.
  await db.insert(sosSettingsTable).values([
    {
      tenantId: barberId,
      coopSubCategory: "barbershop",
      businessCategory: `Barber-${RUN}`,
      addressLocality: "Riverside",
      latitude: "40.7128",
      longitude: "-74.0060",
    },
    {
      tenantId: boutiqueId,
      coopSubCategory: "boutique",
      businessCategory: `Boutique-${RUN}`,
      addressLocality: "Riverside",
      latitude: "40.7135",
      longitude: "-74.0055",
      publicPhone: "+15550001111",
    },
    {
      tenantId: coffeeId,
      coopSubCategory: "coffee-shop",
      businessCategory: `Coffee-${RUN}`,
      addressLocality: "Riverside",
      latitude: "40.7130",
      longitude: "-74.0050",
    },
    {
      tenantId: rivalBarberId,
      coopSubCategory: "barbershop",
      businessCategory: `Barber-${RUN}`,
      addressLocality: "Riverside",
      latitude: "40.7126",
      longitude: "-74.0062",
    },
  ]);

  // Activity signal: the boutique has an established customer base.
  const customers = await db
    .insert(sosCustomersTable)
    .values(
      Array.from({ length: 5 }, (_, i) => ({
        tenantId: boutiqueId,
        name: `Match Customer ${i} ${RUN}`,
        phone: `+1555100${1000 + i}`,
      }))
    )
    .returning({ id: sosCustomersTable.id });
  await db.insert(sosAppointmentsTable).values(
    customers.slice(0, 3).map((c) => ({
      tenantId: boutiqueId,
      customerId: c.id,
      serviceType: `Fitting-${RUN}`,
      startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 25 * 60 * 60 * 1000),
    }))
  );
});

afterAll(async () => {
  const ids = allIds().filter((n) => Number.isInteger(n));
  if (ids.length) {
    await db.delete(messagesTable).where(inArray(messagesTable.tenantId, ids));
    // Cascades clean up settings, customers, appointments, partnerships,
    // suggestions, and dismissals.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

describe("suggestions feed — scoring & exclusions", () => {
  it("requires the x-tenant-id scope", async () => {
    await agent.get("/api/coop/suggestions").expect(400);
  });

  it("suggests complementary businesses, ranked, and never same-sub-category competitors or self", async () => {
    const feed = await feedFor(barberId);
    const ids = feed.map((s) => s.tenantId);
    expect(ids).toContain(boutiqueId);
    expect(ids).toContain(coffeeId);
    expect(ids).not.toContain(rivalBarberId);
    expect(ids).not.toContain(barberId);

    // Ranked by score descending; the boutique's activity signal outranks
    // the equally complementary but inactive coffee shop.
    const scores = feed.map((s) => s.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    const boutique = feed.find((s) => s.tenantId === boutiqueId)!;
    const coffee = feed.find((s) => s.tenantId === coffeeId)!;
    expect(boutique.score).toBeGreaterThan(coffee.score);
    expect(ids.indexOf(boutiqueId)).toBeLessThan(ids.indexOf(coffeeId));
  });

  it("explains each match with reasons, distance, and category", async () => {
    const feed = await feedFor(barberId);
    const boutique = feed.find((s) => s.tenantId === boutiqueId)!;
    expect(boutique.name).toBe(`Match Boutique ${RUN}`);
    expect(boutique.category).toBeTruthy();
    expect(boutique.city).toBe("Riverside");
    expect(typeof boutique.distanceMiles).toBe("number");
    expect(boutique.distanceMiles!).toBeLessThan(1);
    // Curated complementary pairing blurb + proximity + activity all surface.
    expect(boutique.reasons.join(" ")).toMatch(/cuts and fresh fits/i);
    expect(boutique.reasons.join(" ")).toMatch(/mile/i);
    expect(boutique.reasons.join(" ")).toMatch(/customer/i);
  });

  it("auto-generates editable proposal terms from both businesses' categories", async () => {
    const feed = await feedFor(barberId);
    const boutique = feed.find((s) => s.tenantId === boutiqueId)!;
    expect(boutique.proposal.perkTitle).toContain(`Match Boutique ${RUN}`);
    expect(boutique.proposal.perkTitle).toMatch(/10% off/i);
    // Category-derived nouns: boutique → "purchase", barbershop → "cut".
    expect(boutique.proposal.perkTitle).toMatch(/purchase/i);
    expect(boutique.proposal.perkDescription).toContain(`Match Barber ${RUN}`);
    expect(boutique.proposal.mutualRewardTerms).toMatch(/cut/i);
    expect(boutique.proposal.mutualRewardTerms).toContain(`Match Boutique ${RUN}`);
  });
});

describe("auto-population when profile fields change", () => {
  it("recomputes and persists the feed on a coop-scope settings change (onboarding trigger)", async () => {
    await db.delete(coopSuggestionsTable).where(eq(coopSuggestionsTable.tenantId, barberId));
    await agent
      .patch(`/api/tenants/${barberId}/settings`)
      .send({ latitude: "40.7129" })
      .expect(200);
    const stored = await db
      .select()
      .from(coopSuggestionsTable)
      .where(eq(coopSuggestionsTable.tenantId, barberId))
      .orderBy(desc(coopSuggestionsTable.score));
    const minePersisted = stored.filter((r) => allIds().includes(r.suggestedTenantId));
    const ids = minePersisted.map((r) => r.suggestedTenantId);
    expect(ids).toContain(boutiqueId);
    expect(ids).toContain(coffeeId);
    expect(ids).not.toContain(rivalBarberId);
    expect(minePersisted[0]!.reasons.length).toBeGreaterThan(0);
  });
});

describe("dismissals", () => {
  it("dismissing hides the suggestion from the feed and persists", async () => {
    await agent
      .post(`/api/coop/suggestions/${coffeeId}/dismiss`)
      .set("x-tenant-id", String(barberId))
      .expect(200, { dismissed: true });
    // Idempotent.
    await agent
      .post(`/api/coop/suggestions/${coffeeId}/dismiss`)
      .set("x-tenant-id", String(barberId))
      .expect(200);

    const feed = await feedFor(barberId);
    expect(feed.map((s) => s.tenantId)).not.toContain(coffeeId);
    // Persisted rows also cleaned up.
    const [row] = await db
      .select()
      .from(coopSuggestionsTable)
      .where(
        and(
          eq(coopSuggestionsTable.tenantId, barberId),
          eq(coopSuggestionsTable.suggestedTenantId, coffeeId)
        )
      );
    expect(row).toBeUndefined();
    const dismissals = await db
      .select()
      .from(coopSuggestionDismissalsTable)
      .where(eq(coopSuggestionDismissalsTable.tenantId, barberId));
    expect(dismissals.map((d) => d.dismissedTenantId)).toContain(coffeeId);
  });

  it("404s for a nonexistent business", async () => {
    await agent
      .post("/api/coop/suggestions/999999999/dismiss")
      .set("x-tenant-id", String(barberId))
      .expect(404);
  });
});

describe("one-click invite → notification → Accept & Launch", () => {
  let inviteId: number;

  it("sending the pre-formatted proposal notifies the target via SMS (simulated) with a hub link", async () => {
    const feed = await feedFor(barberId);
    const boutique = feed.find((s) => s.tenantId === boutiqueId)!;
    const res = await agent
      .post("/api/coop/invites")
      .set("x-tenant-id", String(barberId))
      .send({
        partnerTenantId: boutiqueId,
        perkTitle: boutique.proposal.perkTitle,
        perkDescription: boutique.proposal.perkDescription,
        mutualRewardTerms: boutique.proposal.mutualRewardTerms,
      })
      .expect(201);
    inviteId = res.body.id;
    expect(res.body.status).toBe("pending");

    // SMS through the unified pipeline: no Twilio creds → simulated fallback.
    const [msg] = await db
      .select()
      .from(messagesTable)
      .where(and(eq(messagesTable.tenantId, boutiqueId), eq(messagesTable.kind, "coop_invite")))
      .orderBy(desc(messagesTable.id))
      .limit(1);
    expect(msg).toBeDefined();
    expect(msg!.status).toBe("simulated");
    expect(msg!.toNumber).toBe("+15550001111");
    expect(msg!.body).toContain(`Match Barber ${RUN}`);
    expect(msg!.body).toContain(boutique.proposal.perkTitle);
    expect(msg!.body).toContain("tab=coop");
    expect(msg!.body).toContain(`tenant=${boutiqueId}`);
  });

  it("a pending invite removes the pair from both feeds (in-app alert takes over)", async () => {
    const barberFeed = await feedFor(barberId);
    expect(barberFeed.map((s) => s.tenantId)).not.toContain(boutiqueId);
    const boutiqueFeed = await feedFor(boutiqueId);
    expect(boutiqueFeed.map((s) => s.tenantId)).not.toContain(barberId);
    // In-app notification path: the invite shows as pending in the target's hub.
    const list = await agent
      .get("/api/coop/partnerships")
      .set("x-tenant-id", String(boutiqueId))
      .expect(200);
    const pending = list.body.find((p: { id: number }) => p.id === inviteId);
    expect(pending).toBeDefined();
    expect(pending.status).toBe("pending");
    expect(pending.requestedByTenantId).toBe(barberId);
  });

  it("one-tap Accept & Launch activates the mutual perk on both checkout surfaces", async () => {
    await agent
      .post(`/api/coop/invites/${inviteId}/respond`)
      .set("x-tenant-id", String(boutiqueId))
      .send({ action: "accept" })
      .expect(200);

    for (const [viewer, partnerName] of [
      [barberId, `Match Boutique ${RUN}`],
      [boutiqueId, `Match Barber ${RUN}`],
    ] as const) {
      const res = await agent
        .get("/api/coop/perks")
        .set("x-tenant-id", String(viewer))
        .expect(200);
      const perk = res.body.perks.find((p: { partnerName: string }) => p.partnerName === partnerName);
      expect(perk).toBeDefined();
      expect(perk.redemptionCode).toBeTruthy();
    }
  });
});
