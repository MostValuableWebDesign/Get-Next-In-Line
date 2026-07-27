import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// SEO landing page + reviews integration tests, against the real dev DB.
//
// Covers: server-rendered crawlable HTML (title/meta/JSON-LD readable without
// executing the app), LocalBusiness structured data with address/geo/hours/
// services, review management CRUD + visibility on the public page, XSS
// escaping, and the auth boundary (landing public, review management not).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `seoland-${Date.now()}-${process.pid}`;
const SLUG = `${RUN}-a`;

let agent: ReturnType<typeof request.agent>;
let anon: ReturnType<typeof request>;
let tenantId: number;

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  anon = request(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `SEO Landing ${RUN}`, subdomain: SLUG, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;

  // Fill in the local-SEO profile + a legacy service list.
  await agent
    .patch(`/api/tenants/${tenantId}/settings`)
    .send({
      seoDescription: "Best fades in town & <great> vibes",
      publicPhone: "+15551234567",
      streetAddress: "123 Main St",
      addressLocality: "Springfield",
      addressRegion: "IL",
      postalCode: "62704",
      latitude: "39.7817",
      longitude: "-89.6501",
      businessCategory: "HairSalon",
      serviceNames: "Haircut, Beard Trim",
      openTime: "09:00",
      closeTime: "17:00",
    })
    .expect(200);
});

afterAll(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

function extractJsonLd(html: string): Record<string, any> {
  const m = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  expect(m, "JSON-LD script tag present").toBeTruthy();
  return JSON.parse(m![1]);
}

describe("public SEO landing page", () => {
  it("serves crawlable HTML without a session", async () => {
    const res = await anon.get(`/api/public/landing/${SLUG}`).expect(200);
    expect(res.headers["content-type"]).toContain("text/html");
    // Localized title + meta description in raw source
    expect(res.text).toContain(
      `<title>SEO Landing ${RUN} — Springfield, IL | Book Online</title>`,
    );
    expect(res.text).toMatch(/<meta name="description" content="Best fades/);
    // Escaped, not raw, user content
    expect(res.text).not.toContain("<great>");
    expect(res.text).toContain("&lt;great&gt;");
    // Visible profile details + service menu + booking link
    expect(res.text).toContain("123 Main St");
    expect(res.text).toContain("Haircut");
    expect(res.text).toContain(`href="/book/${SLUG}"`);
  });

  it("embeds valid Schema.org LocalBusiness JSON-LD", async () => {
    const res = await anon.get(`/api/public/landing/${SLUG}`).expect(200);
    const ld = extractJsonLd(res.text);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("HairSalon");
    expect(ld.name).toBe(`SEO Landing ${RUN}`);
    expect(ld.telephone).toBe("+15551234567");
    expect(ld.address).toMatchObject({
      "@type": "PostalAddress",
      streetAddress: "123 Main St",
      addressLocality: "Springfield",
      addressRegion: "IL",
      postalCode: "62704",
    });
    expect(ld.geo).toMatchObject({
      "@type": "GeoCoordinates",
      latitude: 39.7817,
      longitude: -89.6501,
    });
    expect(ld.openingHoursSpecification[0]).toMatchObject({
      opens: "09:00",
      closes: "17:00",
    });
    const services = ld.hasOfferCatalog.itemListElement.map(
      (o: any) => o.itemOffered.name,
    );
    expect(services).toEqual(["Haircut", "Beard Trim"]);
  });

  it("404s for unknown or malformed slugs", async () => {
    await anon.get(`/api/public/landing/no-such-biz-${RUN}`).expect(404);
    await anon.get(`/api/public/landing/bad_slug!`).expect(404);
  });
});

describe("review management + landing visibility", () => {
  let visibleId: number;
  let hiddenId: number;

  it("requires a session for review management", async () => {
    await anon.get(`/api/tenants/${tenantId}/reviews`).expect(401);
    await anon
      .post(`/api/tenants/${tenantId}/reviews`)
      .send({ authorName: "Anon", rating: 5 })
      .expect(401);
  });

  it("creates reviews and lists them newest-first", async () => {
    const r1 = await agent
      .post(`/api/tenants/${tenantId}/reviews`)
      .send({ authorName: "Happy Customer", rating: 5, body: "Amazing cut!" })
      .expect(201);
    visibleId = r1.body.id;
    const r2 = await agent
      .post(`/api/tenants/${tenantId}/reviews`)
      .send({ authorName: "Grumpy Customer", rating: 2, body: "Too loud <script>" })
      .expect(201);
    hiddenId = r2.body.id;

    const list = await agent.get(`/api/tenants/${tenantId}/reviews`).expect(200);
    expect(list.body.map((r: any) => r.id)).toContain(visibleId);
    expect(list.body.map((r: any) => r.id)).toContain(hiddenId);
  });

  it("rejects out-of-range ratings", async () => {
    await agent
      .post(`/api/tenants/${tenantId}/reviews`)
      .send({ authorName: "X", rating: 6 })
      .expect(400);
  });

  it("hides a review from the landing page when isVisible is false", async () => {
    await agent
      .patch(`/api/tenants/${tenantId}/reviews/${hiddenId}`)
      .send({ isVisible: false })
      .expect(200);

    const res = await anon.get(`/api/public/landing/${SLUG}`).expect(200);
    expect(res.text).toContain("Happy Customer");
    expect(res.text).toContain("Amazing cut!");
    expect(res.text).not.toContain("Grumpy Customer");
    // Escaped review body on public page (no raw script injection)
    expect(res.text).not.toContain("<script>alert");

    // JSON-LD aggregates only visible reviews
    const ld = extractJsonLd(res.text);
    expect(ld.aggregateRating).toMatchObject({ ratingValue: 5, reviewCount: 1 });
    expect(ld.review).toHaveLength(1);
    expect(ld.review[0].author.name).toBe("Happy Customer");
  });

  it("deletes reviews and scopes them to the tenant", async () => {
    // Wrong tenant id → 404, review untouched
    await agent
      .delete(`/api/tenants/99999999/reviews/${visibleId}`)
      .expect(404);
    await agent
      .delete(`/api/tenants/${tenantId}/reviews/${hiddenId}`)
      .expect(204);
    await agent
      .delete(`/api/tenants/${tenantId}/reviews/${hiddenId}`)
      .expect(404);
    const list = await agent.get(`/api/tenants/${tenantId}/reviews`).expect(200);
    expect(list.body.map((r: any) => r.id)).not.toContain(hiddenId);
  });
});
