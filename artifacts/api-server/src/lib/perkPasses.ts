import { randomBytes } from "crypto";
import {
  db,
  perkPassesTable,
  merchantCoopPartnershipsTable,
  sosCustomersTable,
  tenantsTable,
  type PerkPass,
  type MerchantCoopPartnership,
} from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { normalizeToE164 } from "./sms";
import { perkWindowOpen } from "./coopPerks";
import { logger } from "./logger";

// ── Customer perk-pass grant service ─────────────────────────────────────────
// When a visit checks out at a business with accepted+active co-op
// partnerships, each partnership deposits a perk pass into the customer's
// phone-keyed "Local Perks" wallet, automatically and idempotently.

export const PASS_TOKEN_PREFIX = "WPASS-";

/** Default validity window for a granted pass when the perk has no end date. */
export const PASS_VALIDITY_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Unguessable wallet-pass redemption token (encoded in the pass QR). */
export function generatePassToken(): string {
  return `${PASS_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export function isWalletPassToken(code: string): boolean {
  return code.startsWith(PASS_TOKEN_PREFIX);
}

/**
 * The business the customer should visit to redeem a pass: the OTHER side of
 * the partnership relative to the business whose checkout granted it. Falls
 * back to the host side when the granting tenant is unknown.
 */
export function redeemAtSide(
  p: { hostTenantId: number; partnerTenantId: number },
  grantedByTenantId: number | null
): "host" | "partner" {
  return grantedByTenantId === p.hostTenantId ? "partner" : "host";
}

export interface GrantResult {
  granted: number;
  skipped: number;
}

/**
 * Issue perk passes for every accepted+active (window-open) partnership the
 * checkout tenant participates in. Idempotent: a customer never holds two
 * passes for the same partnership while one is still inside its validity
 * window (redeemed or not).
 */
export async function grantPerkPassesForCheckout(opts: {
  tenantId: number | null;
  customerId: number;
  now?: Date;
}): Promise<GrantResult> {
  const now = opts.now ?? new Date();
  // Legacy (NULL-tenant) operations have no co-op context — nothing to grant.
  if (opts.tenantId == null) return { granted: 0, skipped: 0 };

  const [customer] = await db
    .select({ name: sosCustomersTable.name, phone: sosCustomersTable.phone })
    .from(sosCustomersTable)
    .where(eq(sosCustomersTable.id, opts.customerId));
  const phone = normalizeToE164(customer?.phone ?? null);
  // The wallet is keyed by phone — without one there is nowhere to deposit.
  if (!phone) return { granted: 0, skipped: 0 };

  const partnerships = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        eq(merchantCoopPartnershipsTable.isActive, true),
        // Performance-paused partnerships stop granting new wallet passes.
        isNull(merchantCoopPartnershipsTable.performancePausedAt),
        perkWindowOpen(now),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, opts.tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, opts.tenantId)
        )
      )
    );

  let granted = 0;
  let skipped = 0;
  for (const p of partnerships) {
    // Idempotency: any pass for this customer+partnership still inside its
    // validity window blocks a duplicate grant.
    const [existing] = await db
      .select({ id: perkPassesTable.id })
      .from(perkPassesTable)
      .where(
        and(
          eq(perkPassesTable.partnershipId, p.id),
          eq(perkPassesTable.customerPhone, phone),
          gt(perkPassesTable.expiresAt, now)
        )
      )
      .limit(1);
    if (existing) {
      skipped++;
      continue;
    }
    const defaultExpiry = new Date(now.getTime() + PASS_VALIDITY_DAYS * MS_PER_DAY);
    const expiresAt =
      p.perkEndsAt != null && p.perkEndsAt < defaultExpiry ? p.perkEndsAt : defaultExpiry;
    await db.insert(perkPassesTable).values({
      partnershipId: p.id,
      customerPhone: phone,
      customerName: customer?.name ?? null,
      grantedByTenantId: opts.tenantId,
      token: generatePassToken(),
      expiresAt,
    });
    granted++;
  }
  return { granted, skipped };
}

/**
 * Like `grantPerkPassesForCheckout`, but guaranteed not to throw: perk
 * granting must never block or fail a checkout.
 */
export async function grantPerkPassesSafe(opts: {
  tenantId: number | null;
  customerId: number;
}): Promise<GrantResult> {
  try {
    return await grantPerkPassesForCheckout(opts);
  } catch (err) {
    logger.error(
      { err, tenantId: opts.tenantId, customerId: opts.customerId },
      "Perk pass grant failed; checkout continues unaffected"
    );
    return { granted: 0, skipped: 0 };
  }
}

// ── Wallet-pass lookup for redemption ────────────────────────────────────────

export interface WalletPassRow {
  pass: PerkPass;
  partnership: MerchantCoopPartnership;
  hostTenantName: string;
  partnerTenantName: string;
}

/** Load a wallet pass by its token, joined with its partnership + names. */
export async function findWalletPass(token: string): Promise<WalletPassRow | null> {
  const hostTenant = alias(tenantsTable, "pass_host_tenant");
  const partnerTenant = alias(tenantsTable, "pass_partner_tenant");
  const [row] = await db
    .select({
      pass: perkPassesTable,
      partnership: merchantCoopPartnershipsTable,
      hostTenantName: hostTenant.brandName,
      partnerTenantName: partnerTenant.brandName,
    })
    .from(perkPassesTable)
    .innerJoin(
      merchantCoopPartnershipsTable,
      eq(perkPassesTable.partnershipId, merchantCoopPartnershipsTable.id)
    )
    .innerJoin(hostTenant, eq(merchantCoopPartnershipsTable.hostTenantId, hostTenant.id))
    .innerJoin(partnerTenant, eq(merchantCoopPartnershipsTable.partnerTenantId, partnerTenant.id))
    .where(eq(perkPassesTable.token, token));
  return row ?? null;
}
