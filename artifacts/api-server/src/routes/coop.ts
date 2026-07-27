import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import {
  db,
  tenantsTable,
  modulesTable,
  tenantModulesTable,
  merchantCoopPartnershipsTable,
  type MerchantCoopPartnership,
} from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import { desc, eq, inArray, or } from "drizzle-orm";
import {
  ListCoopPartnershipsResponse,
  CreateCoopPartnershipBody,
  CreateCoopPartnershipResponse,
  UpdateCoopPartnershipBody,
  UpdateCoopPartnershipResponse,
  ValidateCoopRedemptionCodeResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Merchant co-op partnerships — /api/coop
//
// Cross-promotion pacts between two businesses on the platform: a host tenant
// offers a perk (with a redemption code) to customers referred from a partner
// tenant. The "industry barrier" blocks pairing two tenants that share a
// module category (they'd be boosting a direct competitor) unless the admin
// explicitly overrides it. All routes sit behind the shared session auth.
// ---------------------------------------------------------------------------

// Created lazily (not at module scope) so importing the route registry never
// touches drizzle table internals — some unit tests mock @workspace/db with
// bare stub tables.
function tenantAliases() {
  return {
    hostTenant: alias(tenantsTable, "coop_host_tenant"),
    partnerTenant: alias(tenantsTable, "coop_partner_tenant"),
  };
}

function serialize(
  p: MerchantCoopPartnership,
  hostTenantName: string,
  partnerTenantName: string
) {
  return {
    id: p.id,
    hostTenantId: p.hostTenantId,
    hostTenantName,
    partnerTenantId: p.partnerTenantId,
    partnerTenantName,
    perkTitle: p.perkTitle,
    perkDescription: p.perkDescription,
    redemptionCode: p.redemptionCode,
    industryBarrierOverridden: p.industryBarrierOverridden,
    isActive: p.isActive,
    createdAt: p.createdAt.toISOString(),
  };
}

function partnershipRows() {
  const { hostTenant, partnerTenant } = tenantAliases();
  return db
    .select({
      partnership: merchantCoopPartnershipsTable,
      hostTenantName: hostTenant.brandName,
      partnerTenantName: partnerTenant.brandName,
    })
    .from(merchantCoopPartnershipsTable)
    .innerJoin(hostTenant, eq(merchantCoopPartnershipsTable.hostTenantId, hostTenant.id))
    .innerJoin(partnerTenant, eq(merchantCoopPartnershipsTable.partnerTenantId, partnerTenant.id));
}

/** Distinct module categories a tenant has provisioned. */
async function tenantCategories(tenantId: number): Promise<Set<string>> {
  const rows = await db
    .select({ categorySlug: modulesTable.categorySlug, category: modulesTable.category })
    .from(tenantModulesTable)
    .innerJoin(modulesTable, eq(tenantModulesTable.moduleId, modulesTable.id))
    .where(eq(tenantModulesTable.tenantId, tenantId));
  return new Set(rows.map((r) => `${r.categorySlug}\u0000${r.category}`));
}

/** Random, human-readable redemption code, e.g. "COOP-7F3K9Q2M". */
function generateCode(): string {
  // Unambiguous alphabet (no 0/O/1/I/L).
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `COOP-${out}`;
}

function pgUniqueViolation(err: unknown): boolean {
  const pgCode =
    (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
  return pgCode === "23505";
}

// ── GET /coop/partnerships — list, optionally filtered to one tenant ────────
router.get("/coop/partnerships", async (req, res): Promise<void> => {
  const rawTenantId = req.query.tenantId;
  const tenantId = rawTenantId != null ? Number(rawTenantId) : null;
  let query = partnershipRows()
    .orderBy(desc(merchantCoopPartnershipsTable.createdAt), desc(merchantCoopPartnershipsTable.id))
    .$dynamic();
  if (tenantId != null && Number.isInteger(tenantId)) {
    query = query.where(
      or(
        eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
        eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
      )
    );
  }
  const rows = await query;
  res.json(
    ListCoopPartnershipsResponse.parse(
      rows.map((r) => serialize(r.partnership, r.hostTenantName, r.partnerTenantName))
    )
  );
});

// ── POST /coop/partnerships — create with industry-barrier validation ───────
router.post("/coop/partnerships", async (req, res): Promise<void> => {
  const parsed = CreateCoopPartnershipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const { hostTenantId, partnerTenantId, perkTitle } = parsed.data;
  if (hostTenantId === partnerTenantId) {
    res.status(400).json({ message: "A business cannot partner with itself" });
    return;
  }

  const tenants = await db
    .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(inArray(tenantsTable.id, [hostTenantId, partnerTenantId]));
  const host = tenants.find((t) => t.id === hostTenantId);
  const partner = tenants.find((t) => t.id === partnerTenantId);
  if (!host || !partner) {
    res.status(404).json({ message: "Host or partner tenant not found" });
    return;
  }

  // Industry barrier: block pairing two businesses that share a module
  // category (direct competitors) unless explicitly overridden.
  const override = parsed.data.overrideIndustryBarrier === true;
  if (!override) {
    const [hostCats, partnerCats] = await Promise.all([
      tenantCategories(hostTenantId),
      tenantCategories(partnerTenantId),
    ]);
    const shared = [...hostCats]
      .filter((c) => partnerCats.has(c))
      .map((c) => c.split("\u0000")[1])
      .sort();
    if (shared.length > 0) {
      res.status(409).json({
        message: `Industry barrier: ${host.brandName} and ${partner.brandName} operate in the same category (${shared.join(", ")}). Cross-promoting a direct competitor is blocked — override the barrier to proceed anyway.`,
        sharedCategories: shared,
      });
      return;
    }
  }

  const explicitCode = parsed.data.redemptionCode?.trim() || null;
  // Bounded retry: auto-generated codes are random, collisions are rare.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = explicitCode ?? generateCode();
    try {
      const [created] = await db
        .insert(merchantCoopPartnershipsTable)
        .values({
          hostTenantId,
          partnerTenantId,
          perkTitle,
          perkDescription: parsed.data.perkDescription ?? null,
          redemptionCode: code,
          industryBarrierOverridden: override,
        })
        .returning();
      res
        .status(201)
        .json(CreateCoopPartnershipResponse.parse(serialize(created, host.brandName, partner.brandName)));
      return;
    } catch (err) {
      if (pgUniqueViolation(err)) {
        if (explicitCode) {
          res.status(400).json({ message: "Redemption code already in use" });
          return;
        }
        continue; // regenerate and retry
      }
      throw err;
    }
  }
  res.status(500).json({ message: "Could not generate a unique redemption code" });
});

// ── PATCH /coop/partnerships/:id — edit perk / activate / deactivate ────────
router.patch("/coop/partnerships/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const parsed = UpdateCoopPartnershipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const updates: Partial<typeof merchantCoopPartnershipsTable.$inferInsert> = {};
  if (parsed.data.perkTitle !== undefined) updates.perkTitle = parsed.data.perkTitle;
  if (parsed.data.perkDescription !== undefined) updates.perkDescription = parsed.data.perkDescription;
  if (parsed.data.redemptionCode !== undefined) updates.redemptionCode = parsed.data.redemptionCode;
  if (parsed.data.isActive !== undefined) updates.isActive = parsed.data.isActive;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ message: "No fields to update" });
    return;
  }
  updates.updatedAt = new Date();

  try {
    const [updated] = await db
      .update(merchantCoopPartnershipsTable)
      .set(updates)
      .where(eq(merchantCoopPartnershipsTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    const [row] = await partnershipRows().where(eq(merchantCoopPartnershipsTable.id, id));
    res.json(
      UpdateCoopPartnershipResponse.parse(
        serialize(row.partnership, row.hostTenantName, row.partnerTenantName)
      )
    );
  } catch (err) {
    if (pgUniqueViolation(err)) {
      res.status(400).json({ message: "Redemption code already in use" });
      return;
    }
    throw err;
  }
});

// ── GET /coop/redemptions/:code — validate a perk code at checkout ──────────
// Always 200 with a valid flag so staff-facing checkout flows get a clean
// yes/no; unknown codes and inactive partnerships both fail validation.
router.get("/coop/redemptions/:code", async (req, res): Promise<void> => {
  const code = String(req.params.code).trim();
  const [row] = await partnershipRows().where(
    eq(merchantCoopPartnershipsTable.redemptionCode, code)
  );
  if (!row) {
    res.json(
      ValidateCoopRedemptionCodeResponse.parse({
        valid: false,
        reason: "Unknown redemption code",
        partnership: null,
      })
    );
    return;
  }
  if (!row.partnership.isActive) {
    res.json(
      ValidateCoopRedemptionCodeResponse.parse({
        valid: false,
        reason: "This partnership is no longer active",
        partnership: serialize(row.partnership, row.hostTenantName, row.partnerTenantName),
      })
    );
    return;
  }
  res.json(
    ValidateCoopRedemptionCodeResponse.parse({
      valid: true,
      reason: null,
      partnership: serialize(row.partnership, row.hostTenantName, row.partnerTenantName),
    })
  );
});

export default router;
