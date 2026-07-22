import { db, sosSettingsTable, tenantsTable } from "@workspace/db";
import { eq, isNull } from "drizzle-orm";
import { getSmsStatus, getTwilioAuthToken } from "./sms";
import { getInboundWebhookUrl } from "./inboundSms";

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

/** Serialize a settings row into the SosSettings API shape. */
export async function serializeSettings(s: SosSettingsRow) {
  const sms = await getSmsStatus(s.tenantId);
  return {
    id: s.id,
    tenantId: s.tenantId,
    businessName: s.businessName,
    industryType: s.industryType,
    resourceLabel: s.resourceLabel,
    aiReceptionistEnabled: s.aiReceptionistEnabled,
    waitlistAutoFillEnabled: s.waitlistAutoFillEnabled,
    smsFromNumber: s.smsFromNumber,
    serviceNames: s.serviceNames ?? "",
    smsMode: sms.smsMode,
    smsActiveFromNumber: sms.activeFromNumber,
    smsInboundWebhookUrl: getInboundWebhookUrl(),
    smsInboundReady: (await getTwilioAuthToken()) != null,
    updatedAt: s.updatedAt.toISOString(),
  };
}
