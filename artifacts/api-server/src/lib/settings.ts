import { db, sosSettingsTable, tenantsTable } from "@workspace/db";
import { eq, isNull } from "drizzle-orm";
import { getSmsStatus, getTwilioAuthToken } from "./sms";
import { getInboundWebhookUrl } from "./inboundSms";
import { effectiveSubCategory } from "./coopFirewall";
import { effectiveCoopRadiusMiles } from "./geoDensity";

export type SosSettingsRow = typeof sosSettingsTable.$inferSelect;

/**
 * Per-tenant settings resolution.
 *
 * Settings rows are keyed by tenant_id. The row with tenant_id NULL is the
 * legacy/global record that pre-dates per-tenant settings; it keeps backing
 * the legacy /api/sos/settings endpoints and any SOS-domain behavior that has
 * no tenant context (SOS operational tables are not tenant-scoped yet).
 */

/** Legacy/global settings record (tenant_id NULL). Created on first access. */
export async function getLegacySettings(): Promise<SosSettingsRow> {
  const [existing] = await db
    .select()
    .from(sosSettingsTable)
    .where(isNull(sosSettingsTable.tenantId))
    .orderBy(sosSettingsTable.id)
    .limit(1);
  if (existing) return existing;
  const [created] = await db.insert(sosSettingsTable).values({}).returning();
  return created;
}

/**
 * A tenant's settings record, created on first access (seeded with the
 * tenant's brand name). Returns null when the tenant does not exist.
 */
export async function getSettingsForTenant(
  tenantId: number,
): Promise<SosSettingsRow | null> {
  const [tenant] = await db
    .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  if (!tenant) return null;

  const [existing] = await db
    .select()
    .from(sosSettingsTable)
    .where(eq(sosSettingsTable.tenantId, tenantId))
    .limit(1);
  if (existing) return existing;

  // Race-safe under the tenant_id unique constraint.
  const [created] = await db
    .insert(sosSettingsTable)
    .values({ tenantId, businessName: tenant.brandName })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [row] = await db
    .select()
    .from(sosSettingsTable)
    .where(eq(sosSettingsTable.tenantId, tenantId))
    .limit(1);
  return row ?? null;
}

/**
 * Settings for an optional tenant context — the tenant's record when a
 * tenant id is provided, otherwise the legacy/global record.
 */
export async function resolveSettings(
  tenantId?: number | null,
): Promise<SosSettingsRow> {
  if (tenantId != null) {
    const settings = await getSettingsForTenant(tenantId);
    if (settings) return settings;
  }
  return getLegacySettings();
}

/**
 * Convert an API settings-update body into column values: numeric policy
 * amounts arrive as numbers but are stored as numeric strings.
 */
export function toSettingsColumnUpdates<
  T extends {
    noShowDepositAmount?: number;
    noShowFee?: number;
    coopRadiusOverrideMiles?: number | null;
    latitude?: string;
    longitude?: string;
    openTime?: string;
    closeTime?: string;
  },
>(body: T): Omit<T, "noShowDepositAmount" | "noShowFee" | "coopRadiusOverrideMiles"> &
  Partial<
    Pick<
      typeof sosSettingsTable.$inferInsert,
      | "noShowDepositAmount"
      | "noShowFee"
      | "coopRadiusOverrideMiles"
      | "coordinatesSource"
      | "hoursConfirmedAt"
    >
  > {
  const { noShowDepositAmount, noShowFee, coopRadiusOverrideMiles, ...rest } = body;
  // Explicitly typed lat/lng mark the coordinates as manual — automatic
  // geocoding must never overwrite them. Clearing both reverts to auto.
  const latProvided = body.latitude !== undefined;
  const lngProvided = body.longitude !== undefined;
  const coordsTouched = latProvided || lngProvided;
  const coordsNonEmpty =
    (body.latitude ?? "").trim() !== "" || (body.longitude ?? "").trim() !== "";
  return {
    ...rest,
    ...(noShowDepositAmount != null
      ? { noShowDepositAmount: noShowDepositAmount.toFixed(2) }
      : {}),
    ...(noShowFee != null ? { noShowFee: noShowFee.toFixed(2) } : {}),
    ...(coopRadiusOverrideMiles !== undefined
      ? {
          coopRadiusOverrideMiles:
            coopRadiusOverrideMiles == null ? null : coopRadiusOverrideMiles.toFixed(1),
        }
      : {}),
    ...(coordsTouched ? { coordinatesSource: coordsNonEmpty ? "manual" : "" } : {}),
    // Saving open/close hours confirms them — the "confirm your hours"
    // first-run onboarding step checks off on the first such save.
    ...(body.openTime !== undefined || body.closeTime !== undefined
      ? { hoursConfirmedAt: new Date() }
      : {}),
  };
}

/** True when a settings-update body touches any address or coordinate field. */
export function addressFieldsTouched(body: {
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  latitude?: string;
  longitude?: string;
}): boolean {
  return (
    body.streetAddress !== undefined ||
    body.addressLocality !== undefined ||
    body.addressRegion !== undefined ||
    body.postalCode !== undefined ||
    body.latitude !== undefined ||
    body.longitude !== undefined
  );
}

/** Serialize a settings row into the SosSettings API shape. */
export async function serializeSettings(s: SosSettingsRow) {
  // Imported lazily to avoid a settings ↔ noShowShield module cycle.
  const { isNoShowShieldProvisioned } = await import("./noShowShield");
  const [sms, noShowShieldProvisioned] = await Promise.all([
    getSmsStatus(s.tenantId),
    isNoShowShieldProvisioned(s.tenantId),
  ]);
  return {
    id: s.id,
    tenantId: s.tenantId,
    businessName: s.businessName,
    industryType: s.industryType,
    resourceLabel: s.resourceLabel,
    openTime: s.openTime,
    closeTime: s.closeTime,
    aiReceptionistEnabled: s.aiReceptionistEnabled,
    waitlistAutoFillEnabled: s.waitlistAutoFillEnabled,
    smsFromNumber: s.smsFromNumber,
    serviceNames: s.serviceNames ?? "",
    smsMode: sms.smsMode,
    smsActiveFromNumber: sms.activeFromNumber,
    smsInboundWebhookUrl: getInboundWebhookUrl(),
    smsInboundReady: (await getTwilioAuthToken()) != null,
    noShowShieldEnabled: s.noShowShieldEnabled,
    noShowShieldProvisioned,
    noShowDepositAmount: parseFloat(s.noShowDepositAmount),
    noShowCancellationWindowHours: s.noShowCancellationWindowHours,
    noShowFee: parseFloat(s.noShowFee),
    defaultCycleDays: s.defaultCycleDays,
    seoDescription: s.seoDescription,
    publicPhone: s.publicPhone,
    streetAddress: s.streetAddress,
    addressLocality: s.addressLocality,
    addressRegion: s.addressRegion,
    postalCode: s.postalCode,
    latitude: s.latitude,
    longitude: s.longitude,
    businessCategory: s.businessCategory,
    coopSubCategory: effectiveSubCategory(s).subCategory ?? "",
    coopRadiusMiles: s.coopRadiusMiles,
    densityClassification: s.densityClassification,
    coopRadiusAutoMiles: parseFloat(s.coopRadiusAutoMiles),
    coopRadiusOverrideMiles:
      s.coopRadiusOverrideMiles != null ? parseFloat(s.coopRadiusOverrideMiles) : null,
    coopRadiusEffectiveMiles: effectiveCoopRadiusMiles(s),
    coopReciprocityMarginPercent: s.coopReciprocityMarginPercent,
    coopReciprocityWindowDays: s.coopReciprocityWindowDays,
    brandLogoUrl: s.brandLogoUrl,
    brandPrimaryColor: s.brandPrimaryColor,
    brandSecondaryColor: s.brandSecondaryColor,
    updatedAt: s.updatedAt.toISOString(),
  };
}
