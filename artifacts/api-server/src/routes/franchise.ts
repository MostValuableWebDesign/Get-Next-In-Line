import { Router, type IRouter } from "express";
import {
  db,
  franchiseOrgsTable,
  franchiseRegionsTable,
  franchiseStorefrontsTable,
  franchiseRolesTable,
  franchisePerkTemplatesTable,
  franchiseTemplateDeploymentsTable,
  franchisePartnershipRequestsTable,
  merchantCoopPartnershipsTable,
  coopEventsTable,
  coopPerkRedemptionsTable,
  platformLedgerEntriesTable,
  tenantsTable,
  usersTable,
  userTenantMembershipsTable,
  sosSettingsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  ListFranchiseOrgsResponse,
  CreateFranchiseOrgBody,
  CreateFranchiseOrgResponse,
  GetFranchiseOrgResponse,
  UpdateFranchiseOrgBody,
  UpdateFranchiseOrgResponse,
  CreateFranchiseRegionBody,
  CreateFranchiseRegionResponse,
  AttachFranchiseStorefrontBody,
  AttachFranchiseStorefrontResponse,
  UpdateFranchiseStorefrontBody,
  UpdateFranchiseStorefrontResponse,
  ListFranchiseRolesResponse,
  AssignFranchiseRoleBody,
  AssignFranchiseRoleResponse,
  ListFranchiseTemplatesResponse,
  CreateFranchiseTemplateBody,
  CreateFranchiseTemplateResponse,
  UpdateFranchiseTemplateBody,
  UpdateFranchiseTemplateResponse,
  ListFranchiseRequestsResponse,
  CreateFranchiseRequestBody,
  CreateFranchiseRequestResponse,
  DecideFranchiseRequestBody,
  DecideFranchiseRequestResponse,
  GetFranchiseRollupResponse,
} from "@workspace/api-zod";
import { sessionIsPlatformAdmin } from "../middlewares/tenantAccess";
import {
  loadCoopProfiles,
  isolationPartnersOf,
  isBlockedPair,
} from "../lib/coopFirewall";
import { generateTrackingCode } from "../lib/coopTracking";
import {
  resolveOrgRole,
  scopedStorefrontTenantIds,
  getOrg,
  tenantPostalCode,
  propagateTemplate,
  retireDeploymentsForTenant,
  deployActiveTemplatesToTenant,
  type OrgRoleContext,
} from "../lib/franchise";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Multi-Location & Enterprise Franchise Co-Op Controller.
// All routes here are org-scoped: the caller's role inside the org (or
// platform-admin status) decides what they may see and do — see
// lib/franchise.ts. Tenants outside any org never hit these code paths and
// existing single-tenant co-op behavior is untouched.
// ---------------------------------------------------------------------------

function orgIdFrom(req: { params: Record<string, string> }): number {
  const n = Number(req.params.orgId);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function pgCode(err: unknown): string | undefined {
  return (
    (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code
  );
}

/** Load org + caller role; writes the error response itself when denied. */
async function requireOrgRole(
  req: Parameters<typeof resolveOrgRole>[0],
  res: { status: (n: number) => { json: (b: unknown) => void } },
  opts: { superAdminOnly?: boolean } = {},
): Promise<{ org: NonNullable<Awaited<ReturnType<typeof getOrg>>>; ctx: OrgRoleContext } | null> {
  const orgId = orgIdFrom(req as { params: Record<string, string> });
  const org = await getOrg(orgId);
  if (!org) {
    res.status(404).json({ message: "Organization not found" });
    return null;
  }
  const ctx = await resolveOrgRole(req, org.id);
  if (!ctx) {
    res.status(403).json({ message: "You have no role in this organization" });
    return null;
  }
  if (opts.superAdminOnly && ctx.role !== "super_admin") {
    res.status(403).json({ message: "This operation requires the organization Super Admin" });
    return null;
  }
  return { org, ctx };
}

const storefrontRows = () =>
  db
    .select({
      storefront: franchiseStorefrontsTable,
      tenantName: tenantsTable.brandName,
      postalCode: sosSettingsTable.postalCode,
    })
    .from(franchiseStorefrontsTable)
    .innerJoin(tenantsTable, eq(franchiseStorefrontsTable.tenantId, tenantsTable.id))
    .leftJoin(sosSettingsTable, eq(sosSettingsTable.tenantId, franchiseStorefrontsTable.tenantId));

function serializeStorefront(row: {
  storefront: typeof franchiseStorefrontsTable.$inferSelect;
  tenantName: string;
  postalCode: string | null;
}) {
  return {
    id: row.storefront.id,
    orgId: row.storefront.orgId,
    tenantId: row.storefront.tenantId,
    tenantName: row.tenantName,
    regionId: row.storefront.regionId,
    postalCode: row.postalCode,
  };
}

// ── Orgs ─────────────────────────────────────────────────────────────────────

router.get("/franchise/orgs", async (req, res): Promise<void> => {
  if (sessionIsPlatformAdmin(req)) {
    const orgs = await db.select().from(franchiseOrgsTable).orderBy(desc(franchiseOrgsTable.id));
    res.json(
      ListFranchiseOrgsResponse.parse(
        orgs.map((o) => ({
          id: o.id,
          name: o.name,
          autonomyPolicy: o.autonomyPolicy,
          myRole: "super_admin",
          createdAt: o.createdAt.toISOString(),
        })),
      ),
    );
    return;
  }
  const userId = req.session.userId;
  if (userId == null) {
    res.json(ListFranchiseOrgsResponse.parse([]));
    return;
  }
  const rows = await db
    .select({ org: franchiseOrgsTable, role: franchiseRolesTable.role })
    .from(franchiseRolesTable)
    .innerJoin(franchiseOrgsTable, eq(franchiseRolesTable.orgId, franchiseOrgsTable.id))
    .where(eq(franchiseRolesTable.userId, userId))
    .orderBy(desc(franchiseOrgsTable.id));
  res.json(
    ListFranchiseOrgsResponse.parse(
      rows.map((r) => ({
        id: r.org.id,
        name: r.org.name,
        autonomyPolicy: r.org.autonomyPolicy,
        myRole: r.role,
        createdAt: r.org.createdAt.toISOString(),
      })),
    ),
  );
});

router.post("/franchise/orgs", async (req, res): Promise<void> => {
  const parsed = CreateFranchiseOrgBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const [org] = await db
    .insert(franchiseOrgsTable)
    .values({ name: parsed.data.name.trim() })
    .returning();
  // The creating user becomes the org's Super Admin (platform admins already
  // act as super admins everywhere and need no role row).
  let myRole = "super_admin";
  const userId = req.session.userId;
  if (!sessionIsPlatformAdmin(req) && userId != null) {
    await db
      .insert(franchiseRolesTable)
      .values({ orgId: org.id, userId, role: "super_admin" });
  }
  res.status(201).json(
    CreateFranchiseOrgResponse.parse({
      id: org.id,
      name: org.name,
      autonomyPolicy: org.autonomyPolicy,
      myRole,
      createdAt: org.createdAt.toISOString(),
    }),
  );
});

router.get("/franchise/orgs/:orgId", async (req, res): Promise<void> => {
  const access = await requireOrgRole(req, res);
  if (!access) return;
  const { org, ctx } = access;
  const scopedIds = await scopedStorefrontTenantIds(org.id, ctx);
  const regions = await db
    .select()
    .from(franchiseRegionsTable)
    .where(eq(franchiseRegionsTable.orgId, org.id))
    .orderBy(franchiseRegionsTable.name);
  const storefronts =
    scopedIds.length === 0
      ? []
      : await storefrontRows().where(
          and(
            eq(franchiseStorefrontsTable.orgId, org.id),
            inArray(franchiseStorefrontsTable.tenantId, scopedIds),
          ),
        );
  res.json(
    GetFranchiseOrgResponse.parse({
      id: org.id,
      name: org.name,
      autonomyPolicy: org.autonomyPolicy,
      myRole: ctx.role,
      regions: regions.map((r) => ({ id: r.id, orgId: r.orgId, name: r.name })),
      storefronts: storefronts.map(serializeStorefront),
    }),
  );
});

router.patch("/franchise/orgs/:orgId", async (req, res): Promise<void> => {
  const access = await requireOrgRole(req, res, { superAdminOnly: true });
  if (!access) return;
  const parsed = UpdateFranchiseOrgBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const updates: Partial<{ name: string; autonomyPolicy: string; updatedAt: Date }> = {
    updatedAt: new Date(),
  };
  if (parsed.data.name != null) updates.name = parsed.data.name.trim();
  if (parsed.data.autonomyPolicy != null) updates.autonomyPolicy = parsed.data.autonomyPolicy;
  const [org] = await db
    .update(franchiseOrgsTable)
    .set(updates)
    .where(eq(franchiseOrgsTable.id, access.org.id))
    .returning();
  res.json(
    UpdateFranchiseOrgResponse.parse({
      id: org.id,
      name: org.name,
      autonomyPolicy: org.autonomyPolicy,
      myRole: access.ctx.role,
      createdAt: org.createdAt.toISOString(),
    }),
  );
});

// ── Regions ──────────────────────────────────────────────────────────────────

router.post("/franchise/orgs/:orgId/regions", async (req, res): Promise<void> => {
  const access = await requireOrgRole(req, res, { superAdminOnly: true });
  if (!access) return;
  const parsed = CreateFranchiseRegionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
    return;
  }
  try {
    const [region] = await db
      .insert(franchiseRegionsTable)
      .values({ orgId: access.org.id, name: parsed.data.name.trim() })
      .returning();
    res
      .status(201)
      .json(
        CreateFranchiseRegionResponse.parse({ id: region.id, orgId: region.orgId, name: region.name }),
      );
  } catch (err) {
    if (pgCode(err) === "23505") {
      res.status(409).json({ message: "A region with that name already exists" });
      return;
    }
    throw err;
  }
});

// ── Storefronts ──────────────────────────────────────────────────────────────

router.post("/franchise/orgs/:orgId/storefronts", async (req, res): Promise<void> => {
  const access = await requireOrgRole(req, res, { superAdminOnly: true });
  if (!access) return;
  const parsed = AttachFranchiseStorefrontBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const { storefrontTenantId, regionId } = parsed.data;
  const [tenant] = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, storefrontTenantId));
  if (!tenant) {
    res.status(404).json({ message: "Tenant not found" });
    return;
  }
  // Proof of control: attaching a tenant puts it under org governance
  // (template perks, autonomy policy, roll-up visibility), so a non-platform-
  // admin caller must be a member of that tenant. Org super-admin status
  // alone is NOT enough — otherwise any user could bootstrap an org and
  // seize control of arbitrary businesses.
  if (!sessionIsPlatformAdmin(req)) {
    const userId = req.session.userId;
    const [membership] =
      userId == null
        ? []
        : await db
            .select({ id: userTenantMembershipsTable.id })
            .from(userTenantMembershipsTable)
            .where(
              and(
                eq(userTenantMembershipsTable.userId, userId),
                eq(userTenantMembershipsTable.tenantId, storefrontTenantId),
              ),
            );
    if (!membership) {
      res.status(403).json({
        message: "You can only attach businesses you belong to",
      });
      return;
    }
  }
  if (regionId != null) {
    const [region] = await db
      .select({ id: franchiseRegionsTable.id })
      .from(franchiseRegionsTable)
      .where(
        and(eq(franchiseRegionsTable.id, regionId), eq(franchiseRegionsTable.orgId, access.org.id)),
      );
    if (!region) {
      res.status(404).json({ message: "Region not found in this organization" });
      return;
    }
  }
  try {
    await db
      .insert(franchiseStorefrontsTable)
      .values({ orgId: access.org.id, tenantId: storefrontTenantId, regionId: regionId ?? null });
  } catch (err) {
    if (pgCode(err) === "23505") {
      res.status(409).json({ message: "This tenant already belongs to an organization" });
      return;
    }
    throw err;
  }
  // Newly attached storefronts automatically receive every active template.
  await deployActiveTemplatesToTenant(access.org.id);
  const [row] = await storefrontRows().where(
    and(
      eq(franchiseStorefrontsTable.orgId, access.org.id),
      eq(franchiseStorefrontsTable.tenantId, storefrontTenantId),
    ),
  );
  res.status(201).json(AttachFranchiseStorefrontResponse.parse(serializeStorefront(row)));
});

router.patch(
  "/franchise/orgs/:orgId/storefronts/:tenantId",
  async (req, res): Promise<void> => {
    const access = await requireOrgRole(req, res, { superAdminOnly: true });
    if (!access) return;
    const parsed = UpdateFranchiseStorefrontBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
      return;
    }
    const tenantId = Number(req.params.tenantId);
    const regionId = parsed.data.regionId ?? null;
    if (regionId != null) {
      const [region] = await db
        .select({ id: franchiseRegionsTable.id })
        .from(franchiseRegionsTable)
        .where(
          and(eq(franchiseRegionsTable.id, regionId), eq(franchiseRegionsTable.orgId, access.org.id)),
        );
      if (!region) {
        res.status(404).json({ message: "Region not found in this organization" });
        return;
      }
    }
    const [updated] = await db
      .update(franchiseStorefrontsTable)
      .set({ regionId })
      .where(
        and(
          eq(franchiseStorefrontsTable.orgId, access.org.id),
          eq(franchiseStorefrontsTable.tenantId, tenantId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ message: "Storefront not found" });
      return;
    }
    const [row] = await storefrontRows().where(eq(franchiseStorefrontsTable.id, updated.id));
    res.json(UpdateFranchiseStorefrontResponse.parse(serializeStorefront(row)));
  },
);

router.delete(
  "/franchise/orgs/:orgId/storefronts/:tenantId",
  async (req, res): Promise<void> => {
    const access = await requireOrgRole(req, res, { superAdminOnly: true });
    if (!access) return;
    const tenantId = Number(req.params.tenantId);
    const [removed] = await db
      .delete(franchiseStorefrontsTable)
      .where(
        and(
          eq(franchiseStorefrontsTable.orgId, access.org.id),
          eq(franchiseStorefrontsTable.tenantId, tenantId),
        ),
      )
      .returning();
    if (!removed) {
      res.status(404).json({ message: "Storefront not found" });
      return;
    }
    await retireDeploymentsForTenant(access.org.id, tenantId);
    res.status(204).end();
  },
);

// ── Roles ────────────────────────────────────────────────────────────────────

router.get("/franchise/orgs/:orgId/roles", async (req, res): Promise<void> => {
  const access = await requireOrgRole(req, res, { superAdminOnly: true });
  if (!access) return;
  const rows = await db
    .select({ role: franchiseRolesTable, username: usersTable.username })
    .from(franchiseRolesTable)
    .innerJoin(usersTable, eq(franchiseRolesTable.userId, usersTable.id))
    .where(eq(franchiseRolesTable.orgId, access.org.id))
    .orderBy(franchiseRolesTable.id);
  res.json(
    ListFranchiseRolesResponse.parse(
      rows.map((r) => ({
        id: r.role.id,
        orgId: r.role.orgId,
        userId: r.role.userId,
        username: r.username,
        role: r.role.role,
        regionId: r.role.regionId,
        tenantId: r.role.tenantId,
      })),
    ),
  );
});

router.post("/franchise/orgs/:orgId/roles", async (req, res): Promise<void> => {
  const access = await requireOrgRole(req, res, { superAdminOnly: true });
  if (!access) return;
  const parsed = AssignFranchiseRoleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const { userId, role, regionId, tenantId } = parsed.data;
  if (role === "regional_manager" && regionId == null) {
    res.status(400).json({ message: "regionId is required for a Regional Manager" });
    return;
  }
  if (role === "storefront_operator" && tenantId == null) {
    res.status(400).json({ message: "tenantId is required for a Storefront Operator" });
    return;
  }
  if (regionId != null) {
    const [region] = await db
      .select({ id: franchiseRegionsTable.id })
      .from(franchiseRegionsTable)
      .where(
        and(eq(franchiseRegionsTable.id, regionId), eq(franchiseRegionsTable.orgId, access.org.id)),
      );
    if (!region) {
      res.status(404).json({ message: "Region not found in this organization" });
      return;
    }
  }
  if (tenantId != null) {
    const [sf] = await db
      .select({ id: franchiseStorefrontsTable.id })
      .from(franchiseStorefrontsTable)
      .where(
        and(
          eq(franchiseStorefrontsTable.orgId, access.org.id),
          eq(franchiseStorefrontsTable.tenantId, tenantId),
        ),
      );
    if (!sf) {
      res.status(404).json({ message: "Storefront not found in this organization" });
      return;
    }
  }
  const [user] = await db
    .select({ id: usersTable.id, username: usersTable.username })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user) {
    res.status(404).json({ message: "User not found" });
    return;
  }
  try {
    const [row] = await db
      .insert(franchiseRolesTable)
      .values({
        orgId: access.org.id,
        userId,
        role,
        regionId: role === "regional_manager" ? regionId : null,
        tenantId: role === "storefront_operator" ? tenantId : null,
      })
      .returning();
    res.status(201).json(
      AssignFranchiseRoleResponse.parse({
        id: row.id,
        orgId: row.orgId,
        userId: row.userId,
        username: user.username,
        role: row.role,
        regionId: row.regionId,
        tenantId: row.tenantId,
      }),
    );
  } catch (err) {
    if (pgCode(err) === "23505") {
      res.status(409).json({ message: "This user already has a role in this organization" });
      return;
    }
    throw err;
  }
});

router.delete("/franchise/orgs/:orgId/roles/:roleId", async (req, res): Promise<void> => {
  const access = await requireOrgRole(req, res, { superAdminOnly: true });
  if (!access) return;
  const roleId = Number(req.params.roleId);
  const [removed] = await db
    .delete(franchiseRolesTable)
    .where(and(eq(franchiseRolesTable.orgId, access.org.id), eq(franchiseRolesTable.id, roleId)))
    .returning();
  if (!removed) {
    res.status(404).json({ message: "Role not found" });
    return;
  }
  res.status(204).end();
});

// ── Perk templates & propagation ─────────────────────────────────────────────

async function serializeTemplates(
  orgId: number,
  scopedTenantIds: number[],
  templateId?: number,
) {
  const templates = await db
    .select()
    .from(franchisePerkTemplatesTable)
    .where(
      templateId == null
        ? eq(franchisePerkTemplatesTable.orgId, orgId)
        : and(
            eq(franchisePerkTemplatesTable.orgId, orgId),
            eq(franchisePerkTemplatesTable.id, templateId),
          ),
    )
    .orderBy(desc(franchisePerkTemplatesTable.id));
  const ids = templates.map((t) => t.id);
  const deployments =
    ids.length === 0 || scopedTenantIds.length === 0
      ? []
      : await db
          .select({
            deployment: franchiseTemplateDeploymentsTable,
            tenantName: tenantsTable.brandName,
          })
          .from(franchiseTemplateDeploymentsTable)
          .innerJoin(tenantsTable, eq(franchiseTemplateDeploymentsTable.tenantId, tenantsTable.id))
          .where(
            and(
              inArray(franchiseTemplateDeploymentsTable.templateId, ids),
              inArray(franchiseTemplateDeploymentsTable.tenantId, scopedTenantIds),
            ),
          );
  return templates.map((t) => ({
    id: t.id,
    orgId: t.orgId,
    title: t.title,
    redemptionTerms: t.redemptionTerms,
    status: t.status,
    deployments: deployments
      .filter((d) => d.deployment.templateId === t.id)
      .map((d) => ({
        tenantId: d.deployment.tenantId,
        tenantName: d.tenantName,
        status: d.deployment.status,
        partnershipId: d.deployment.partnershipId,
      })),
    createdAt: t.createdAt.toISOString(),
  }));
}

router.get("/franchise/orgs/:orgId/templates", async (req, res): Promise<void> => {
  const access = await requireOrgRole(req, res);
  if (!access) return;
  const scoped = await scopedStorefrontTenantIds(access.org.id, access.ctx);
  res.json(ListFranchiseTemplatesResponse.parse(await serializeTemplates(access.org.id, scoped)));
});

router.post("/franchise/orgs/:orgId/templates", async (req, res): Promise<void> => {
  const access = await requireOrgRole(req, res, { superAdminOnly: true });
  if (!access) return;
  const parsed = CreateFranchiseTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const [template] = await db
    .insert(franchisePerkTemplatesTable)
    .values({
      orgId: access.org.id,
      title: parsed.data.title.trim(),
      redemptionTerms: parsed.data.redemptionTerms ?? null,
    })
    .returning();
  await propagateTemplate(template);
  const scoped = await scopedStorefrontTenantIds(access.org.id, access.ctx);
  const [out] = await serializeTemplates(access.org.id, scoped, template.id);
  res.status(201).json(CreateFranchiseTemplateResponse.parse(out));
});

router.patch(
  "/franchise/orgs/:orgId/templates/:templateId",
  async (req, res): Promise<void> => {
    const access = await requireOrgRole(req, res, { superAdminOnly: true });
    if (!access) return;
    const parsed = UpdateFranchiseTemplateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
      return;
    }
    const templateId = Number(req.params.templateId);
    const updates: Partial<{
      title: string;
      redemptionTerms: string | null;
      status: string;
      updatedAt: Date;
    }> = { updatedAt: new Date() };
    if (parsed.data.title != null) updates.title = parsed.data.title.trim();
    if ("redemptionTerms" in (req.body ?? {}))
      updates.redemptionTerms = parsed.data.redemptionTerms ?? null;
    if (parsed.data.status != null) updates.status = parsed.data.status;
    const [template] = await db
      .update(franchisePerkTemplatesTable)
      .set(updates)
      .where(
        and(
          eq(franchisePerkTemplatesTable.id, templateId),
          eq(franchisePerkTemplatesTable.orgId, access.org.id),
        ),
      )
      .returning();
    if (!template) {
      res.status(404).json({ message: "Template not found" });
      return;
    }
    await propagateTemplate(template);
    const scoped = await scopedStorefrontTenantIds(access.org.id, access.ctx);
    const [out] = await serializeTemplates(access.org.id, scoped, template.id);
    res.json(UpdateFranchiseTemplateResponse.parse(out));
  },
);

// ── Local partnership requests (autonomy policy + zip enforcement) ──────────

// Aliases are created lazily so importing this module never touches the
// (possibly mocked) schema exports at load time.
const requestRows = (orgId: number) => {
  const sfTenant = alias(tenantsTable, "sf_tenant");
  const tgtTenant = alias(tenantsTable, "tgt_tenant");
  return db
    .select({
      request: franchisePartnershipRequestsTable,
      storefrontTenantName: sfTenant.brandName,
      targetTenantName: tgtTenant.brandName,
    })
    .from(franchisePartnershipRequestsTable)
    .innerJoin(sfTenant, eq(sfTenant.id, franchisePartnershipRequestsTable.storefrontTenantId))
    .innerJoin(tgtTenant, eq(tgtTenant.id, franchisePartnershipRequestsTable.targetTenantId))
    .where(eq(franchisePartnershipRequestsTable.orgId, orgId))
    .orderBy(desc(franchisePartnershipRequestsTable.id));
};

function serializeRequest(r: {
  request: typeof franchisePartnershipRequestsTable.$inferSelect;
  storefrontTenantName: string;
  targetTenantName: string;
}) {
  return {
    id: r.request.id,
    orgId: r.request.orgId,
    storefrontTenantId: r.request.storefrontTenantId,
    storefrontTenantName: r.storefrontTenantName,
    targetTenantId: r.request.targetTenantId,
    targetTenantName: r.targetTenantName,
    perkTitle: r.request.perkTitle,
    perkDescription: r.request.perkDescription,
    status: r.request.status,
    partnershipId: r.request.partnershipId,
    createdAt: r.request.createdAt.toISOString(),
  };
}

/** Same-industry firewall check, identical to the POST /coop/invites
 *  backstop: blocked same-sub-category pairs and persisted isolation pairs. */
async function coopPairBlocked(hostTenantId: number, targetTenantId: number): Promise<boolean> {
  const [profiles, isolated] = await Promise.all([
    loadCoopProfiles([hostTenantId, targetTenantId]),
    isolationPartnersOf(hostTenantId),
  ]);
  return isBlockedPair(
    profiles.get(hostTenantId)!,
    profiles.get(targetTenantId)!,
    isolated.has(targetTenantId),
  );
}

/** Materialize the approved local partnership as a normal pending co-op
 *  invite — the existing invite lifecycle (target accepts/declines) is
 *  deliberately unchanged. */
async function createLocalInvite(
  request: {
    storefrontTenantId: number;
    targetTenantId: number;
    perkTitle: string;
    perkDescription: string | null;
  },
  executor: Pick<typeof db, "insert"> = db,
): Promise<number> {
  const code = `LOC-${Math.random().toString(36).slice(2, 10).toUpperCase()}${Date.now().toString(36).toUpperCase()}`;
  const [row] = await executor
    .insert(merchantCoopPartnershipsTable)
    .values({
      hostTenantId: request.storefrontTenantId,
      partnerTenantId: request.targetTenantId,
      requestedByTenantId: request.storefrontTenantId,
      perkTitle: request.perkTitle,
      perkDescription: request.perkDescription,
      redemptionCode: code,
      // Same lifecycle semantics as POST /coop/invites: pending invites are
      // inactive until accepted, and every new row gets its direction-aware
      // tracking codes at insert time.
      hostTrackingCode: generateTrackingCode(),
      partnerTrackingCode: generateTrackingCode(),
      status: "pending",
      isActive: false,
    })
    .returning({ id: merchantCoopPartnershipsTable.id });
  return row.id;
}

router.get("/franchise/orgs/:orgId/requests", async (req, res): Promise<void> => {
  const access = await requireOrgRole(req, res);
  if (!access) return;
  const scoped = await scopedStorefrontTenantIds(access.org.id, access.ctx);
  const rows = await requestRows(access.org.id);
  const scopedSet = new Set(scoped);
  res.json(
    ListFranchiseRequestsResponse.parse(
      rows.filter((r) => scopedSet.has(r.request.storefrontTenantId)).map(serializeRequest),
    ),
  );
});

router.post("/franchise/orgs/:orgId/requests", async (req, res): Promise<void> => {
  const access = await requireOrgRole(req, res);
  if (!access) return;
  const parsed = CreateFranchiseRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const { storefrontTenantId, targetTenantId, perkTitle, perkDescription } = parsed.data;
  if (storefrontTenantId === targetTenantId) {
    res.status(400).json({ message: "A storefront cannot partner with itself" });
    return;
  }
  // The initiating storefront must be inside the caller's scope.
  const scoped = await scopedStorefrontTenantIds(access.org.id, access.ctx);
  if (!scoped.includes(storefrontTenantId)) {
    res.status(403).json({ message: "This storefront is outside your scope" });
    return;
  }
  // Autonomy policy gate (super admins act as HQ and bypass it).
  const policy = access.org.autonomyPolicy;
  if (access.ctx.role !== "super_admin" && policy === "locked") {
    res.status(403).json({
      message: "Local partnerships are locked by your organization's HQ policy",
    });
    return;
  }
  const [target] = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, targetTenantId));
  if (!target) {
    res.status(404).json({ message: "Target business not found" });
    return;
  }
  // Zip-code proximity: locally initiated partnerships must stay in the
  // storefront's own zip code (per the org's local-autonomy contract).
  const [storefrontZip, targetZip] = await Promise.all([
    tenantPostalCode(storefrontTenantId),
    tenantPostalCode(targetTenantId),
  ]);
  if (storefrontZip == null) {
    res.status(400).json({ message: "This storefront has no postal code on file" });
    return;
  }
  if (targetZip == null || targetZip !== storefrontZip) {
    res.status(400).json({
      message: "Local partnerships must be with a business in your own zip code",
    });
    return;
  }
  // The same-industry guardrail applies to franchise-originated invites just
  // like hand-crafted /coop/invites — the org hierarchy is not an override.
  if (await coopPairBlocked(storefrontTenantId, targetTenantId)) {
    res.status(403).json({
      code: "SAME_INDUSTRY_RESTRICTED",
      message: "Same-industry pairings are restricted by platform guidelines.",
    });
    return;
  }
  const needsApproval = access.ctx.role !== "super_admin" && policy === "approval_required";
  let partnershipId: number | null = null;
  if (!needsApproval) {
    partnershipId = await createLocalInvite({
      storefrontTenantId,
      targetTenantId,
      perkTitle: perkTitle.trim(),
      perkDescription: perkDescription ?? null,
    });
  }
  const [created] = await db
    .insert(franchisePartnershipRequestsTable)
    .values({
      orgId: access.org.id,
      storefrontTenantId,
      targetTenantId,
      perkTitle: perkTitle.trim(),
      perkDescription: perkDescription ?? null,
      status: needsApproval ? "pending" : "approved",
      requestedByUserId: req.session.userId ?? null,
      decidedAt: needsApproval ? null : new Date(),
      partnershipId,
    })
    .returning();
  const rows = await requestRows(access.org.id);
  const row = rows.find((r) => r.request.id === created.id)!;
  res.status(201).json(CreateFranchiseRequestResponse.parse(serializeRequest(row)));
});

router.post(
  "/franchise/orgs/:orgId/requests/:requestId/decide",
  async (req, res): Promise<void> => {
    const access = await requireOrgRole(req, res);
    if (!access) return;
    if (access.ctx.role === "storefront_operator") {
      res.status(403).json({ message: "Approvals require a Regional Manager or Super Admin" });
      return;
    }
    const parsed = DecideFranchiseRequestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
      return;
    }
    const requestId = Number(req.params.requestId);
    const [request] = await db
      .select()
      .from(franchisePartnershipRequestsTable)
      .where(
        and(
          eq(franchisePartnershipRequestsTable.id, requestId),
          eq(franchisePartnershipRequestsTable.orgId, access.org.id),
        ),
      );
    if (!request) {
      res.status(404).json({ message: "Request not found" });
      return;
    }
    // Regional managers may only decide requests from their own region.
    const scoped = await scopedStorefrontTenantIds(access.org.id, access.ctx);
    if (!scoped.includes(request.storefrontTenantId)) {
      res.status(403).json({ message: "This request is outside your region" });
      return;
    }
    if (request.status !== "pending") {
      res.status(409).json({ message: "This request was already decided" });
      return;
    }
    const approve = parsed.data.action === "approve";
    // Re-check the industry guardrail at decision time — classifications may
    // have changed while the request sat in the queue, and approval must
    // never bypass what /coop/invites would reject.
    if (approve && (await coopPairBlocked(request.storefrontTenantId, request.targetTenantId))) {
      res.status(403).json({
        code: "SAME_INDUSTRY_RESTRICTED",
        message: "Same-industry pairings are restricted by platform guidelines.",
      });
      return;
    }
    // Claim-then-materialize, atomically: the conditional UPDATE claims the
    // pending row first; only the single winner creates the invite, inside
    // the same transaction (a crash after the claim rolls both back). This
    // ordering — not the read above — is what prevents two concurrent
    // approvals from persisting duplicate invites.
    const updated = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(franchisePartnershipRequestsTable)
        .set({
          status: approve ? "approved" : "rejected",
          decidedByUserId: req.session.userId ?? null,
          decidedAt: new Date(),
        })
        .where(
          and(
            eq(franchisePartnershipRequestsTable.id, requestId),
            eq(franchisePartnershipRequestsTable.status, "pending"),
          ),
        )
        .returning();
      if (!claimed) return null;
      if (approve) {
        const partnershipId = await createLocalInvite(
          {
            storefrontTenantId: request.storefrontTenantId,
            targetTenantId: request.targetTenantId,
            perkTitle: request.perkTitle,
            perkDescription: request.perkDescription,
          },
          tx,
        );
        await tx
          .update(franchisePartnershipRequestsTable)
          .set({ partnershipId })
          .where(eq(franchisePartnershipRequestsTable.id, requestId));
      }
      return claimed;
    });
    if (!updated) {
      res.status(409).json({ message: "This request was already decided" });
      return;
    }
    const rows = await requestRows(access.org.id);
    const row = rows.find((r) => r.request.id === requestId)!;
    res.json(DecideFranchiseRequestResponse.parse(serializeRequest(row)));
  },
);

// ── Corporate roll-up report ─────────────────────────────────────────────────

router.get("/franchise/orgs/:orgId/rollup", async (req, res): Promise<void> => {
  const access = await requireOrgRole(req, res);
  if (!access) return;
  const scoped = await scopedStorefrontTenantIds(access.org.id, access.ctx);
  const emptyTotals = {
    impressions: 0,
    claims: 0,
    crossovers: 0,
    redemptions: 0,
    revenueInfluenced: 0,
    ledgerRevenue: 0,
  };
  if (scoped.length === 0) {
    res.json(GetFranchiseRollupResponse.parse({ totals: emptyTotals, regions: [] }));
    return;
  }
  const [storefronts, regions, events, redemptions, ledger] = await Promise.all([
    storefrontRows().where(
      and(
        eq(franchiseStorefrontsTable.orgId, access.org.id),
        inArray(franchiseStorefrontsTable.tenantId, scoped),
      ),
    ),
    db.select().from(franchiseRegionsTable).where(eq(franchiseRegionsTable.orgId, access.org.id)),
    db
      .select({
        tenantId: coopEventsTable.tenantId,
        eventType: coopEventsTable.eventType,
        count: sql<number>`count(*)::int`,
        revenue: sql<string>`coalesce(sum(${coopEventsTable.revenueAmount}), 0)`,
      })
      .from(coopEventsTable)
      .where(inArray(coopEventsTable.tenantId, scoped))
      .groupBy(coopEventsTable.tenantId, coopEventsTable.eventType),
    db
      .select({
        tenantId: coopPerkRedemptionsTable.redeemedByTenantId,
        count: sql<number>`count(*)::int`,
      })
      .from(coopPerkRedemptionsTable)
      .where(inArray(coopPerkRedemptionsTable.redeemedByTenantId, scoped))
      .groupBy(coopPerkRedemptionsTable.redeemedByTenantId),
    db
      .select({
        tenantId: platformLedgerEntriesTable.tenantId,
        revenue: sql<string>`coalesce(sum(${platformLedgerEntriesTable.amount}), 0)`,
      })
      .from(platformLedgerEntriesTable)
      .where(inArray(platformLedgerEntriesTable.tenantId, scoped))
      .groupBy(platformLedgerEntriesTable.tenantId),
  ]);

  const perTenant = new Map<number, typeof emptyTotals>();
  const totalsFor = (tenantId: number) => {
    let t = perTenant.get(tenantId);
    if (!t) {
      t = { ...emptyTotals };
      perTenant.set(tenantId, t);
    }
    return t;
  };
  for (const e of events) {
    const t = totalsFor(e.tenantId);
    if (e.eventType === "impression") t.impressions += e.count;
    else if (e.eventType === "claim") t.claims += e.count;
    else if (e.eventType === "crossover") t.crossovers += e.count;
    t.revenueInfluenced += Number(e.revenue);
  }
  for (const r of redemptions) if (r.tenantId != null) totalsFor(r.tenantId).redemptions += r.count;
  for (const l of ledger) if (l.tenantId != null) totalsFor(l.tenantId).ledgerRevenue += Number(l.revenue);

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const addInto = (acc: typeof emptyTotals, t: typeof emptyTotals) => {
    acc.impressions += t.impressions;
    acc.claims += t.claims;
    acc.crossovers += t.crossovers;
    acc.redemptions += t.redemptions;
    acc.revenueInfluenced += t.revenueInfluenced;
    acc.ledgerRevenue += t.ledgerRevenue;
  };
  const finish = (t: typeof emptyTotals) => ({
    ...t,
    revenueInfluenced: round2(t.revenueInfluenced),
    ledgerRevenue: round2(t.ledgerRevenue),
  });

  const regionName = new Map(regions.map((r) => [r.id, r.name]));
  const byRegion = new Map<number | null, typeof storefronts>();
  for (const sf of storefronts) {
    const key = sf.storefront.regionId;
    if (!byRegion.has(key)) byRegion.set(key, []);
    byRegion.get(key)!.push(sf);
  }
  const grandTotals = { ...emptyTotals };
  const regionBlocks = [...byRegion.entries()].map(([regionId, sfs]) => {
    const regionTotals = { ...emptyTotals };
    const storefrontBlocks = sfs.map((sf) => {
      const t = perTenant.get(sf.storefront.tenantId) ?? { ...emptyTotals };
      addInto(regionTotals, t);
      return {
        tenantId: sf.storefront.tenantId,
        tenantName: sf.tenantName,
        totals: finish(t),
      };
    });
    addInto(grandTotals, regionTotals);
    return {
      regionId,
      regionName: regionId == null ? "Unassigned" : (regionName.get(regionId) ?? "Unknown"),
      totals: finish(regionTotals),
      storefronts: storefrontBlocks,
    };
  });
  regionBlocks.sort((a, b) => a.regionName.localeCompare(b.regionName));
  res.json(
    GetFranchiseRollupResponse.parse({ totals: finish(grandTotals), regions: regionBlocks }),
  );
});

export default router;
