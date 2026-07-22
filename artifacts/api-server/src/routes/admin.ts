import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { modulesTable } from "@workspace/db";
import {
  GetConnectorRegistryResponse,
  UpdateConnectorRegistryEntryBody,
  UpdateConnectorRegistryEntryResponse,
} from "@workspace/api-zod";

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

/**
 * Admin-only: update a module's hidden connector details (slug, upstream
 * vendor, hidden connector description, proxy notes). Never affects
 * tenant-facing endpoints.
 */
router.patch("/admin/connector-registry/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  const parsed = UpdateConnectorRegistryEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const updates: Partial<typeof modulesTable.$inferInsert> = {};
  if ("slug" in parsed.data) updates.slug = parsed.data.slug ?? null;
  if ("upstreamVendor" in parsed.data) updates.upstreamVendor = parsed.data.upstreamVendor ?? null;
  if ("hiddenConnector" in parsed.data) updates.hiddenConnector = parsed.data.hiddenConnector ?? null;
  if ("proxyNotes" in parsed.data) updates.proxyNotes = parsed.data.proxyNotes ?? null;

  const existing = await db.select().from(modulesTable).where(eq(modulesTable.id, id));
  if (existing.length === 0) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  const [m] =
    Object.keys(updates).length === 0
      ? existing
      : await db.update(modulesTable).set(updates).where(eq(modulesTable.id, id)).returning();

  res.json(
    UpdateConnectorRegistryEntryResponse.parse({
      id: m.id,
      name: m.name,
      slug: m.slug,
      category: m.category,
      categorySlug: m.categorySlug,
      isActive: m.isActive,
      upstreamVendor: m.upstreamVendor,
      hiddenConnector: m.hiddenConnector,
      proxyNotes: m.proxyNotes,
    })
  );
});

export default router;
