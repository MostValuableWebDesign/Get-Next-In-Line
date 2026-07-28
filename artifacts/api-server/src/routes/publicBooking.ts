import { Router, type IRouter } from "express";
import {
  db,
  tenantsTable,
  sosCustomersTable,
  sosAppointmentsTable,
  sosResourcesTable,
} from "@workspace/db";
import { and, eq, lt, gt, ne, or, ilike, sql } from "drizzle-orm";
import {
  GetPublicBookingConfigResponse,
  GetPublicBookingAvailabilityBody,
  GetPublicBookingAvailabilityResponse,
  CreatePublicBookingBody,
  CreatePublicBookingResponse,
  ListPublicBookingPerksResponse,
} from "@workspace/api-zod";
import { merchantCoopPartnershipsTable } from "@workspace/db";
import { isNull, desc } from "drizzle-orm";
import { COOP_PERK_DISCLAIMER, perkWindowOpen } from "../lib/coopPerks";
import { filterPartnershipsForConsumerSurface } from "../lib/coopFirewall";
import { recordPerkImpressionsSafe } from "../lib/coopEvents";
import { activeBoostsForSurface } from "../lib/coopSponsorship";
import { listServicesForScope, type SosServiceRow } from "../lib/serviceCatalog";
import { resolveSettings } from "../lib/settings";
import { cachedCapacityStatus } from "../lib/capacityStatus";
import { normalizeToE164 } from "../lib/sms";
import { autoLinkCustomer } from "../lib/customerLink";
import { logger } from "../lib/logger";

// ── Public booking API ───────────────────────────────────────────────────────
// Unauthenticated, tenant-slug-scoped endpoints powering the public booking
// page and embeddable widget. The slug is the tenant's subdomain. These
// routes are registered BEFORE the session-auth middleware — they must never
// expose anything beyond the public booking surface (service menu, staff
// names, computed availability) and must never accept a tenant id directly.

const router: IRouter = Router();

/**
 * Advisory-lock namespace for public booking creation. Combined with the
 * tenant id (`pg_advisory_xact_lock(ns, tenantId)`), it serializes booking
 * writes per tenant so concurrent requests can't double-book a slot.
 */
export const PUBLIC_BOOKING_LOCK_NS = 0x676e_6270; // "gnbp"

const SLOT_STEP_MINUTES = 30;
const DEFAULT_DURATION_MINUTES = 60;
const MAX_ADVANCE_DAYS = 90;

// ── Abuse guard: per-IP fixed-window rate limit on booking creation ─────────
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_BOOKINGS = 10;
const bookingAttempts = new Map<string, { windowStart: number; count: number }>();

function isRateLimited(ip: string, now = Date.now()): boolean {
  const entry = bookingAttempts.get(ip);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    bookingAttempts.set(ip, { windowStart: now, count: 1 });
    // Opportunistic cleanup so the map can't grow unboundedly.
    if (bookingAttempts.size > 10_000) {
      for (const [key, val] of bookingAttempts) {
        if (now - val.windowStart >= RATE_LIMIT_WINDOW_MS) bookingAttempts.delete(key);
      }
    }
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX_BOOKINGS;
}

/** Test-only hook so integration tests don't trip each other's limits. */
export function __resetPublicBookingRateLimit(): void {
  bookingAttempts.clear();
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function findTenantBySlug(slug: string) {
  if (!/^[a-z0-9-]{1,80}$/i.test(slug)) return null;
  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.subdomain, slug.toLowerCase()));
  return tenant ?? null;
}

function parseHm(hm: string): { h: number; m: number } {
  const [h, m] = hm.split(":").map(Number);
  return { h: Number.isInteger(h) ? h : 9, m: Number.isInteger(m) ? m : 0 };
}

interface Window { start: Date; end: Date }

/**
 * Compute open slots for a service on a calendar date. A slot conflicts when
 * the number of overlapping non-cancelled appointments has exhausted the
 * business's capacity (its active resource count, minimum 1), or — when a
 * specific resource is requested — that resource already has an overlapping
 * appointment.
 */
async function computeSlots(opts: {
  tenantId: number;
  date: string;
  durationMinutes: number;
  openTime: string;
  closeTime: string;
  resourceId: number | null;
  resourceCount: number;
}): Promise<Window[]> {
  const { tenantId, date, durationMinutes, resourceId } = opts;
  const open = parseHm(opts.openTime);
  const close = parseHm(opts.closeTime);
  const dayStart = new Date(`${date}T00:00:00`);
  if (isNaN(dayStart.getTime())) return [];

  const windowStart = new Date(dayStart);
  windowStart.setHours(open.h, open.m, 0, 0);
  const windowEnd = new Date(dayStart);
  windowEnd.setHours(close.h, close.m, 0, 0);

  // Existing bookings that could overlap any slot on this day.
  const existing = await db
    .select({
      startsAt: sosAppointmentsTable.startsAt,
      endsAt: sosAppointmentsTable.endsAt,
      resourceId: sosAppointmentsTable.resourceId,
    })
    .from(sosAppointmentsTable)
    .where(
      and(
        eq(sosAppointmentsTable.tenantId, tenantId),
        ne(sosAppointmentsTable.status, "cancelled"),
        ne(sosAppointmentsTable.status, "no_show"),
        lt(sosAppointmentsTable.startsAt, windowEnd),
        gt(sosAppointmentsTable.endsAt, windowStart),
      ),
    );

  const capacity = Math.max(1, opts.resourceCount);
  const now = Date.now();
  const slots: Window[] = [];
  for (
    let t = windowStart.getTime();
    t + durationMinutes * 60_000 <= windowEnd.getTime();
    t += SLOT_STEP_MINUTES * 60_000
  ) {
    if (t <= now) continue; // never offer past (or immediate) slots
    const slotStart = t;
    const slotEnd = t + durationMinutes * 60_000;
    const overlapping = existing.filter(
      (a) => a.startsAt.getTime() < slotEnd && a.endsAt.getTime() > slotStart,
    );
    if (overlapping.length >= capacity) continue;
    if (
      resourceId != null &&
      overlapping.some((a) => a.resourceId === resourceId)
    ) {
      continue;
    }
    slots.push({ start: new Date(slotStart), end: new Date(slotEnd) });
  }
  return slots;
}

async function getPublicContext(slug: string) {
  const tenant = await findTenantBySlug(slug);
  if (!tenant) return null;
  const [settings, services, resources] = await Promise.all([
    resolveSettings(tenant.id),
    listServicesForScope(tenant.id),
    db
      .select()
      .from(sosResourcesTable)
      .where(eq(sosResourcesTable.tenantId, tenant.id))
      .orderBy(sosResourcesTable.id),
  ]);
  return { tenant, settings, services, resources };
}

const activeServices = (services: SosServiceRow[]) =>
  services.filter((s) => s.isActive);

// ── routes ───────────────────────────────────────────────────────────────────

router.get("/public/booking/:slug", async (req, res): Promise<void> => {
  const ctx = await getPublicContext(req.params.slug);
  if (!ctx) {
    res.status(404).json({ message: "Business not found" });
    return;
  }
  const { tenant, settings, services, resources } = ctx;
  res.json(
    GetPublicBookingConfigResponse.parse({
      slug: tenant.subdomain,
      brandName: tenant.brandName,
      businessName: settings.businessName,
      industryType: settings.industryType,
      resourceLabel: settings.resourceLabel,
      openTime: settings.openTime,
      closeTime: settings.closeTime,
      services: activeServices(services).map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category,
        description: s.description,
        price: s.price == null ? null : parseFloat(s.price),
        durationMinutes: s.durationMinutes,
      })),
      staff: resources.map((r) => ({ id: r.id, name: r.name })),
      // Live capacity status (busy / moderate / available) so customers see
      // how busy the business is right now; short-cached, never blocks the
      // page on a status failure.
      capacityStatus: await cachedCapacityStatus(tenant.id)
        .then((r) => r.status)
        .catch(() => null),
    }),
  );
});

router.post(
  "/public/booking/:slug/availability",
  async (req, res): Promise<void> => {
    const body = GetPublicBookingAvailabilityBody.parse(req.body);
    const ctx = await getPublicContext(req.params.slug);
    if (!ctx) {
      res.status(404).json({ message: "Business not found" });
      return;
    }
    const service = activeServices(ctx.services).find((s) => s.id === body.serviceId);
    if (!service) {
      res.status(404).json({ message: "Service not found" });
      return;
    }
    const resourceId =
      body.resourceId != null &&
      ctx.resources.some((r) => r.id === body.resourceId)
        ? body.resourceId
        : null;
    const slots = await computeSlots({
      tenantId: ctx.tenant.id,
      date: body.date,
      durationMinutes: service.durationMinutes ?? DEFAULT_DURATION_MINUTES,
      openTime: ctx.settings.openTime,
      closeTime: ctx.settings.closeTime,
      resourceId,
      resourceCount: ctx.resources.length,
    });
    res.json(
      GetPublicBookingAvailabilityResponse.parse({
        slots: slots.map((s) => ({
          startsAt: s.start.toISOString(),
          endsAt: s.end.toISOString(),
        })),
      }),
    );
  },
);

router.post(
  "/public/booking/:slug/appointments",
  async (req, res): Promise<void> => {
    const body = CreatePublicBookingBody.parse(req.body);
    const ctx = await getPublicContext(req.params.slug);
    if (!ctx) {
      res.status(404).json({ message: "Business not found" });
      return;
    }

    const ip = req.ip ?? "unknown";
    if (isRateLimited(ip)) {
      res.status(429).json({ message: "Too many booking attempts. Please try again later." });
      return;
    }

    const phone = body.phone?.trim() || null;
    const email = body.email?.trim() || null;
    if (!phone && !email) {
      res.status(400).json({ message: "A phone number or email is required." });
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ message: "That email address doesn't look right." });
      return;
    }
    if (phone && normalizeToE164(phone) == null) {
      res.status(400).json({ message: "That phone number doesn't look right." });
      return;
    }

    const service = activeServices(ctx.services).find((s) => s.id === body.serviceId);
    if (!service) {
      res.status(404).json({ message: "Service not found" });
      return;
    }

    const startsAt = new Date(body.startsAt);
    if (isNaN(startsAt.getTime())) {
      res.status(400).json({ message: "Invalid start time." });
      return;
    }
    if (startsAt.getTime() <= Date.now()) {
      res.status(409).json({ message: "That time has already passed. Please pick another slot." });
      return;
    }
    if (startsAt.getTime() > Date.now() + MAX_ADVANCE_DAYS * 24 * 60 * 60 * 1000) {
      res.status(400).json({ message: `Bookings can only be made up to ${MAX_ADVANCE_DAYS} days in advance.` });
      return;
    }
    const durationMinutes = service.durationMinutes ?? DEFAULT_DURATION_MINUTES;
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

    // Requested slot must fall within business hours.
    const open = parseHm(ctx.settings.openTime);
    const close = parseHm(ctx.settings.closeTime);
    const dayOpen = new Date(startsAt);
    dayOpen.setHours(open.h, open.m, 0, 0);
    const dayClose = new Date(startsAt);
    dayClose.setHours(close.h, close.m, 0, 0);
    if (startsAt < dayOpen || endsAt > dayClose) {
      res.status(409).json({ message: "That time is outside business hours. Please pick another slot." });
      return;
    }

    const resourceId =
      body.resourceId != null &&
      ctx.resources.some((r) => r.id === body.resourceId)
        ? body.resourceId
        : null;

    // ── Atomic booking section ───────────────────────────────────────────
    // Customer find-or-create, the duplicate guard, the slot-conflict guard,
    // and the appointment insert all run inside one transaction serialized by
    // a per-tenant advisory lock (transaction-scoped, so it auto-releases
    // even on a crash). Two concurrent requests for the same slot are
    // processed one after the other — the second sees the first's insert and
    // gets a 409 instead of double-booking.
    const normalizedPhone = normalizeToE164(phone);
    type Outcome =
      | { kind: "duplicate" }
      | { kind: "conflict" }
      | {
          kind: "booked";
          appointment: typeof sosAppointmentsTable.$inferSelect;
          customer: typeof sosCustomersTable.$inferSelect;
          createdCustomer: boolean;
        };
    const outcome: Outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${PUBLIC_BOOKING_LOCK_NS}, ${ctx.tenant.id})`,
      );

      // Find-or-create the customer within this tenant by phone/email match.
      const matchConds = [];
      if (normalizedPhone) matchConds.push(eq(sosCustomersTable.phone, normalizedPhone));
      if (phone) matchConds.push(eq(sosCustomersTable.phone, phone));
      if (email) matchConds.push(ilike(sosCustomersTable.email, email));
      const [existingCustomer] = await tx
        .select()
        .from(sosCustomersTable)
        .where(and(eq(sosCustomersTable.tenantId, ctx.tenant.id), or(...matchConds)))
        .limit(1);

      let customer = existingCustomer ?? null;
      let createdCustomer = false;
      if (!customer) {
        const [created] = await tx
          .insert(sosCustomersTable)
          .values({
            tenantId: ctx.tenant.id,
            name: body.name.trim(),
            phone: normalizedPhone ?? phone,
            email,
          })
          .returning();
        customer = created;
        createdCustomer = true;
      }

      // Duplicate guard: the same customer re-submitting the same slot+service
      // (double-click, retry) must not create a second appointment.
      const [duplicate] = await tx
        .select({ id: sosAppointmentsTable.id })
        .from(sosAppointmentsTable)
        .where(
          and(
            eq(sosAppointmentsTable.tenantId, ctx.tenant.id),
            eq(sosAppointmentsTable.customerId, customer.id),
            eq(sosAppointmentsTable.serviceType, service.name),
            eq(sosAppointmentsTable.startsAt, startsAt),
            ne(sosAppointmentsTable.status, "cancelled"),
          ),
        )
        .limit(1);
      if (duplicate) return { kind: "duplicate" as const };

      // Conflict guard: re-verify the slot is still open at booking time.
      const conflicting = await tx
        .select({
          id: sosAppointmentsTable.id,
          resourceId: sosAppointmentsTable.resourceId,
        })
        .from(sosAppointmentsTable)
        .where(
          and(
            eq(sosAppointmentsTable.tenantId, ctx.tenant.id),
            ne(sosAppointmentsTable.status, "cancelled"),
            ne(sosAppointmentsTable.status, "no_show"),
            lt(sosAppointmentsTable.startsAt, endsAt),
            gt(sosAppointmentsTable.endsAt, startsAt),
          ),
        );
      const capacity = Math.max(1, ctx.resources.length);
      const slotGone =
        conflicting.length >= capacity ||
        (resourceId != null && conflicting.some((a) => a.resourceId === resourceId));
      if (slotGone) return { kind: "conflict" as const };

      const [appointment] = await tx
        .insert(sosAppointmentsTable)
        .values({
          tenantId: ctx.tenant.id,
          customerId: customer.id,
          serviceType: service.name,
          startsAt,
          endsAt,
          resourceId,
          source: "self_book",
          notes: "Booked via public booking page",
        })
        .returning();
      return { kind: "booked" as const, appointment, customer, createdCustomer };
    });

    if (outcome.kind === "duplicate") {
      res.status(409).json({ message: "You already have this appointment booked." });
      return;
    }
    if (outcome.kind === "conflict") {
      res.status(409).json({ message: "That slot was just taken. Please pick another time." });
      return;
    }
    const { appointment, customer, createdCustomer } = outcome;

    if (createdCustomer) {
      // Same customer↔concierge linking as staff-created customers so public
      // bookings flow into retention automations. Outside the transaction —
      // a linking failure must never undo the booking.
      await autoLinkCustomer(customer).catch((err) =>
        logger.warn({ err, customerId: customer.id }, "Public booking: profile auto-link failed"),
      );
    }

    logger.info(
      { tenantId: ctx.tenant.id, appointmentId: appointment.id, customerId: customer.id },
      "Public booking created",
    );

    const staffName =
      resourceId != null
        ? (ctx.resources.find((r) => r.id === resourceId)?.name ?? null)
        : null;
    res.status(201).json(
      CreatePublicBookingResponse.parse({
        appointmentId: appointment.id,
        serviceType: appointment.serviceType,
        startsAt: appointment.startsAt.toISOString(),
        endsAt: appointment.endsAt.toISOString(),
        businessName: ctx.settings.businessName,
        staffName,
      }),
    );
  },
);

// ── GET /public/booking/:slug/perks — confirmation-screen partner perks ─────
// Read-only and slug-scoped like the rest of the public booking surface:
// only live perks (accepted + active partnerships, open window, firewall-
// filtered) for the booked business, with partner names — exactly what the
// tenant-scoped /coop/perks would serve. Perks whose partnership holds an
// active paid "Featured Spot" boost for the booking-confirmation surface
// come first, flagged featured.
router.get("/public/booking/:slug/perks", async (req, res): Promise<void> => {
  const tenant = await findTenantBySlug(String(req.params.slug));
  if (!tenant) {
    res.status(404).json({ message: "Unknown business" });
    return;
  }
  const hostTenant = { id: tenant.id };
  const partnerAlias = tenantsTable;
  const rows = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        eq(merchantCoopPartnershipsTable.isActive, true),
        eq(merchantCoopPartnershipsTable.disputeSuspended, false),
        isNull(merchantCoopPartnershipsTable.bannedAt),
        perkWindowOpen(),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenant.id),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenant.id),
        ),
      ),
    )
    .orderBy(desc(merchantCoopPartnershipsTable.createdAt), desc(merchantCoopPartnershipsTable.id));
  // Same consumer-surface firewall as /coop/perks: a competitor's or
  // isolation-paired business's perk never renders publicly either.
  const visible = await filterPartnershipsForConsumerSurface(tenant.id, rows);
  // Partner display names for the surviving rows.
  const otherIds = [
    ...new Set(visible.map((p) => (p.hostTenantId === tenant.id ? p.partnerTenantId : p.hostTenantId))),
  ];
  const partnerNames = new Map<number, string>();
  if (otherIds.length > 0) {
    const namedRows = await db
      .select({ id: partnerAlias.id, name: partnerAlias.brandName })
      .from(partnerAlias)
      .where(or(...otherIds.map((id) => eq(partnerAlias.id, id))));
    for (const r of namedRows) partnerNames.set(r.id, r.name);
  }
  await recordPerkImpressionsSafe(tenant.id, visible);
  const confirmationBoosts = await activeBoostsForSurface("booking_confirmation");
  const boostedPartnershipIds = new Set(confirmationBoosts.map((b) => b.partnershipId));
  res.json(
    ListPublicBookingPerksResponse.parse({
      disclaimer: COOP_PERK_DISCLAIMER,
      perks: visible
        .map((p) => ({
          id: p.id,
          perkTitle: p.perkTitle,
          perkDescription: p.perkDescription,
          mutualRewardTerms: p.mutualRewardTerms,
          partnerName:
            partnerNames.get(p.hostTenantId === hostTenant.id ? p.partnerTenantId : p.hostTenantId) ??
            "Partner",
          redemptionCode: p.redemptionCode,
          perkEndsAt: p.perkEndsAt ? p.perkEndsAt.toISOString() : null,
          featured: boostedPartnershipIds.has(p.id),
        }))
        .sort((a, b) => Number(b.featured) - Number(a.featured)),
    }),
  );
});

export default router;
