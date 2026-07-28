import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import {
  db,
  usersTable,
  userTenantMembershipsTable,
  tenantsTable,
  tenantActivitiesTable,
  sosSettingsTable,
  coopApplicationsTable,
  NETWORK_ROLES,
  type NetworkRole,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireRole } from "../middlewares/roles";
import {
  ListGovernanceUsersResponse,
  CreateGovernanceUserBody,
  CreateGovernanceUserResponse,
  UpdateGovernanceUserBody,
  UpdateGovernanceUserResponse,
  RotateGovernanceUserTokenResponse,
  ListCoopApplicationsResponse,
  ReviewCoopApplicationBody,
  ReviewCoopApplicationResponse,
} from "@workspace/api-zod";
import { getSettingsForTenant } from "../lib/settings";
import { runCoopConflictCheck } from "../lib/coopFirewall";
import { refreshCoopSuggestionsSafe } from "../lib/coopMatchmaking";

// ---------------------------------------------------------------------------
// Network Governance — /api/governance
//
// User/role management (super-admin only) and the co-op join-application
// review queue (super-admin + district managers). Role semantics live in
// middlewares/roles.ts; tenant scope is user_tenant_memberships.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

function newLoginToken(): string {
  return `gnil-${randomBytes(24).toString("hex")}`;
}

/** Scope rules per role: merchant/staff exactly one tenant; district ≥ 1. */
function scopeError(role: NetworkRole, tenantIds: number[]): string | null {
  if (role === "super_admin") return null; // scope ignored — full access
  if (role === "district_manager") {
    return tenantIds.length >= 1 ? null : "A district manager needs at least one assigned tenant";
  }
  return tenantIds.length === 1
    ? null
    : `A ${role === "merchant" ? "merchant" : "staff member"} must be assigned exactly one tenant`;
}

async function serializeUsers(userIds?: number[]) {
  const users = await db
    .select()
    .from(usersTable)
    .where(userIds ? inArray(usersTable.id, userIds) : undefined)
    .orderBy(desc(usersTable.createdAt));
  const ids = users.map((u) => u.id);
  const memberships = ids.length
    ? await db
        .select({
          userId: userTenantMembershipsTable.userId,
          tenantId: userTenantMembershipsTable.tenantId,
          tenantName: tenantsTable.brandName,
        })
        .from(userTenantMembershipsTable)
        .innerJoin(tenantsTable, eq(userTenantMembershipsTable.tenantId, tenantsTable.id))
        .where(inArray(userTenantMembershipsTable.userId, ids))
    : [];
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    role: u.isPlatformAdmin ? "super_admin" : u.role,
    isPlatformAdmin: u.isPlatformAdmin,
    hasLoginToken: u.loginToken != null,
    tenants: memberships
      .filter((m) => m.userId === u.id)
      .map((m) => ({ id: m.tenantId, name: m.tenantName })),
    createdAt: u.createdAt.toISOString(),
  }));
}

// ── Users & roles (super-admin only) ─────────────────────────────────────────

router.get("/governance/users", requireRole("super_admin"), async (_req, res): Promise<void> => {
  res.json(ListGovernanceUsersResponse.parse(await serializeUsers()));
});

router.post("/governance/users", requireRole("super_admin"), async (req, res): Promise<void> => {
  const parsed = CreateGovernanceUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { username, role } = parsed.data;
  const tenantIds = [...new Set(parsed.data.tenantIds ?? [])];
  const err = scopeError(role as NetworkRole, tenantIds);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  if (tenantIds.length > 0) {
    const found = await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(inArray(tenantsTable.id, tenantIds));
    if (found.length !== tenantIds.length) {
      res.status(400).json({ error: "One or more assigned tenants do not exist" });
      return;
    }
  }
  const loginToken = newLoginToken();
  let user;
  try {
    [user] = await db
      .insert(usersTable)
      .values({
        username: username.trim(),
        role,
        isPlatformAdmin: role === "super_admin",
        loginToken,
      })
      .returning();
  } catch (e) {
    const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    if (code === "23505") {
      res.status(409).json({ error: "That username is already taken" });
      return;
    }
    throw e;
  }
  if (role !== "super_admin" && tenantIds.length > 0) {
    await db
      .insert(userTenantMembershipsTable)
      .values(tenantIds.map((tenantId) => ({ userId: user.id, tenantId })));
  }
  const [serialized] = await serializeUsers([user.id]);
  // The login token is shown exactly once, at creation time.
  res.status(201).json(CreateGovernanceUserResponse.parse({ ...serialized, loginToken }));
});

router.patch("/governance/users/:id", requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const parsed = UpdateGovernanceUserBody.safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    res.status(400).json({ error: parsed.success ? "Invalid user id" : parsed.error.message });
    return;
  }
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (existing.username === "operator") {
    res.status(400).json({ error: "The bootstrap operator account cannot be modified" });
    return;
  }
  const role = (parsed.data.role ?? (existing.isPlatformAdmin ? "super_admin" : existing.role)) as NetworkRole;
  const currentMemberships = await db
    .select({ tenantId: userTenantMembershipsTable.tenantId })
    .from(userTenantMembershipsTable)
    .where(eq(userTenantMembershipsTable.userId, id));
  const tenantIds = [
    ...new Set(parsed.data.tenantIds ?? currentMemberships.map((m) => m.tenantId)),
  ];
  const err = scopeError(role, tenantIds);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  if (parsed.data.tenantIds && tenantIds.length > 0) {
    const found = await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(inArray(tenantsTable.id, tenantIds));
    if (found.length !== tenantIds.length) {
      res.status(400).json({ error: "One or more assigned tenants do not exist" });
      return;
    }
  }
  await db
    .update(usersTable)
    .set({ role, isPlatformAdmin: role === "super_admin" })
    .where(eq(usersTable.id, id));
  if (parsed.data.tenantIds) {
    await db.delete(userTenantMembershipsTable).where(eq(userTenantMembershipsTable.userId, id));
    if (role !== "super_admin" && tenantIds.length > 0) {
      await db
        .insert(userTenantMembershipsTable)
        .values(tenantIds.map((tenantId) => ({ userId: id, tenantId })));
    }
  }
  const [serialized] = await serializeUsers([id]);
  res.json(UpdateGovernanceUserResponse.parse(serialized));
});

router.delete("/governance/users/:id", requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (existing.username === "operator") {
    res.status(400).json({ error: "The bootstrap operator account cannot be deleted" });
    return;
  }
  await db.delete(usersTable).where(eq(usersTable.id, id));
  res.sendStatus(204);
});

router.post(
  "/governance/users/:id/rotate-token",
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    const loginToken = newLoginToken();
    const [updated] = await db
      .update(usersTable)
      .set({ loginToken })
      .where(eq(usersTable.id, Number.isInteger(id) ? id : -1))
      .returning({ id: usersTable.id });
    if (!updated) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(RotateGovernanceUserTokenResponse.parse({ id, loginToken }));
  },
);

// ── Co-op join applications review queue ────────────────────────────────────

function serializeApplication(a: typeof coopApplicationsTable.$inferSelect) {
  return {
    id: a.id,
    businessName: a.businessName,
    subdomain: a.subdomain,
    contactName: a.contactName,
    contactEmail: a.contactEmail,
    category: a.category,
    pitch: a.pitch,
    status: a.status,
    reviewNotes: a.reviewNotes,
    rejectionReason: a.rejectionReason,
    resultingTenantId: a.resultingTenantId,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

router.get(
  "/governance/applications",
  requireRole("super_admin", "district_manager"),
  async (_req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(coopApplicationsTable)
      .orderBy(desc(coopApplicationsTable.createdAt));
    res.json(ListCoopApplicationsResponse.parse(rows.map(serializeApplication)));
  },
);

// Legal transitions: submitted → under_review → approved | rejected
// (submitted may also go straight to approved/rejected).
const NEXT_STATUSES: Record<string, string[]> = {
  submitted: ["under_review", "approved", "rejected"],
  under_review: ["approved", "rejected"],
  approved: [],
  rejected: [],
};

router.patch(
  "/governance/applications/:id",
  requireRole("super_admin", "district_manager"),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    const parsed = ReviewCoopApplicationBody.safeParse(req.body);
    if (!Number.isInteger(id) || !parsed.success) {
      res.status(400).json({ error: parsed.success ? "Invalid id" : parsed.error.message });
      return;
    }
    const [app] = await db
      .select()
      .from(coopApplicationsTable)
      .where(eq(coopApplicationsTable.id, id));
    if (!app) {
      res.status(404).json({ error: "Application not found" });
      return;
    }
    const nextStatus = parsed.data.status;
    if (nextStatus && nextStatus !== app.status && !NEXT_STATUSES[app.status]?.includes(nextStatus)) {
      res.status(409).json({ error: `Cannot move a ${app.status} application to ${nextStatus}` });
      return;
    }
    if (nextStatus === "rejected" && !(parsed.data.rejectionReason ?? app.rejectionReason)) {
      res.status(400).json({ error: "A rejection reason is required" });
      return;
    }

    if (nextStatus === "approved" && app.status !== "approved") {
      // Provision the tenant via the standard tenant-creation path, guarded
      // by a conditional status claim so two concurrent approvals can't
      // double-provision.
      const [subdomainTaken] = await db
        .select({ id: tenantsTable.id })
        .from(tenantsTable)
        .where(eq(tenantsTable.subdomain, app.subdomain));
      if (subdomainTaken) {
        res.status(409).json({
          error: "That web address is already taken — reject the application or ask the applicant to reapply.",
        });
        return;
      }
      const outcome = await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(coopApplicationsTable)
          .set({
            status: "approved",
            reviewNotes: parsed.data.reviewNotes ?? app.reviewNotes,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(coopApplicationsTable.id, id),
              inArray(coopApplicationsTable.status, ["submitted", "under_review"]),
            ),
          )
          .returning({ id: coopApplicationsTable.id });
        if (!claimed) return null;
        // Same provisioning shape as POST /tenants (routes/tenants.ts).
        const [tenant] = await tx
          .insert(tenantsTable)
          .values({
            brandName: app.businessName,
            subdomain: app.subdomain,
            contactEmail: app.contactEmail,
            contactName: app.contactName,
            status: "active",
            mrr: "0",
            modulesEnabled: 0,
          })
          .returning();
        await tx.insert(tenantActivitiesTable).values({
          tenantId: tenant.id,
          action: "Tenant provisioned",
          details: `${tenant.brandName}.${tenant.subdomain}.getnextinline.io deployed via approved co-op application`,
        });
        await tx.insert(sosSettingsTable).values({
          tenantId: tenant.id,
          businessName: app.businessName,
          ...(app.category ? { businessCategory: app.category } : {}),
        });
        await tx
          .update(coopApplicationsTable)
          .set({ resultingTenantId: tenant.id, updatedAt: new Date() })
          .where(eq(coopApplicationsTable.id, id));
        return tenant.id;
      });
      if (outcome == null) {
        res.status(409).json({ error: "This application was already decided" });
        return;
      }
      // Post-provisioning onboarding, same as the admin flow.
      await getSettingsForTenant(outcome);
      await runCoopConflictCheck(outcome);
      await refreshCoopSuggestionsSafe(outcome);
    } else {
      await db
        .update(coopApplicationsTable)
        .set({
          ...(nextStatus ? { status: nextStatus } : {}),
          ...(parsed.data.reviewNotes !== undefined ? { reviewNotes: parsed.data.reviewNotes } : {}),
          ...(parsed.data.rejectionReason !== undefined
            ? { rejectionReason: parsed.data.rejectionReason }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(coopApplicationsTable.id, id));
    }

    const [updated] = await db
      .select()
      .from(coopApplicationsTable)
      .where(eq(coopApplicationsTable.id, id));
    res.json(ReviewCoopApplicationResponse.parse(serializeApplication(updated)));
  },
);

export default router;
