import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { modulesTable } from "@workspace/db";
import { GetConnectorRegistryResponse } from "@workspace/api-zod";

const router: IRouter = Router();

/**
 * Admin-only: full white-label proxy map — every module together with its
 * hidden upstream connector. This data must NEVER be served through
 * tenant-facing endpoints.
 */
router.get("/admin/connector-registry", async (_req, res): Promise<void> => {
  const modules = await db
    .select()
    .from(modulesTable)
    .orderBy(modulesTable.categorySlug, modulesTable.name);

  res.json(
    GetConnectorRegistryResponse.parse(
      modules.map((m) => ({
        id: m.id,
        name: m.name,
        slug: m.slug,
        category: m.category,
        categorySlug: m.categorySlug,
        isActive: m.isActive,
        upstreamVendor: m.upstreamVendor,
        hiddenConnector: m.hiddenConnector,
        proxyNotes: m.proxyNotes,
      }))
    )
  );
});

export default router;
