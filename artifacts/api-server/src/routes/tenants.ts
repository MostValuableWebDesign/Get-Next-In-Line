import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { tenantsTable, tenantActivitiesTable, tenantModulesTable, modulesTable } from "@workspace/db";
import { eq, desc, and, sql } from "drizzle-orm";
import {
  GetTenantModulesParams,
  GetTenantModulesResponse,
  ListTenantsResponse,
  CreateTenantBody,
  CreateTenantResponse,
  GetTenantActivityResponse,
  GetTenantActivityQueryParams,
  GetTenantParams,
  GetTenantResponse,
  UpdateTenantParams,
  UpdateTenantBody,
  UpdateTenantResponse,
  DeleteTenantParams,
  GetTenantSettingsResponse,
  UpdateTenantSettingsBody,
  UpdateTenantSettingsResponse,
} from "@workspace/api-zod";
import { sosSettingsTable } from "@workspace/db";
import {
  getSettingsForTenant,
  serializeSettings,
  toSettingsColumnUpdates,
} from "../lib/settings";
import { runCoopConflictCheck } from "../lib/coopFirewall";

const router: IRouter = Router();

// ── per-tenant settings ──────────────────────────────────────────────────────

router.get("/tenants/:id/settings", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.id);
  const settings = Number.isInteger(tenantId)
    ? await getSettingsForTenant(tenantId)
    : null;
  if (!settings) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json(GetTenantSettingsResponse.parse(await serializeSettings(settings)));
});

router.patch("/tenants/:id/settings", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.id);
  const body = UpdateTenantSettingsBody.parse(req.body);
  const settings = Number.isInteger(tenantId)
    ? await getSettingsForTenant(tenantId)
    : null;
  if (!settings) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const [updated] = await db
    .update(sosSettingsTable)
    .set({ ...toSettingsColumnUpdates(body), updatedAt: new Date() })
    .where(eq(sosSettingsTable.id, settings.id))
    .returning();
  // Automated conflict check: whenever the sub-category, radius, or location
  // may have changed, detect same-sub-category competitors within overlapping
  // radii and persist mutual isolation pairs.
  const touchesCoopScope =
    body.coopSubCategory !== undefined ||
    body.coopRadiusMiles !== undefined ||
    body.latitude !== undefined ||
    body.longitude !== undefined ||
    body.addressLocality !== undefined ||
    body.businessCategory !== undefined ||
    body.industryType !== undefined;
  if (touchesCoopScope) await runCoopConflictCheck(tenantId);
  res.json(UpdateTenantSettingsResponse.parse(await serializeSettings(updated)));
});

router.get("/tenants", async (_req, res): Promise<void> => {
  const tenants = await db
    .select()
    .from(tenantsTable)
    .orderBy(desc(tenantsTable.createdAt));

  res.json(
    ListTenantsResponse.parse(
      tenants.map((t) => ({
        ...t,
        mrr: parseFloat(t.mrr ?? "0"),
        createdAt: t.createdAt.toISOString(),
      }))
    )
  );
});

router.post("/tenants", async (req, res): Promise<void> => {
  const parsed = CreateTenantBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [tenant] = await db
    .insert(tenantsTable)
    .values({
      brandName: parsed.data.brandName,
      subdomain: parsed.data.subdomain,
      contactEmail: parsed.data.contactEmail ?? null,
      contactName: parsed.data.contactName ?? null,
      status: parsed.data.status ?? "pending",
      mrr: "0",
      modulesEnabled: 0,
    })
    .returning();

  // Log activity
  await db.insert(tenantActivitiesTable).values({
    tenantId: tenant.id,
    action: "Tenant provisioned",
    details: `${tenant.brandName}.${tenant.subdomain}.getnextinline.io deployed`,
  });

  // Onboarding: materialize the settings row (which carries the default co-op
  // radius) and run the automated competitor-isolation conflict check so the
  // local partner feed is correctly scoped with zero manual setup.
  await getSettingsForTenant(tenant.id);
  await runCoopConflictCheck(tenant.id);

  res.status(201).json(
    CreateTenantResponse.parse({
      ...tenant,
      mrr: parseFloat(tenant.mrr ?? "0"),
      createdAt: tenant.createdAt.toISOString(),
    })
  );
});

router.get("/tenants/activity", async (req, res): Promise<void> => {
  const query = GetTenantActivityQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { tenantId, before_timestamp: beforeTimestamp, before_id: beforeId } = query.data;
  const limit = query.data.limit ?? 20;

  if ((beforeTimestamp === undefined) !== (beforeId === undefined)) {
    res.status(400).json({
      error: "before_timestamp and before_id must be provided together",
    });
    return;
  }

  if (tenantId !== undefined) {
    const [tenant] = await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId));
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
  }

  // Keyset (cursor) pagination: (timestamp, id) < (before_timestamp, before_id)
  // lets the composite indexes serve every page in constant time.
  const conditions = [];
  if (tenantId !== undefined) {
    conditions.push(eq(tenantActivitiesTable.tenantId, tenantId));
  }
  if (beforeTimestamp !== undefined && beforeId !== undefined) {
    conditions.push(
      sql`(${tenantActivitiesTable.timestamp}, ${tenantActivitiesTable.id}) < (${beforeTimestamp}, ${beforeId})`
    );
  }

  const baseQuery = db
    .select({
      id: tenantActivitiesTable.id,
      tenantId: tenantActivitiesTable.tenantId,
      tenantName: tenantsTable.brandName,
      action: tenantActivitiesTable.action,
      details: tenantActivitiesTable.details,
      timestamp: tenantActivitiesTable.timestamp,
    })
    .from(tenantActivitiesTable)
    .leftJoin(tenantsTable, eq(tenantActivitiesTable.tenantId, tenantsTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(tenantActivitiesTable.timestamp), desc(tenantActivitiesTable.id))
    // Fetch one extra row to determine whether more pages exist
    .limit(limit + 1);

  const rows = await baseQuery;

  const hasMore = rows.length > limit;
  const activities = rows.slice(0, limit);

  res.json(
    GetTenantActivityResponse.parse({
      items: activities.map((a) => ({
        ...a,
        tenantName: a.tenantName ?? "Unknown",
        timestamp: a.timestamp.toISOString(),
      })),
      hasMore,
    })
  );
});

router.get("/tenants/:id", async (req, res): Promise<void> => {
  const params = GetTenantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, params.data.id));

  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  res.json(
    GetTenantResponse.parse({
      ...tenant,
      mrr: parseFloat(tenant.mrr ?? "0"),
      createdAt: tenant.createdAt.toISOString(),
    })
  );
});

router.get("/tenants/:id/modules", async (req, res): Promise<void> => {
  const params = GetTenantModulesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [tenant] = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, params.data.id));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const rows = await db
    .select({
      moduleId: modulesTable.id,
      name: modulesTable.name,
      category: modulesTable.category,
      categorySlug: modulesTable.categorySlug,
      billingCadence: tenantModulesTable.billingCadence,
      provisionedAt: tenantModulesTable.provisionedAt,
    })
    .from(tenantModulesTable)
    .innerJoin(modulesTable, eq(tenantModulesTable.moduleId, modulesTable.id))
    .where(eq(tenantModulesTable.tenantId, params.data.id))
    .orderBy(modulesTable.name);

  res.json(
    GetTenantModulesResponse.parse(
      rows.map((r) => ({
        ...r,
        provisionedAt: r.provisionedAt.toISOString(),
      }))
    )
  );
});

router.patch("/tenants/:id", async (req, res): Promise<void> => {
  const params = UpdateTenantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateTenantBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const updateData: Record<string, unknown> = {};
  if (parsed.data.brandName !== undefined) updateData.brandName = parsed.data.brandName;
  if (parsed.data.subdomain !== undefined) updateData.subdomain = parsed.data.subdomain;
  if (parsed.data.status !== undefined) updateData.status = parsed.data.status;
  if (parsed.data.contactEmail !== undefined) updateData.contactEmail = parsed.data.contactEmail;
  if (parsed.data.contactName !== undefined) updateData.contactName = parsed.data.contactName;

  const [updated] = await db
    .update(tenantsTable)
    .set(updateData)
    .where(eq(tenantsTable.id, params.data.id))
    .returning();

  // Log status change activity if status changed
  if (parsed.data.status && parsed.data.status !== existing.status) {
    await db.insert(tenantActivitiesTable).values({
      tenantId: updated.id,
      action: `Status changed to ${parsed.data.status}`,
      details: `${existing.brandName} marked as ${parsed.data.status}`,
    });
  }

  res.json(
    UpdateTenantResponse.parse({
      ...updated,
      mrr: parseFloat(updated.mrr ?? "0"),
      createdAt: updated.createdAt.toISOString(),
    })
  );
});

router.delete("/tenants/:id", async (req, res): Promise<void> => {
  const params = DeleteTenantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, params.data.id));

  if (!existing) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  await db.delete(tenantsTable).where(eq(tenantsTable.id, params.data.id));
  res.sendStatus(204);
});

export default router;
