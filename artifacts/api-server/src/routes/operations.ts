import { Router, type IRouter, type Request } from "express";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  modulesTable,
  partnerConnectionsTable,
} from "@workspace/db";
import { GetOperationsOverviewResponse } from "@workspace/api-zod";
import {
  WORKFORCE_CAPABILITIES,
  type WorkforceCapability,
} from "../domains/operations/integrations/types";
import { listWorkforceProviders } from "../domains/operations/integrations/providerRegistry";

const router: IRouter = Router();

function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw || raw === "legacy") return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

router.get("/operations/overview", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  const existing = await db
    .select({
      providerBrand: modulesTable.partnerBrand,
      status: partnerConnectionsTable.status,
      connectedAt: partnerConnectionsTable.connectedAt,
      lastSyncAt: partnerConnectionsTable.lastSyncAt,
      lastError: partnerConnectionsTable.lastError,
    })
    .from(partnerConnectionsTable)
    .innerJoin(modulesTable, eq(partnerConnectionsTable.moduleId, modulesTable.id))
    .where(
      and(
        tenantId == null
          ? isNull(partnerConnectionsTable.tenantId)
          : eq(partnerConnectionsTable.tenantId, tenantId),
        eq(modulesTable.categorySlug, "partners"),
      ),
    );

  const connectionByName = new Map(
    existing
      .filter((row) => row.providerBrand)
      .map((row) => [row.providerBrand!.toLowerCase(), row]),
  );

  const providers = listWorkforceProviders().map((provider) => {
    const connection = connectionByName.get(provider.name.toLowerCase());
    const status =
      connection?.status === "active"
        ? "connected"
        : connection?.status === "pending"
          ? "connecting"
          : connection?.status === "error"
            ? "error"
            : "not_connected";

    return {
      ...provider,
      capabilities: [...provider.capabilities],
      status,
      connectedAt: connection?.connectedAt?.toISOString() ?? null,
      lastSuccessfulSyncAt: connection?.lastSyncAt?.toISOString() ?? null,
      lastError: connection?.lastError ?? null,
    };
  });

  const capabilityAssignments = WORKFORCE_CAPABILITIES.map((capability) => {
    const owner = providers.find(
      (provider) =>
        provider.status === "connected" &&
        provider.capabilities.includes(capability as WorkforceCapability),
    );
    return {
      capability,
      providerId: owner?.providerId ?? null,
      providerName: owner?.name ?? null,
      state: owner ? ("connected" as const) : ("unavailable" as const),
    };
  });

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
    }),
  );
});

export default router;