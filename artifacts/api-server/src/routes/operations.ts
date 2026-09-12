import { Router, type IRouter, type Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  tenantIntegrationCapabilitiesTable,
  workforceCapabilitySyncsTable,
  workforcePeopleTable,
  workforceStaffLinksTable,
} from "@workspace/db";
import { GetOperationsOverviewResponse } from "@workspace/api-zod";
import {
  WORKFORCE_CAPABILITIES,
  type WorkforceCapability,
} from "../domains/operations/integrations/types";
import {
  getWorkforceProvider,
  listWorkforceProviders,
} from "../domains/operations/integrations/providerRegistry";
import {
  completeGustoConnection,
  disconnectGusto,
  InvalidOAuthStateError,
  startGustoConnection,
} from "../domains/operations/integrations/gusto/gustoOAuthService";
import { GustoConfigurationError } from "../domains/operations/integrations/gusto/GustoClient";
import { requireRole } from "../middlewares/roles";
import { TenantContextError } from "../lib/tenantScope";
import {
  listWorkforcePeople,
  setWorkforceStaffLink,
  syncWorkforceEmployees,
} from "../domains/operations/integrations/workforceSyncService";
import {
  listCompensation,
  listPayroll,
  syncCompensation,
  syncPayroll,
} from "../domains/operations/integrations/payrollCompensationSyncService";

const router: IRouter = Router();

function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw || raw === "legacy") return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function requireTenantId(req: Request): number {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    throw new TenantContextError("Select a business before using workforce integrations");
  }
  return tenantId;
}

const integrationAdmin = requireRole("super_admin", "district_manager", "merchant");

router.post("/operations/integrations/gusto/connect", integrationAdmin, async (req, res): Promise<void> => {
  try {
    const result = await startGustoConnection(requireTenantId(req), req.sessionID);
    res.json(result);
  } catch (error) {
    if (error instanceof GustoConfigurationError) {
      res.status(503).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.get("/operations/integrations/gusto/callback", async (req, res): Promise<void> => {
  const state = typeof req.query.state === "string" ? req.query.state : null;
  const code = typeof req.query.code === "string" ? req.query.code : null;
  if (!state || !code) {
    res.status(400).json({ error: "Gusto callback requires code and state" });
    return;
  }
  try {
    await completeGustoConnection(state, code, req.sessionID);
    res.redirect("/operations/integrations?gusto=connected");
  } catch (error) {
    if (error instanceof InvalidOAuthStateError) {
      res.status(400).json({ error: error.message });
      return;
    }
    req.log.warn(
      { err: error instanceof Error ? error.message : "unknown" },
      "Gusto authorization failed",
    );
    res.redirect("/operations/integrations?gusto=error");
  }
});

router.get("/operations/integrations/gusto/status", async (req, res): Promise<void> => {
  const tenantId = requireTenantId(req);
  res.json(await getWorkforceProvider("gusto").getConnectionStatus({ tenantId }));
});

router.post("/operations/integrations/gusto/disconnect", integrationAdmin, async (req, res): Promise<void> => {
  await disconnectGusto(requireTenantId(req));
  res.json({ status: "not_connected" });
});

router.post("/operations/integrations/gusto/sync", integrationAdmin, async (req, res): Promise<void> => {
  res.json(await syncWorkforceEmployees({ tenantId: requireTenantId(req), providerId: "gusto" }));
});

router.post("/operations/integrations/gusto/sync/payroll", integrationAdmin, async (req, res): Promise<void> => {
  res.json(await syncPayroll({ tenantId: requireTenantId(req), providerId: "gusto" }));
});

router.post("/operations/integrations/gusto/sync/compensation", integrationAdmin, async (req, res): Promise<void> => {
  res.json(await syncCompensation({ tenantId: requireTenantId(req), providerId: "gusto" }));
});

router.get("/operations/payroll", integrationAdmin, async (req, res): Promise<void> => {
  const rows = await listPayroll(requireTenantId(req));
  res.json(
    rows.map((row) => ({
      ...row,
      calculatedAt: row.calculatedAt?.toISOString() ?? null,
      lastSyncedAt: row.lastSyncedAt.toISOString(),
    })),
  );
});

router.get("/operations/compensation", integrationAdmin, async (req, res): Promise<void> => {
  const rows = await listCompensation(requireTenantId(req));
  res.json(
    rows.map((row) => ({
      ...row,
      lastSyncedAt: row.lastSyncedAt.toISOString(),
    })),
  );
});

router.get("/operations/workforce", async (req, res): Promise<void> => {
  const people = await listWorkforcePeople(requireTenantId(req));
  res.json(
    people.map((person) => ({
      ...person,
      lastSyncedAt: person.lastSyncedAt.toISOString(),
      linked: person.linkId != null,
    })),
  );
});

router.put("/operations/workforce/:personId/link", integrationAdmin, async (req, res): Promise<void> => {
  const personId = Number(req.params.personId);
  if (!Number.isInteger(personId) || personId <= 0) {
    res.status(400).json({ error: "Invalid workforce person id" });
    return;
  }
  const staffId = req.body?.staffId == null ? null : Number(req.body.staffId);
  const resourceId = req.body?.resourceId == null ? null : Number(req.body.resourceId);
  if (
    (staffId != null && (!Number.isInteger(staffId) || staffId <= 0)) ||
    (resourceId != null && (!Number.isInteger(resourceId) || resourceId <= 0))
  ) {
    res.status(400).json({ error: "Invalid GNIL staff or resource id" });
    return;
  }
  const link = await setWorkforceStaffLink({
    tenantId: requireTenantId(req),
    personId,
    staffId,
    resourceId,
  });
  res.json({ linked: link != null });
});

router.get("/operations/overview", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  const providerDefinitions = listWorkforceProviders();
  const statuses =
    tenantId == null
      ? []
      : await Promise.all(
          providerDefinitions.map((provider) =>
            getWorkforceProvider(provider.providerId).getConnectionStatus({ tenantId }),
          ),
        );
  const statusByProviderId = new Map(statuses.map((status) => [status.providerId, status]));
  const providers = providerDefinitions.map((provider) => {
    const connection = statusByProviderId.get(provider.providerId);
    return {
      ...provider,
      capabilities: [...provider.capabilities],
      status: connection?.state ?? "not_connected",
      scopes: connection?.scopes ?? [],
      connectedAt: connection?.connectedAt ?? null,
      lastSuccessfulSyncAt: connection?.lastSuccessfulSyncAt ?? null,
      lastError: connection?.lastError ?? null,
    };
  });

  const persistedAssignments =
    tenantId == null
      ? []
      : await db
          .select({
            capability: tenantIntegrationCapabilitiesTable.capability,
            providerId: tenantIntegrationCapabilitiesTable.providerId,
          })
          .from(tenantIntegrationCapabilitiesTable)
          .where(
            and(
              eq(tenantIntegrationCapabilitiesTable.tenantId, tenantId),
              eq(tenantIntegrationCapabilitiesTable.isPrimary, true),
            ),
          );
  const syncMetadata =
    tenantId == null
      ? []
      : await db
          .select({
            providerId: workforceCapabilitySyncsTable.providerId,
            capability: workforceCapabilitySyncsTable.capability,
            status: workforceCapabilitySyncsTable.status,
            lastError: workforceCapabilitySyncsTable.lastError,
          })
          .from(workforceCapabilitySyncsTable)
          .where(eq(workforceCapabilitySyncsTable.tenantId, tenantId));
  const syncByCapability = new Map(
    syncMetadata.map((sync) => [`${sync.providerId}:${sync.capability}`, sync]),
  );
  const assignmentByCapability = new Map(
    persistedAssignments.map((assignment) => [assignment.capability, assignment.providerId]),
  );

  const capabilityAssignments = WORKFORCE_CAPABILITIES.map((capability) => {
    const assignedProviderId = assignmentByCapability.get(capability);
    const owner = providers.find((provider) => provider.providerId === assignedProviderId);
    const sync = owner
      ? syncByCapability.get(`${owner.providerId}:${capability}`)
      : undefined;
    const requiredScopes =
      owner?.requiredScopes?.[capability as WorkforceCapability] ?? [];
    const missingScopes = requiredScopes.filter(
      (scope) => !owner?.scopes?.includes(scope),
    );
    const advertised =
      owner?.capabilities.includes(capability as WorkforceCapability) ?? false;
    const connected =
      owner != null &&
      advertised &&
      ["connected", "degraded"].includes(owner.status) &&
      missingScopes.length === 0;
    const state = !owner || !advertised
      ? "unavailable"
      : missingScopes.length
        ? "missing_scope"
        : sync?.status === "failed"
          ? "failed"
          : connected
            ? "connected"
            : "unavailable";
    return {
      capability,
      providerId: owner?.providerId ?? null,
      providerName: owner?.name ?? null,
      state,
      providerStatus: owner?.status ?? null,
      missingScopes,
      syncStatus: sync?.status ?? null,
      syncLastError: sync?.lastError ?? null,
    };
  });

  const [workforceCounts] =
    tenantId == null
      ? [{ workforceCount: 0, unlinkedWorkforceCount: 0 }]
      : await db
          .select({
            workforceCount: sql<number>`count(${workforcePeopleTable.id})::int`,
            unlinkedWorkforceCount: sql<number>`count(${workforcePeopleTable.id}) filter (where ${workforceStaffLinksTable.id} is null)::int`,
          })
          .from(workforcePeopleTable)
          .leftJoin(
            workforceStaffLinksTable,
            and(
              eq(workforceStaffLinksTable.tenantId, tenantId),
              eq(workforceStaffLinksTable.workforcePersonId, workforcePeopleTable.id),
            ),
          )
          .where(eq(workforcePeopleTable.tenantId, tenantId));

  const syncDates = providers
    .map((provider) => provider.lastSuccessfulSyncAt)
    .filter((value): value is string => value != null)
    .sort();

  res.json(
    GetOperationsOverviewResponse.parse({
      providers,
      capabilityAssignments,
      connectedProviderCount: providers.filter((provider) => provider.status === "connected").length,
      attentionRequiredCount: providers.filter((provider) =>
        ["degraded", "reauthorization_required", "error"].includes(provider.status),
      ).length,
      lastSuccessfulSyncAt: syncDates.at(-1) ?? null,
      workforceCount: workforceCounts.workforceCount,
      unlinkedWorkforceCount: workforceCounts.unlinkedWorkforceCount,
    }),
  );
});

export default router;