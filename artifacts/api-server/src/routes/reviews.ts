import { Router, type IRouter } from "express";
import { db, tenantsTable, sosReviewsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  ListTenantReviewsResponseItem,
  CreateTenantReviewBody,
  UpdateTenantReviewBody,
} from "@workspace/api-zod";
import { requireRole } from "../middlewares/roles";

// ── Tenant review management (session-authenticated) ────────────────────────
// Owner-facing CRUD for the customer reviews shown on the public SEO landing
// page. Visibility (isVisible) controls which reviews appear publicly.

const router: IRouter = Router();

type ReviewRow = typeof sosReviewsTable.$inferSelect;

function serializeReview(r: ReviewRow) {
  return ListTenantReviewsResponseItem.parse({
    id: r.id,
    tenantId: r.tenantId,
    authorName: r.authorName,
    rating: r.rating,
    body: r.body,
    isVisible: r.isVisible,
    createdAt: r.createdAt.toISOString(),
  });
}

async function tenantExists(tenantId: number): Promise<boolean> {
  if (!Number.isInteger(tenantId)) return false;
  const [t] = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  return !!t;
}

router.get("/tenants/:id/reviews", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.id);
  if (!(await tenantExists(tenantId))) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const rows = await db
    .select()
    .from(sosReviewsTable)
    .where(eq(sosReviewsTable.tenantId, tenantId))
    .orderBy(desc(sosReviewsTable.createdAt), desc(sosReviewsTable.id));
  res.json(rows.map(serializeReview));
});

// Review curation is owner/admin surface (it controls what appears on the
// public landing page) — staff are read-only, enforced at route level like
// the tenant settings writes.
const requireReviewWriteRole = requireRole("super_admin", "district_manager", "merchant");

router.post("/tenants/:id/reviews", requireReviewWriteRole, async (req, res): Promise<void> => {
  const tenantId = Number(req.params.id);
  if (!(await tenantExists(tenantId))) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const body = CreateTenantReviewBody.parse(req.body);
  const [created] = await db
    .insert(sosReviewsTable)
    .values({
      tenantId,
      authorName: body.authorName,
      rating: body.rating,
      body: body.body ?? "",
      isVisible: body.isVisible ?? true,
    })
    .returning();
  res.status(201).json(serializeReview(created));
});

router.patch("/tenants/:id/reviews/:reviewId", requireReviewWriteRole, async (req, res): Promise<void> => {
  const tenantId = Number(req.params.id);
  const reviewId = Number(req.params.reviewId);
  if (!(await tenantExists(tenantId)) || !Number.isInteger(reviewId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const body = UpdateTenantReviewBody.parse(req.body);
  const [updated] = await db
    .update(sosReviewsTable)
    .set(body)
    .where(
      and(eq(sosReviewsTable.id, reviewId), eq(sosReviewsTable.tenantId, tenantId)),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Review not found" });
    return;
  }
  res.json(serializeReview(updated));
});

router.delete("/tenants/:id/reviews/:reviewId", requireReviewWriteRole, async (req, res): Promise<void> => {
  const tenantId = Number(req.params.id);
  const reviewId = Number(req.params.reviewId);
  if (!(await tenantExists(tenantId)) || !Number.isInteger(reviewId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [deleted] = await db
    .delete(sosReviewsTable)
    .where(
      and(eq(sosReviewsTable.id, reviewId), eq(sosReviewsTable.tenantId, tenantId)),
    )
    .returning({ id: sosReviewsTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Review not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
