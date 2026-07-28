import { Router, type Request, type IRouter } from "express";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  sosStaffMembersTable,
  coopCoverageShiftsTable,
  coopCoverageOffersTable,
  coopCoverageRatingsTable,
  merchantCoopPartnershipsTable,
  type CoopCoverageShift,
  type CoopCoverageOffer,
  type CoopCoverageRating,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  ListCoopCoveragePartnerStaffResponse,
  ListCoopCoverageShiftsResponse,
  CreateCoopCoverageShiftBody,
  CreateCoopCoverageShiftResponse,
  OfferCoopCoverageStaffBody,
  OfferCoopCoverageStaffResponse,
  AcceptCoopCoverageOfferResponse,
  CompleteCoopCoverageShiftBody,
  CompleteCoopCoverageShiftResponse,
  CancelCoopCoverageShiftResponse,
  RateCoopCoverageShiftBody,
  RateCoopCoverageShiftResponse,
  GetCoopCoverageLedgerResponse,
} from "@workspace/api-zod";
import { staffLicenseStatus } from "./sos";
import { recordCoverageLaborObligationSafe } from "../lib/coopSettlement";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Co-op staff cross-training & shift coverage — /api/coop/coverage
//
// Accepted, active co-op partners share vetted licensed staff: a short-staffed
// merchant posts an open shift; partners offer eligible staff (verified,
// unexpired, state-matching license + required skill); the poster accepts
// exactly one offer, then completes the shift recording hours and rates the
// covering staff member. Rates are tracked, never settled.
//
// Tenant scope via x-tenant-id (required — coverage has no legacy scope).
// ---------------------------------------------------------------------------

function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Tenant ids of the scoped tenant's current accepted, active partners. */
async function coveragePartnerIdsOf(tenantId: number): Promise<Set<number>> {
  const rows = await db
    .select({
      hostTenantId: merchantCoopPartnershipsTable.hostTenantId,
      partnerTenantId: merchantCoopPartnershipsTable.partnerTenantId,
    })
    .from(merchantCoopPartnershipsTable)
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        eq(merchantCoopPartnershipsTable.isActive, true),
        eq(merchantCoopPartnershipsTable.disputeSuspended, false),
        isNull(merchantCoopPartnershipsTable.bannedAt),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
        )
      )
    );
  return new Set(
    rows.map((r) => (r.hostTenantId === tenantId ? r.partnerTenantId : r.hostTenantId))
  );
}

type StaffRow = typeof sosStaffMembersTable.$inferSelect;

/** Average cross-store rating per staff id, from completed-shift ratings. */
async function ratingAggregates(
  staffIds: number[]
): Promise<Map<number, { average: number; count: number }>> {
  const out = new Map<number, { average: number; count: number }>();
  if (staffIds.length === 0) return out;
  const rows = await db
    .select({
      staffId: coopCoverageRatingsTable.staffId,
      avg: sql<string>`avg(${coopCoverageRatingsTable.rating})`,
      count: sql<number>`count(*)::int`,
    })
    .from(coopCoverageRatingsTable)
    .where(inArray(coopCoverageRatingsTable.staffId, staffIds))
    .groupBy(coopCoverageRatingsTable.staffId);
  for (const r of rows) {
    out.set(r.staffId, { average: Math.round(parseFloat(r.avg) * 10) / 10, count: r.count });
  }
  return out;
}

// ── Serialization ────────────────────────────────────────────────────────────

type OfferJoin = {
  offer: CoopCoverageOffer;
  staff: StaffRow;
  offeringTenantName: string;
};

function serializeOffer(
  j: OfferJoin,
  ratings: Map<number, { average: number; count: number }>
) {
  const agg = ratings.get(j.staff.id);
  return {
    id: j.offer.id,
    shiftId: j.offer.shiftId,
    offeringTenantId: j.offer.offeringTenantId,
    offeringTenantName: j.offeringTenantName,
    staffId: j.staff.id,
    staffName: j.staff.name,
    skills: j.staff.skills,
    licenseState: j.staff.licenseState,
    licenseStatus: staffLicenseStatus(j.staff),
    averageRating: agg?.average ?? null,
    ratingCount: agg?.count ?? 0,
    note: j.offer.note,
    status: j.offer.status,
    createdAt: j.offer.createdAt.toISOString(),
  };
}

function serializeShift(
  shift: CoopCoverageShift,
  tenantName: string,
  viewerTenantId: number,
  offers: OfferJoin[],
  rating: CoopCoverageRating | null,
  ratings: Map<number, { average: number; count: number }>
) {
  const isMine = shift.tenantId === viewerTenantId;
  // Privacy: the poster sees every offer; a partner sees only its own.
  const visible = isMine
    ? offers
    : offers.filter((o) => o.offer.offeringTenantId === viewerTenantId);
  return {
    id: shift.id,
    tenantId: shift.tenantId,
    tenantName,
    startsAt: shift.startsAt.toISOString(),
    endsAt: shift.endsAt.toISOString(),
    requiredSkill: shift.requiredSkill,
    requiredLicenseState: shift.requiredLicenseState,
    offeredHourlyRate: parseFloat(shift.offeredHourlyRate),
    notes: shift.notes,
    status: shift.status,
    acceptedOfferId: shift.acceptedOfferId,
    hoursWorked: shift.hoursWorked == null ? null : parseFloat(shift.hoursWorked),
    isMine,
    offers: visible.map((o) => serializeOffer(o, ratings)),
    rating:
      rating == null
        ? null
        : {
            rating: rating.rating,
            comment: rating.comment,
            createdAt: rating.createdAt.toISOString(),
          },
    createdAt: shift.createdAt.toISOString(),
  };
}

/** Load shifts (with poster names, offers, and ratings) fully serialized for a viewer. */
async function loadShiftsSerialized(
  shiftFilter: ReturnType<typeof and> | ReturnType<typeof eq>,
  viewerTenantId: number
) {
  const shiftRows = await db
    .select({ shift: coopCoverageShiftsTable, tenantName: tenantsTable.brandName })
    .from(coopCoverageShiftsTable)
    .innerJoin(tenantsTable, eq(coopCoverageShiftsTable.tenantId, tenantsTable.id))
    .where(shiftFilter)
    .orderBy(desc(coopCoverageShiftsTable.startsAt), desc(coopCoverageShiftsTable.id));
  const shiftIds = shiftRows.map((r) => r.shift.id);
  if (shiftIds.length === 0) return [];

  const [offerRows, ratingRows] = await Promise.all([
    db
      .select({
        offer: coopCoverageOffersTable,
        staff: sosStaffMembersTable,
        offeringTenantName: tenantsTable.brandName,
      })
      .from(coopCoverageOffersTable)
      .innerJoin(sosStaffMembersTable, eq(coopCoverageOffersTable.staffId, sosStaffMembersTable.id))
      .innerJoin(tenantsTable, eq(coopCoverageOffersTable.offeringTenantId, tenantsTable.id))
      .where(inArray(coopCoverageOffersTable.shiftId, shiftIds))
      .orderBy(coopCoverageOffersTable.id),
    db
      .select()
      .from(coopCoverageRatingsTable)
      .where(inArray(coopCoverageRatingsTable.shiftId, shiftIds)),
  ]);
  const ratings = await ratingAggregates([...new Set(offerRows.map((o) => o.staff.id))]);
  const offersByShift = new Map<number, OfferJoin[]>();
  for (const o of offerRows) {
    const list = offersByShift.get(o.offer.shiftId) ?? [];
    list.push(o);
    offersByShift.set(o.offer.shiftId, list);
  }
  const ratingByShift = new Map(ratingRows.map((r) => [r.shiftId, r]));
  return shiftRows.map((r) =>
    serializeShift(
      r.shift,
      r.tenantName,
      viewerTenantId,
      offersByShift.get(r.shift.id) ?? [],
      ratingByShift.get(r.shift.id) ?? null,
      ratings
    )
  );
}

async function loadOneShiftSerialized(shiftId: number, viewerTenantId: number) {
  const [row] = await loadShiftsSerialized(eq(coopCoverageShiftsTable.id, shiftId), viewerTenantId);
  return row ?? null;
}

// ── GET /coop/coverage/partner-staff — privacy-safe coverage cards ──────────

router.get("/coop/coverage/partner-staff", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const partnerIds = [...(await coveragePartnerIdsOf(tenantId))];
  if (partnerIds.length === 0) {
    res.json(ListCoopCoveragePartnerStaffResponse.parse([]));
    return;
  }
  const rows = await db
    .select({ staff: sosStaffMembersTable, tenantName: tenantsTable.brandName })
    .from(sosStaffMembersTable)
    .innerJoin(tenantsTable, eq(sosStaffMembersTable.tenantId, tenantsTable.id))
    .where(
      and(
        inArray(sosStaffMembersTable.tenantId, partnerIds),
        eq(sosStaffMembersTable.coopCoverageEnabled, true),
        eq(sosStaffMembersTable.isActive, true)
      )
    )
    .orderBy(sosStaffMembersTable.name);
  const ratings = await ratingAggregates(rows.map((r) => r.staff.id));
  res.json(
    ListCoopCoveragePartnerStaffResponse.parse(
      rows.map(({ staff, tenantName }) => {
        const agg = ratings.get(staff.id);
        // Privacy-safe card: name, skills, credentials, rating — never
        // compensation data.
        return {
          staffId: staff.id,
          staffName: staff.name,
          tenantId: staff.tenantId,
          tenantName,
          skills: staff.skills,
          certifications: staff.certifications,
          licenseState: staff.licenseState,
          licenseStatus: staffLicenseStatus(staff),
          averageRating: agg?.average ?? null,
          ratingCount: agg?.count ?? 0,
        };
      })
    )
  );
});

// ── Shift board ──────────────────────────────────────────────────────────────

router.get("/coop/coverage/shifts", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const partnerIds = [...(await coveragePartnerIdsOf(tenantId))];
  // Mine (all statuses) + partners' shifts still accepting offers. Shifts
  // from non-partners are never visible — partner-only broadcast.
  const filter =
    partnerIds.length === 0
      ? eq(coopCoverageShiftsTable.tenantId, tenantId)
      : or(
          eq(coopCoverageShiftsTable.tenantId, tenantId),
          and(
            inArray(coopCoverageShiftsTable.tenantId, partnerIds),
            or(
              inArray(coopCoverageShiftsTable.status, ["open", "offered"]),
              // Partners keep seeing shifts they're involved in (offered on).
              sql`exists (select 1 from ${coopCoverageOffersTable} where ${coopCoverageOffersTable.shiftId} = ${coopCoverageShiftsTable.id} and ${coopCoverageOffersTable.offeringTenantId} = ${tenantId})`
            )
          )
        );
  res.json(ListCoopCoverageShiftsResponse.parse(await loadShiftsSerialized(filter, tenantId)));
});

router.post("/coop/coverage/shifts", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const body = CreateCoopCoverageShiftBody.parse(req.body);
  const startsAt = new Date(body.startsAt);
  const endsAt = new Date(body.endsAt);
  if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || startsAt >= endsAt) {
    res.status(400).json({ message: "A valid shift window is required (start before end)" });
    return;
  }
  // Default the required license state to the posting business's own state —
  // covering staff must be licensed where the work happens.
  let requiredLicenseState = body.requiredLicenseState?.trim().toUpperCase() ?? "";
  if (!requiredLicenseState) {
    const [settings] = await db
      .select({ addressRegion: sosSettingsTable.addressRegion })
      .from(sosSettingsTable)
      .where(eq(sosSettingsTable.tenantId, tenantId));
    requiredLicenseState = settings?.addressRegion.trim().toUpperCase() ?? "";
  }
  if (!requiredLicenseState) {
    res.status(400).json({
      message:
        "No license state on file — set your business state in Configuration or specify one on the shift",
    });
    return;
  }
  const [shift] = await db
    .insert(coopCoverageShiftsTable)
    .values({
      tenantId,
      startsAt,
      endsAt,
      requiredSkill: body.requiredSkill.trim(),
      requiredLicenseState,
      offeredHourlyRate: body.offeredHourlyRate.toFixed(2),
      notes: body.notes?.trim() || null,
    })
    .returning();
  res
    .status(201)
    .json(
      CreateCoopCoverageShiftResponse.parse(await loadOneShiftSerialized(shift.id, tenantId))
    );
});

// ── Offers ───────────────────────────────────────────────────────────────────

/**
 * Why a staff member cannot be offered on a shift, or null when eligible.
 * Mirrored by the UI's eligibility feedback — keep reasons human-readable.
 */
export function coverageIneligibilityReason(
  staff: StaffRow,
  shift: { requiredSkill: string; requiredLicenseState: string }
): string | null {
  if (!staff.isActive) return "This staff member is deactivated.";
  if (!staff.coopCoverageEnabled)
    return "This staff member is not marked available for co-op coverage.";
  const status = staffLicenseStatus(staff);
  if (status === "expired") return "Their license has expired.";
  if (status === "unverified")
    return "Their license has not been verified — verify it in the Staff tab first.";
  if ((staff.licenseState ?? "").toUpperCase() !== shift.requiredLicenseState.toUpperCase())
    return `They are licensed in ${staff.licenseState ?? "no state"}, but this shift requires a ${shift.requiredLicenseState} license.`;
  const skill = shift.requiredSkill.trim().toLowerCase();
  if (!staff.skills.some((s) => s.trim().toLowerCase() === skill))
    return `They don't list the required skill "${shift.requiredSkill}".`;
  return null;
}

router.post("/coop/coverage/shifts/:id/offers", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const shiftId = Number(req.params.id);
  const body = OfferCoopCoverageStaffBody.parse(req.body);
  const [shift] = await db
    .select()
    .from(coopCoverageShiftsTable)
    .where(eq(coopCoverageShiftsTable.id, shiftId));
  // Non-partners must not learn the shift exists.
  const partnerIds = await coveragePartnerIdsOf(tenantId);
  if (!shift || (!partnerIds.has(shift.tenantId) && shift.tenantId !== tenantId)) {
    res.status(404).json({ message: "Shift not found" });
    return;
  }
  if (shift.tenantId === tenantId) {
    res.status(403).json({ message: "You cannot offer staff on your own shift" });
    return;
  }
  if (shift.status !== "open" && shift.status !== "offered") {
    res.status(409).json({ message: "This shift is no longer accepting offers" });
    return;
  }
  const [staff] = await db
    .select()
    .from(sosStaffMembersTable)
    .where(
      and(eq(sosStaffMembersTable.id, body.staffId), eq(sosStaffMembersTable.tenantId, tenantId))
    );
  if (!staff) {
    res.status(404).json({ message: "Staff member not found" });
    return;
  }
  const reason = coverageIneligibilityReason(staff, shift);
  if (reason) {
    res.status(409).json({ message: reason });
    return;
  }
  const [offer] = await db
    .insert(coopCoverageOffersTable)
    .values({
      shiftId,
      offeringTenantId: tenantId,
      staffId: staff.id,
      note: body.note?.trim() || null,
    })
    .onConflictDoNothing()
    .returning();
  if (!offer) {
    res.status(409).json({ message: "This staff member has already been offered on this shift" });
    return;
  }
  // First offer moves the shift open → offered (idempotent conditional).
  await db
    .update(coopCoverageShiftsTable)
    .set({ status: "offered", updatedAt: new Date() })
    .where(and(eq(coopCoverageShiftsTable.id, shiftId), eq(coopCoverageShiftsTable.status, "open")));
  res
    .status(201)
    .json(OfferCoopCoverageStaffResponse.parse(await loadOneShiftSerialized(shiftId, tenantId)));
});

router.post("/coop/coverage/offers/:id/accept", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const offerId = Number(req.params.id);
  const [row] = await db
    .select({ offer: coopCoverageOffersTable, shift: coopCoverageShiftsTable })
    .from(coopCoverageOffersTable)
    .innerJoin(
      coopCoverageShiftsTable,
      eq(coopCoverageOffersTable.shiftId, coopCoverageShiftsTable.id)
    )
    .where(eq(coopCoverageOffersTable.id, offerId));
  if (!row) {
    res.status(404).json({ message: "Offer not found" });
    return;
  }
  if (row.shift.tenantId !== tenantId) {
    res.status(403).json({ message: "Only the posting business can accept offers" });
    return;
  }
  if (row.offer.status !== "pending") {
    res.status(409).json({ message: "This offer is no longer pending" });
    return;
  }
  // Single-winner lock: the conditional claim on the shift row decides the
  // race — only the request that flips accepted_offer_id from NULL wins.
  const [claimed] = await db
    .update(coopCoverageShiftsTable)
    .set({ status: "confirmed", acceptedOfferId: offerId, updatedAt: new Date() })
    .where(
      and(
        eq(coopCoverageShiftsTable.id, row.shift.id),
        inArray(coopCoverageShiftsTable.status, ["open", "offered"]),
        isNull(coopCoverageShiftsTable.acceptedOfferId)
      )
    )
    .returning();
  if (!claimed) {
    res.status(409).json({ message: "Another offer has already been accepted for this shift" });
    return;
  }
  await db
    .update(coopCoverageOffersTable)
    .set({ status: "accepted" })
    .where(eq(coopCoverageOffersTable.id, offerId));
  // Losers are declined so the offering businesses see the outcome.
  await db
    .update(coopCoverageOffersTable)
    .set({ status: "declined" })
    .where(
      and(
        eq(coopCoverageOffersTable.shiftId, row.shift.id),
        eq(coopCoverageOffersTable.status, "pending")
      )
    );
  res.json(
    AcceptCoopCoverageOfferResponse.parse(await loadOneShiftSerialized(row.shift.id, tenantId))
  );
});

// ── Completion / cancellation ────────────────────────────────────────────────

async function ownShift(shiftId: number) {
  const [shift] = await db
    .select()
    .from(coopCoverageShiftsTable)
    .where(eq(coopCoverageShiftsTable.id, shiftId));
  return shift ?? null;
}

router.post("/coop/coverage/shifts/:id/complete", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const shiftId = Number(req.params.id);
  const body = CompleteCoopCoverageShiftBody.parse(req.body);
  const shift = await ownShift(shiftId);
  if (!shift) {
    res.status(404).json({ message: "Shift not found" });
    return;
  }
  if (shift.tenantId !== tenantId) {
    res.status(403).json({ message: "Only the posting business can complete the shift" });
    return;
  }
  const [updated] = await db
    .update(coopCoverageShiftsTable)
    .set({ status: "completed", hoursWorked: body.hoursWorked.toFixed(2), updatedAt: new Date() })
    .where(
      and(eq(coopCoverageShiftsTable.id, shiftId), eq(coopCoverageShiftsTable.status, "confirmed"))
    )
    .returning();
  if (!updated) {
    res.status(409).json({ message: "Only a confirmed shift can be completed" });
    return;
  }
  // Settle the labor charge: the posting business owes the covering business
  // hours × the agreed hourly rate. Idempotent per shift via the ledger's
  // (kind, sourceRef) unique, so a retried completion can never double-bill.
  if (updated.acceptedOfferId != null) {
    const [winning] = await db
      .select({ offeringTenantId: coopCoverageOffersTable.offeringTenantId })
      .from(coopCoverageOffersTable)
      .where(eq(coopCoverageOffersTable.id, updated.acceptedOfferId));
    if (winning) {
      await recordCoverageLaborObligationSafe({
        id: updated.id,
        tenantId: updated.tenantId,
        coveringTenantId: winning.offeringTenantId,
        hoursWorked: body.hoursWorked,
        hourlyRate: parseFloat(updated.offeredHourlyRate),
      });
    }
  }
  res.json(
    CompleteCoopCoverageShiftResponse.parse(await loadOneShiftSerialized(shiftId, tenantId))
  );
});

router.post("/coop/coverage/shifts/:id/cancel", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const shiftId = Number(req.params.id);
  const shift = await ownShift(shiftId);
  if (!shift) {
    res.status(404).json({ message: "Shift not found" });
    return;
  }
  if (shift.tenantId !== tenantId) {
    res.status(403).json({ message: "Only the posting business can cancel the shift" });
    return;
  }
  const [updated] = await db
    .update(coopCoverageShiftsTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(coopCoverageShiftsTable.id, shiftId),
        inArray(coopCoverageShiftsTable.status, ["open", "offered", "confirmed"])
      )
    )
    .returning();
  if (!updated) {
    res.status(409).json({ message: "This shift has already completed or been cancelled" });
    return;
  }
  await db
    .update(coopCoverageOffersTable)
    .set({ status: "declined" })
    .where(
      and(
        eq(coopCoverageOffersTable.shiftId, shiftId),
        eq(coopCoverageOffersTable.status, "pending")
      )
    );
  res.json(CancelCoopCoverageShiftResponse.parse(await loadOneShiftSerialized(shiftId, tenantId)));
});

// ── Ratings ──────────────────────────────────────────────────────────────────

router.post("/coop/coverage/shifts/:id/rating", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const shiftId = Number(req.params.id);
  const body = RateCoopCoverageShiftBody.parse(req.body);
  const shift = await ownShift(shiftId);
  if (!shift) {
    res.status(404).json({ message: "Shift not found" });
    return;
  }
  if (shift.tenantId !== tenantId) {
    res.status(403).json({ message: "Only the posting business can rate the covering staff" });
    return;
  }
  if (shift.status !== "completed" || shift.acceptedOfferId == null) {
    res.status(409).json({ message: "Only a completed shift can be rated" });
    return;
  }
  const [winning] = await db
    .select()
    .from(coopCoverageOffersTable)
    .where(eq(coopCoverageOffersTable.id, shift.acceptedOfferId));
  if (!winning) {
    res.status(409).json({ message: "The accepted offer for this shift no longer exists" });
    return;
  }
  // Unique shift_id column is the one-rating-per-shift lock.
  const [rating] = await db
    .insert(coopCoverageRatingsTable)
    .values({
      shiftId,
      staffId: winning.staffId,
      ratedByTenantId: tenantId,
      rating: body.rating,
      comment: body.comment?.trim() || null,
    })
    .onConflictDoNothing()
    .returning();
  if (!rating) {
    res.status(409).json({ message: "This shift has already been rated" });
    return;
  }
  res
    .status(201)
    .json(RateCoopCoverageShiftResponse.parse(await loadOneShiftSerialized(shiftId, tenantId)));
});

// ── Ledger ───────────────────────────────────────────────────────────────────

router.get("/coop/coverage/ledger", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const posted = await loadShiftsSerialized(
    eq(coopCoverageShiftsTable.tenantId, tenantId),
    tenantId
  );
  // Shifts another business posted where this business offered staff.
  const coveredIds = await db
    .selectDistinct({ shiftId: coopCoverageOffersTable.shiftId })
    .from(coopCoverageOffersTable)
    .where(eq(coopCoverageOffersTable.offeringTenantId, tenantId));
  const covered =
    coveredIds.length === 0
      ? []
      : await loadShiftsSerialized(
          inArray(
            coopCoverageShiftsTable.id,
            coveredIds.map((r) => r.shiftId)
          ),
          tenantId
        );
  res.json(GetCoopCoverageLedgerResponse.parse({ posted, covered }));
});

export default router;
