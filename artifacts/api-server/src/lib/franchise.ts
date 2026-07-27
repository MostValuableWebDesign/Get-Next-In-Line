import { randomBytes } from "crypto";
import {
  db,
  franchiseOrgsTable,
  franchiseRegionsTable,
  franchiseStorefrontsTable,
  franchiseRolesTable,
  franchisePerkTemplatesTable,
  franchiseTemplateDeploymentsTable,
  merchantCoopPartnershipsTable,
  sosSettingsTable,
  type FranchiseOrg,
  type FranchiseRole,
  type FranchisePerkTemplate,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Request } from "express";
import { sessionIsPlatformAdmin } from "../middlewares/tenantAccess";
import { logger } from "./logger";
import { generateTrackingCode } from "./coopTracking";

// ---------------------------------------------------------------------------
// Franchise Co-Op Controller — hierarchy permissions & template propagation.
//
// Roles are strictly org-scoped (NOT platform RBAC):
// - super_admin        → the whole org
// - regional_manager   → storefronts in their region
// - storefront_operator→ one location
// Platform admins act as super admins of every org (they already see
// everything through the admin console).
// ---------------------------------------------------------------------------

export type FranchiseRoleName =
  | "super_admin"
  | "regional_manager"
  | "storefront_operator";

export interface OrgRoleContext {
  role: FranchiseRoleName;
  /** Region scope for regional managers, null otherwise. */
  regionId: number | null;
  /** Storefront scope for operators, null otherwise. */
  tenantId: number | null;
}

/** Resolve the caller's role within an org; null = no access at all. */
export async function resolveOrgRole(
  req: Request,
  orgId: number,
): Promise<OrgRoleContext | null> {
  if (sessionIsPlatformAdmin(req)) {
    return { role: "super_admin", regionId: null, tenantId: null };
  }
  const userId = req.session.userId;
  if (userId == null) return null;
  const [row] = await db
    .select()
    .from(franchiseRolesTable)
    .where(and(eq(franchiseRolesTable.orgId, orgId), eq(franchiseRolesTable.userId, userId)));
  if (!row) return null;
  return {
    role: row.role as FranchiseRoleName,
    regionId: row.regionId,
    tenantId: row.tenantId,
  };
}

/**
 * The storefront tenant ids the caller may see/act on within the org:
 * super admins → every storefront, regional managers → their region's,
 * operators → their single location.
 */
export async function scopedStorefrontTenantIds(
  orgId: number,
  ctx: OrgRoleContext,
): Promise<number[]> {
  const conditions = [eq(franchiseStorefrontsTable.orgId, orgId)];
  if (ctx.role === "regional_manager") {
    if (ctx.regionId == null) return [];
    conditions.push(eq(franchiseStorefrontsTable.regionId, ctx.regionId));
  } else if (ctx.role === "storefront_operator") {
    if (ctx.tenantId == null) return [];
    conditions.push(eq(franchiseStorefrontsTable.tenantId, ctx.tenantId));
  }
  const rows = await db
    .select({ tenantId: franchiseStorefrontsTable.tenantId })
    .from(franchiseStorefrontsTable)
    .where(and(...conditions));
  return rows.map((r) => r.tenantId);
}

export async function getOrg(orgId: number): Promise<FranchiseOrg | null> {
  if (!Number.isInteger(orgId) || orgId <= 0) return null;
  const [org] = await db
    .select()
    .from(franchiseOrgsTable)
    .where(eq(franchiseOrgsTable.id, orgId));
  return org ?? null;
}

/** Normalized 5-digit-style postal code comparison key (trimmed prefix). */
export function normalizePostal(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  return v.split("-")[0].toUpperCase();
}

/** Stored postal code for a tenant (from its settings row), normalized. */
export async function tenantPostalCode(tenantId: number): Promise<string | null> {
  const [row] = await db
    .select({ postalCode: sosSettingsTable.postalCode })
    .from(sosSettingsTable)
    .where(eq(sosSettingsTable.tenantId, tenantId));
  return normalizePostal(row?.postalCode);
}

// ── Template propagation engine ─────────────────────────────────────────────

function generateFranchiseCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `FRAN-${out}`;
}

/**
 * Fan the template out to every in-scope storefront as a live co-op perk —
 * a self-scoped partnership row (host === partner === storefront) that
 * surfaces through the existing /coop/perks endpoint. Idempotent: the
 * unique (template, tenant) deployment row is the lock; re-deploying
 * refreshes title/terms and reactivates retired rows.
 */
export async function propagateTemplate(template: FranchisePerkTemplate): Promise<void> {
  const storefronts = await db
    .select({ tenantId: franchiseStorefrontsTable.tenantId })
    .from(franchiseStorefrontsTable)
    .where(eq(franchiseStorefrontsTable.orgId, template.orgId));
  const deployments = await db
    .select()
    .from(franchiseTemplateDeploymentsTable)
    .where(eq(franchiseTemplateDeploymentsTable.templateId, template.id));
  const byTenant = new Map(deployments.map((d) => [d.tenantId, d]));
  const retired = template.status === "retired";
  const now = new Date();

  for (const { tenantId } of storefronts) {
    const existing = byTenant.get(tenantId);
    if (existing) {
      if (existing.partnershipId != null) {
        await db
          .update(merchantCoopPartnershipsTable)
          .set({
            perkTitle: template.title,
            perkDescription: template.redemptionTerms,
            isActive: !retired,
            updatedAt: now,
          })
          .where(eq(merchantCoopPartnershipsTable.id, existing.partnershipId));
      }
      await db
        .update(franchiseTemplateDeploymentsTable)
        .set({ status: retired ? "retired" : "deployed", updatedAt: now })
        .where(eq(franchiseTemplateDeploymentsTable.id, existing.id));
      continue;
    }
    if (retired) continue; // never deploy a retired template to new locations
    // Bounded retry on redemption-code collisions (random, rare).
    let partnershipId: number | null = null;
    for (let attempt = 0; attempt < 5 && partnershipId == null; attempt++) {
      try {
        const [created] = await db
          .insert(merchantCoopPartnershipsTable)
          .values({
            hostTenantId: tenantId,
            partnerTenantId: tenantId,
            perkTitle: template.title,
            perkDescription: template.redemptionTerms,
            redemptionCode: generateFranchiseCode(),
            // Invariant: every new partnership row gets its direction-aware
            // tracking codes at insert time (self-pairs included).
            hostTrackingCode: generateTrackingCode(),
            partnerTrackingCode: generateTrackingCode(),
            status: "accepted",
            isActive: true,
          })
          .returning({ id: merchantCoopPartnershipsTable.id });
        partnershipId = created.id;
      } catch (err) {
        const code =
          (err as { code?: string }).code ??
          (err as { cause?: { code?: string } }).cause?.code;
        if (code !== "23505") throw err;
      }
    }
    if (partnershipId == null) {
      logger.error(
        { templateId: template.id, tenantId },
        "Franchise template deploy: could not generate a unique redemption code",
      );
      continue;
    }
    await db
      .insert(franchiseTemplateDeploymentsTable)
      .values({ templateId: template.id, tenantId, partnershipId, status: "deployed" })
      .onConflictDoNothing();
  }
}

/**
 * When a storefront is detached from the org, retire every template-derived
 * perk at that location so franchise perks stop serving immediately.
 */
export async function retireDeploymentsForTenant(
  orgId: number,
  tenantId: number,
): Promise<void> {
  const rows = await db
    .select({
      id: franchiseTemplateDeploymentsTable.id,
      partnershipId: franchiseTemplateDeploymentsTable.partnershipId,
    })
    .from(franchiseTemplateDeploymentsTable)
    .innerJoin(
      franchisePerkTemplatesTable,
      eq(franchiseTemplateDeploymentsTable.templateId, franchisePerkTemplatesTable.id),
    )
    .where(
      and(
        eq(franchisePerkTemplatesTable.orgId, orgId),
        eq(franchiseTemplateDeploymentsTable.tenantId, tenantId),
      ),
    );
  const partnershipIds = rows
    .map((r) => r.partnershipId)
    .filter((x): x is number => x != null);
  if (partnershipIds.length > 0) {
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ isActive: false, updatedAt: new Date() })
      .where(inArray(merchantCoopPartnershipsTable.id, partnershipIds));
  }
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await db
      .update(franchiseTemplateDeploymentsTable)
      .set({ status: "retired", updatedAt: new Date() })
      .where(inArray(franchiseTemplateDeploymentsTable.id, ids));
  }
}

/** Deploy every active template of the org to a newly attached storefront. */
export async function deployActiveTemplatesToTenant(orgId: number): Promise<void> {
  const templates = await db
    .select()
    .from(franchisePerkTemplatesTable)
    .where(
      and(
        eq(franchisePerkTemplatesTable.orgId, orgId),
        eq(franchisePerkTemplatesTable.status, "active"),
      ),
    );
  for (const t of templates) await propagateTemplate(t);
}
