import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { modulesTable, agencySettingsTable } from "@workspace/db";
import {
  ListModulesResponse,
  GetModulesPricingResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/modules", async (_req, res): Promise<void> => {
  const modules = await db.select().from(modulesTable).orderBy(modulesTable.categorySlug, modulesTable.name);

  res.json(
    ListModulesResponse.parse(
      // Explicitly pick tenant-safe fields — hidden connector fields
      // (slug, upstreamVendor, hiddenConnector, proxyNotes) must never leak here.
      modules.map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        categorySlug: m.categorySlug,
        description: m.description,
        isActive: m.isActive,
        wholesalePrice: parseFloat(m.wholesalePrice),
      }))
    )
  );
});

router.get("/modules/pricing", async (_req, res): Promise<void> => {
  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  const markup = parseFloat(settings?.markupPercent ?? "35");

  const modules = await db.select().from(modulesTable).orderBy(modulesTable.categorySlug, modulesTable.name);

  res.json(
    GetModulesPricingResponse.parse(
      modules.map((m) => {
        const wholesale = parseFloat(m.wholesalePrice);
        const resale = Math.round(wholesale * (1 + markup / 100) * 100) / 100;
        return {
          id: m.id,
          name: m.name,
          category: m.category,
          wholesalePrice: wholesale,
          resalePrice: resale,
          markupPercent: markup,
          margin: Math.round((resale - wholesale) * 100) / 100,
        };
      })
    )
  );
});

export default router;
