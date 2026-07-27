import { Router, type IRouter } from "express";
import {
  db,
  tenantsTable,
  sosReviewsTable,
  merchantCoopPartnershipsTable,
} from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, or } from "drizzle-orm";
import { getSettingsForTenant } from "../lib/settings";
import { COOP_PERK_DISCLAIMER, perkWindowOpen } from "../lib/coopPerks";
import { listServicesForScope } from "../lib/serviceCatalog";
import { parseServiceNames } from "../lib/receptionist";

// ── Public SEO landing page ──────────────────────────────────────────────────
// Server-rendered, crawlable HTML page for each business: localized metadata,
// Schema.org LocalBusiness JSON-LD (hours, address, phone, services), visible
// customer reviews, and a "Book now" link into the public booking flow.
//
// Deliberately unauthenticated (crawlers must fetch it), slug-scoped like the
// public booking API, and read-only. It must only ever render data the
// business chose to publish: profile fields, active services, and reviews
// with isVisible = true.

const router: IRouter = Router();

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Serialize JSON-LD safely for inline <script> embedding. */
function jsonLd(obj: unknown): string {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

const SCHEMA_TYPE_RE = /^[A-Za-z][A-Za-z0-9]{0,60}$/;

// ── Public co-op perks ───────────────────────────────────────────────────────
// A business's active merchant co-op partnership perks, shaped for public
// display: perk title, description, and the *other* business's name only.
// Redemption codes are deliberately never selected here — they must never
// reach the public storefront HTML or the public perks JSON.
export interface PublicCoopPerk {
  perkTitle: string;
  perkDescription: string | null;
  partnerBusinessName: string;
}

export async function getPublicCoopPerks(
  tenantId: number,
): Promise<PublicCoopPerk[]> {
  const hostTenant = alias(tenantsTable, "landing_host_tenant");
  const partnerTenant = alias(tenantsTable, "landing_partner_tenant");
  const rows = await db
    .select({
      perkTitle: merchantCoopPartnershipsTable.perkTitle,
      perkDescription: merchantCoopPartnershipsTable.perkDescription,
      hostTenantId: merchantCoopPartnershipsTable.hostTenantId,
      hostTenantName: hostTenant.brandName,
      partnerTenantName: partnerTenant.brandName,
    })
    .from(merchantCoopPartnershipsTable)
    .innerJoin(hostTenant, eq(merchantCoopPartnershipsTable.hostTenantId, hostTenant.id))
    .innerJoin(partnerTenant, eq(merchantCoopPartnershipsTable.partnerTenantId, partnerTenant.id))
    .where(
      and(
        eq(merchantCoopPartnershipsTable.isActive, true),
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        // Perks outside their optional date window never render publicly.
        perkWindowOpen(),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId),
        ),
      ),
    )
    .orderBy(desc(merchantCoopPartnershipsTable.createdAt), desc(merchantCoopPartnershipsTable.id));
  return rows.map((r) => ({
    perkTitle: r.perkTitle,
    perkDescription: r.perkDescription,
    partnerBusinessName:
      r.hostTenantId === tenantId ? r.partnerTenantName : r.hostTenantName,
  }));
}

function starRow(rating: number): string {
  const n = Math.max(1, Math.min(5, Math.round(rating)));
  return "★".repeat(n) + "☆".repeat(5 - n);
}

// GET /public/landing/:slug/perks — read-only, unauthenticated JSON view of a
// business's active co-op partnership perks. Same slug-scoping as the landing
// page; exposes only perk title, description, and partner business name.
router.get("/public/landing/:slug/perks", async (req, res): Promise<void> => {
  const slug = String(req.params.slug || "").toLowerCase();
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const [tenant] = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.subdomain, slug));
  if (!tenant) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const perks = await getPublicCoopPerks(tenant.id);
  res.json({ perks, disclaimer: COOP_PERK_DISCLAIMER });
});

router.get("/public/landing/:slug", async (req, res): Promise<void> => {
  const slug = String(req.params.slug || "").toLowerCase();
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.subdomain, slug));
  if (!tenant) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  const settings = await getSettingsForTenant(tenant.id);
  if (!settings) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }

  // Service menu: structured catalog (active rows) with legacy fallback.
  const catalog = await listServicesForScope(tenant.id);
  const services =
    catalog.length > 0
      ? catalog.filter((s) => s.isActive)
      : parseServiceNames(settings.serviceNames).map((name) => ({
          name,
          description: null as string | null,
          price: null as string | null,
          durationMinutes: null as number | null,
        }));

  const perks = await getPublicCoopPerks(tenant.id);

  const reviews = await db
    .select()
    .from(sosReviewsTable)
    .where(
      and(
        eq(sosReviewsTable.tenantId, tenant.id),
        eq(sosReviewsTable.isVisible, true),
      ),
    )
    .orderBy(desc(sosReviewsTable.createdAt), desc(sosReviewsTable.id));

  const name = settings.businessName || tenant.brandName;
  const locality = settings.addressLocality;
  const region = settings.addressRegion;
  const place = [locality, region].filter(Boolean).join(", ");
  const title = place ? `${name} — ${place} | Book Online` : `${name} | Book Online`;
  const description =
    settings.seoDescription ||
    `Book an appointment online with ${name}${place ? ` in ${place}` : ""}.`;

  const bookUrl = `/book/${encodeURIComponent(slug)}`;
  const pageUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

  // ── Schema.org LocalBusiness JSON-LD ───────────────────────────────────────
  const schemaType = SCHEMA_TYPE_RE.test(settings.businessCategory)
    ? settings.businessCategory
    : "LocalBusiness";
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": schemaType,
    name,
    url: pageUrl,
  };
  if (settings.seoDescription) ld.description = settings.seoDescription;
  if (settings.publicPhone) ld.telephone = settings.publicPhone;
  if (
    settings.streetAddress ||
    settings.addressLocality ||
    settings.addressRegion ||
    settings.postalCode
  ) {
    ld.address = {
      "@type": "PostalAddress",
      ...(settings.streetAddress ? { streetAddress: settings.streetAddress } : {}),
      ...(settings.addressLocality ? { addressLocality: settings.addressLocality } : {}),
      ...(settings.addressRegion ? { addressRegion: settings.addressRegion } : {}),
      ...(settings.postalCode ? { postalCode: settings.postalCode } : {}),
    };
  }
  const lat = parseFloat(settings.latitude);
  const lng = parseFloat(settings.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    ld.geo = { "@type": "GeoCoordinates", latitude: lat, longitude: lng };
  }
  if (settings.openTime && settings.closeTime) {
    ld.openingHoursSpecification = [
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: [
          "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
        ],
        opens: settings.openTime,
        closes: settings.closeTime,
      },
    ];
  }
  if (services.length > 0) {
    ld.hasOfferCatalog = {
      "@type": "OfferCatalog",
      name: "Services",
      itemListElement: services.map((s) => ({
        "@type": "Offer",
        itemOffered: {
          "@type": "Service",
          name: s.name,
          ...(s.description ? { description: s.description } : {}),
        },
        ...(s.price != null ? { price: s.price, priceCurrency: "USD" } : {}),
      })),
    };
  }
  if (reviews.length > 0) {
    const avg =
      reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
    ld.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: Math.round(avg * 10) / 10,
      reviewCount: reviews.length,
      bestRating: 5,
      worstRating: 1,
    };
    ld.review = reviews.slice(0, 10).map((r) => ({
      "@type": "Review",
      author: { "@type": "Person", name: r.authorName },
      reviewRating: { "@type": "Rating", ratingValue: r.rating, bestRating: 5, worstRating: 1 },
      ...(r.body ? { reviewBody: r.body } : {}),
      datePublished: r.createdAt.toISOString().slice(0, 10),
    }));
  }

  const servicesHtml =
    services.length > 0
      ? `<section id="services"><h2>Services</h2><ul class="services">${services
          .map((s) => {
            const meta = [
              s.durationMinutes != null ? `${s.durationMinutes} min` : null,
              s.price != null ? `$${escapeHtml(String(s.price))}` : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return `<li><span class="svc-name">${escapeHtml(s.name)}</span>${
              meta ? `<span class="svc-meta">${meta}</span>` : ""
            }${s.description ? `<p class="svc-desc">${escapeHtml(s.description)}</p>` : ""}</li>`;
          })
          .join("")}</ul></section>`
      : "";

  const reviewsHtml =
    reviews.length > 0
      ? `<section id="reviews"><h2>Customer Reviews</h2>${reviews
          .map(
            (r) =>
              `<article class="review"><div class="stars" aria-label="${r.rating} out of 5 stars">${starRow(
                r.rating,
              )}</div>${r.body ? `<p>${escapeHtml(r.body)}</p>` : ""}<footer>— ${escapeHtml(
                r.authorName,
              )}</footer></article>`,
          )
          .join("")}</section>`
      : "";

  // Inline booking: the existing embeddable booking widget in embed mode,
  // scoped to this same business. The plain "open the booking page" link
  // remains as a crawlable, no-JS fallback.
  const embedUrl = `${bookUrl}?embed=1`;
  const bookingHtml = `<section id="book" data-testid="section-storefront-booking"><h2>Book Your Appointment</h2>
    <iframe class="booking-embed" src="${escapeHtml(embedUrl)}" title="Book an appointment with ${escapeHtml(name)}" loading="lazy"></iframe>
    <p class="book-fallback">Trouble with the form? <a href="${escapeHtml(bookUrl)}" data-testid="link-book-now">Open the booking page</a>.</p>
  </section>`;

  // Local Perks banner: active co-op partnership perks only. Renders nothing
  // when the business has no active partnerships, and never includes
  // redemption codes or other businesses' booking links.
  const perksHtml =
    perks.length > 0
      ? `<section id="perks" data-testid="section-local-perks"><h2>Local Perks</h2>
    <p class="perks-intro">Perks for our customers through local business partnerships.</p>
    ${perks
      .map(
        (p) =>
          `<article class="perk"><h3>${escapeHtml(p.perkTitle)}</h3>${
            p.perkDescription ? `<p>${escapeHtml(p.perkDescription)}</p>` : ""
          }<footer>with ${escapeHtml(p.partnerBusinessName)}</footer></article>`,
      )
      .join("\n    ")}
    <p class="perk-disclaimer" data-testid="text-perk-disclaimer">${escapeHtml(COOP_PERK_DISCLAIMER)}</p>
  </section>`
      : "";

  const detailRows: string[] = [];
  const addressLine = [
    settings.streetAddress,
    [locality, region].filter(Boolean).join(", "),
    settings.postalCode,
  ]
    .filter(Boolean)
    .join(" · ");
  if (addressLine) detailRows.push(`<p class="detail">📍 ${escapeHtml(addressLine)}</p>`);
  if (settings.publicPhone)
    detailRows.push(
      `<p class="detail">📞 <a href="tel:${escapeHtml(settings.publicPhone)}">${escapeHtml(settings.publicPhone)}</a></p>`,
    );
  if (settings.openTime && settings.closeTime)
    detailRows.push(
      `<p class="detail">🕒 Open daily ${escapeHtml(settings.openTime)}–${escapeHtml(settings.closeTime)}</p>`,
    );

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(pageUrl)}">
<meta property="og:type" content="business.business">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(pageUrl)}">
<script type="application/ld+json">${jsonLd(ld)}</script>
<style>
  :root{color-scheme:light}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;color:#1a1a2e;background:#fafafa;line-height:1.6}
  main{max-width:720px;margin:0 auto;padding:2rem 1.25rem 4rem}
  header.hero{padding:3rem 0 1.5rem}
  h1{font-size:2rem;margin:0 0 .5rem}
  h2{font-size:1.25rem;margin:2.5rem 0 .75rem;border-bottom:1px solid #e5e5ef;padding-bottom:.4rem}
  .tagline{color:#4a4a68;margin:0 0 1rem}
  .detail{margin:.25rem 0;color:#33334d}
  .book-btn{display:inline-block;margin-top:1.25rem;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:.8rem 1.6rem;border-radius:.5rem}
  .book-btn:hover{background:#4338ca}
  ul.services{list-style:none;padding:0;margin:0}
  ul.services li{padding:.7rem 0;border-bottom:1px solid #ececf4;display:flex;flex-wrap:wrap;gap:.5rem;align-items:baseline}
  .svc-name{font-weight:600}
  .svc-meta{color:#6b6b8a;font-size:.9rem}
  .svc-desc{width:100%;margin:.15rem 0 0;color:#4a4a68;font-size:.95rem}
  .review{background:#fff;border:1px solid #ececf4;border-radius:.6rem;padding:1rem 1.2rem;margin:.75rem 0}
  .stars{color:#f59e0b;letter-spacing:.15em}
  .review footer{color:#6b6b8a;font-size:.9rem}
  .cta-bottom{margin-top:3rem;text-align:center}
  .booking-embed{width:100%;height:640px;border:1px solid #ececf4;border-radius:.6rem;background:#fff}
  .book-fallback{color:#6b6b8a;font-size:.9rem}
  .perks-intro{color:#4a4a68;margin:0 0 .75rem}
  .perk{background:#fffbeb;border:1px solid #fde68a;border-radius:.6rem;padding:1rem 1.2rem;margin:.75rem 0}
  .perk h3{margin:0 0 .25rem;font-size:1.05rem}
  .perk p{margin:.15rem 0;color:#4a4a68}
  .perk footer{color:#92400e;font-size:.9rem;font-weight:600}
  .perk-disclaimer{color:#6b6b8a;font-size:.75rem;margin-top:.75rem}
</style>
</head>
<body>
<main>
  <header class="hero">
    <h1>${escapeHtml(name)}</h1>
    <p class="tagline">${escapeHtml(description)}</p>
    ${detailRows.join("\n    ")}
    <a class="book-btn" href="#book" data-testid="link-book-anchor">Book Now</a>
  </header>
  ${bookingHtml}
  ${perksHtml}
  ${servicesHtml}
  ${reviewsHtml}
  <div class="cta-bottom">
    <a class="book-btn" href="#book">Book an Appointment</a>
  </div>
</main>
</body>
</html>`;

  res.status(200).type("html").send(html);
});

export default router;
