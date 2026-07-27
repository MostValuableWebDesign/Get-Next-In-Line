import { Router, type Request, type IRouter } from "express";
import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  emergencyBroadcastsTable,
  emergencyBroadcastTargetsTable,
  emergencyCheckinsTable,
  type EmergencyBroadcast,
} from "@workspace/db";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import {
  ListEmergencyBroadcastsResponse,
  CreateEmergencyBroadcastBody,
  CreateEmergencyBroadcastResponse,
  ResolveEmergencyBroadcastResponse,
  SubmitEmergencyCheckinBody,
  SubmitEmergencyCheckinResponse,
  ListEmergencyCheckinsResponse,
  GetActiveEmergencyBroadcastsResponse,
} from "@workspace/api-zod";
import { sessionIsPlatformAdmin } from "../middlewares/tenantAccess";
import {
  serializeBroadcast,
  rosterForBroadcast,
  sweepEmergencyBroadcastFanout,
} from "../lib/emergencyBroadcasts";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Co-Op Emergency & Crisis Network Broadcast — /api/coop/emergency/*
//
// A platform admin (no tenant scope) can push a critical alert to the whole
// platform or a selected tenant list; a merchant with at least one accepted,
// active co-op partnership ("local leader") can push one to their partner
// network. Every targeted tenant's subscribers get an SMS (async fan-out via
// the concierge worker) and the tenant gets a dashboard check-in prompt
// (Open / Temporarily Closed / Safe) whose answer is visible to the network
// and on the public landing page while the alert is active.
//
// Tenant scoping follows the /api/coop conventions (x-tenant-id header). A
// broadcast is only ever visible to its sender, its targets, and admins.
// ---------------------------------------------------------------------------

/** Tenant scope from the x-tenant-id header (same convention as /api/coop). */
function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Accepted + active co-op partner tenant ids — the merchant broadcast target
 * network. Perk date windows are deliberately ignored (same rule as safety
 * alerts): only status and the isActive kill switch end the relationship.
 */
async function acceptedPartnerTenantIds(tenantId: number): Promise<number[]> {
  const rows = await db
    .select({
      hostTenantId: merchantCoopPartnershipsTable.hostTenantId,
      partnerTenantId: merchantCoopPartnershipsTable.partnerTenantId,
    })
    .from(merchantCoopPartnershipsTable)
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        eq(merchantCoopPartnershipsTable.isActive, true),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId),
        ),
      ),
    );
  const ids = new Set<number>();
  for (const r of rows) {
    ids.add(r.hostTenantId === tenantId ? r.partnerTenantId : r.hostTenantId);
  }
  ids.delete(tenantId);
  return [...ids];
}

/**
 * Load a broadcast if it is visible to the caller: the sender tenant, a
 * targeted tenant, or a platform admin. Returns null (→ 404) otherwise so
 * outsiders can't even learn a broadcast exists.
 */
async function visibleBroadcast(
  broadcastId: number,
  tenantId: number | null,
  isAdmin: boolean,
): Promise<{ broadcast: EmergencyBroadcast; isTarget: boolean } | null> {
  const [broadcast] = await db
    .select()
    .from(emergencyBroadcastsTable)
    .where(eq(emergencyBroadcastsTable.id, broadcastId));
  if (!broadcast) return null;
  let isTarget = false;
  if (tenantId != null) {
    const [target] = await db
      .select({ id: emergencyBroadcastTargetsTable.id })
      .from(emergencyBroadcastTargetsTable)
      .where(
        and(
          eq(emergencyBroadcastTargetsTable.broadcastId, broadcastId),
          eq(emergencyBroadcastTargetsTable.tenantId, tenantId),
        ),
      );
    isTarget = Boolean(target);
  }
  const isSender = tenantId != null && broadcast.senderTenantId === tenantId;
  if (!isAdmin && !isSender && !isTarget) return null;
  return { broadcast, isTarget };
}

/** Kick the SMS fan-out without blocking the response; worker tick is the safety net. */
function kickFanout(): void {
  void sweepEmergencyBroadcastFanout().catch((err) =>
    logger.error({ err }, "Post-create emergency fan-out kick failed"),
  );
}

// ── POST /coop/emergency/broadcasts — compose and send ──────────────────────
router.post("/coop/emergency/broadcasts", async (req, res): Promise<void> => {
  const parsed = CreateEmergencyBroadcastBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const tenantId = tenantIdFrom(req);
  const isAdmin = tenantIdFrom(req) == null && sessionIsPlatformAdmin(req);

  let scope: string;
  let senderTenantId: number | null;
  let targetTenantIds: number[];

  if (tenantId != null) {
    // Merchant local leader: authorization piggybacks on accepted co-op
    // partnership membership — no partners, no broadcast rights.
    if (parsed.data.scope) {
      res.status(400).json({
        message: "Merchant broadcasts always target your co-op partner network — omit scope",
      });
      return;
    }
    const partnerIds = await acceptedPartnerTenantIds(tenantId);
    if (partnerIds.length === 0) {
      res.status(403).json({
        message:
          "Only businesses with at least one accepted co-op partnership can send network broadcasts",
      });
      return;
    }
    scope = "network";
    senderTenantId = tenantId;
    // The sender checks in too — its own storefront status matters to the network.
    targetTenantIds = [tenantId, ...partnerIds];
  } else {
    if (!isAdmin) {
      res.status(403).json({ message: "Platform admin access required" });
      return;
    }
    scope = parsed.data.scope ?? "platform";
    senderTenantId = null;
    if (scope === "selected") {
      const ids = [...new Set(parsed.data.targetTenantIds ?? [])].filter(
        (n) => Number.isInteger(n) && n > 0,
      );
      if (ids.length === 0) {
        res.status(400).json({ message: "targetTenantIds is required for a selected-scope broadcast" });
        return;
      }
      const found = await db
        .select({ id: tenantsTable.id })
        .from(tenantsTable)
        .where(inArray(tenantsTable.id, ids));
      if (found.length !== ids.length) {
        res.status(400).json({ message: "One or more target tenants do not exist" });
        return;
      }
      targetTenantIds = ids;
    } else {
      const all = await db
        .select({ id: tenantsTable.id })
        .from(tenantsTable)
        .where(eq(tenantsTable.status, "active"));
      targetTenantIds = all.map((t) => t.id);
    }
  }

  const [broadcast] = await db
    .insert(emergencyBroadcastsTable)
    .values({
      senderTenantId,
      scope,
      severity: parsed.data.severity,
      alertType: parsed.data.alertType,
      headline: parsed.data.headline.trim(),
      message: parsed.data.message.trim(),
    })
    .returning();
  if (targetTenantIds.length > 0) {
    await db
      .insert(emergencyBroadcastTargetsTable)
      .values(targetTenantIds.map((tid) => ({ broadcastId: broadcast.id, tenantId: tid })))
      .onConflictDoNothing();
  }

  kickFanout();

  res
    .status(201)
    .json(CreateEmergencyBroadcastResponse.parse(await serializeBroadcast(broadcast, tenantId)));
});

// ── GET /coop/emergency/broadcasts — sent + received, newest first ──────────
router.get("/coop/emergency/broadcasts", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  const isAdmin = tenantIdFrom(req) == null && sessionIsPlatformAdmin(req);
  if (tenantId == null && !isAdmin) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }

  let broadcasts: EmergencyBroadcast[];
  if (tenantId == null) {
    // Admin console: all broadcasts, unscoped.
    broadcasts = await db
      .select()
      .from(emergencyBroadcastsTable)
      .orderBy(desc(emergencyBroadcastsTable.createdAt), desc(emergencyBroadcastsTable.id));
  } else {
    const targetRows = await db
      .select({ broadcastId: emergencyBroadcastTargetsTable.broadcastId })
      .from(emergencyBroadcastTargetsTable)
      .where(eq(emergencyBroadcastTargetsTable.tenantId, tenantId));
    const ids = new Set(targetRows.map((r) => r.broadcastId));
    broadcasts = await db
      .select()
      .from(emergencyBroadcastsTable)
      .where(
        ids.size > 0
          ? or(
              eq(emergencyBroadcastsTable.senderTenantId, tenantId),
              inArray(emergencyBroadcastsTable.id, [...ids]),
            )
          : eq(emergencyBroadcastsTable.senderTenantId, tenantId),
      )
      .orderBy(desc(emergencyBroadcastsTable.createdAt), desc(emergencyBroadcastsTable.id));
  }

  res.json(
    ListEmergencyBroadcastsResponse.parse(
      await Promise.all(broadcasts.map((b) => serializeBroadcast(b, tenantId))),
    ),
  );
});

// ── GET /coop/emergency/active — active alerts for the check-in banner ──────
router.get("/coop/emergency/active", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const rows = await db
    .select({ broadcast: emergencyBroadcastsTable })
    .from(emergencyBroadcastTargetsTable)
    .innerJoin(
      emergencyBroadcastsTable,
      eq(emergencyBroadcastTargetsTable.broadcastId, emergencyBroadcastsTable.id),
    )
    .where(
      and(
        eq(emergencyBroadcastTargetsTable.tenantId, tenantId),
        eq(emergencyBroadcastsTable.status, "active"),
      ),
    )
    .orderBy(desc(emergencyBroadcastsTable.createdAt), desc(emergencyBroadcastsTable.id));
  res.json(
    GetActiveEmergencyBroadcastsResponse.parse(
      await Promise.all(rows.map((r) => serializeBroadcast(r.broadcast, tenantId))),
    ),
  );
});

// ── POST /coop/emergency/broadcasts/:id/resolve — sender or admin only ──────
router.post("/coop/emergency/broadcasts/:id/resolve", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const tenantId = tenantIdFrom(req);
  const isAdmin = tenantIdFrom(req) == null && sessionIsPlatformAdmin(req);
  const found = Number.isInteger(id) ? await visibleBroadcast(id, tenantId, isAdmin) : null;
  if (!found) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const isSender = tenantId != null && found.broadcast.senderTenantId === tenantId;
  if (!isSender && !isAdmin) {
    res.status(403).json({ message: "Only the sender or a platform admin may resolve a broadcast" });
    return;
  }
  if (found.broadcast.status === "resolved") {
    res.status(409).json({ message: "Broadcast is already resolved" });
    return;
  }
  const now = new Date();
  const [updated] = await db
    .update(emergencyBroadcastsTable)
    .set({ status: "resolved", resolvedAt: now, updatedAt: now })
    .where(eq(emergencyBroadcastsTable.id, id))
    .returning();
  res.json(ResolveEmergencyBroadcastResponse.parse(await serializeBroadcast(updated, tenantId)));
});

// ── POST /coop/emergency/broadcasts/:id/checkin — targeted tenant only ──────
router.post("/coop/emergency/broadcasts/:id/checkin", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = SubmitEmergencyCheckinBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const id = Number(req.params.id);
  const found = Number.isInteger(id) ? await visibleBroadcast(id, tenantId, false) : null;
  // Only tenants the broadcast actually targets may check in — the sender is
  // itself a target on merchant broadcasts, but a non-targeted admin-scoped
  // sender is not.
  if (!found || !found.isTarget) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (found.broadcast.status !== "active") {
    res.status(409).json({ message: "This broadcast has been resolved" });
    return;
  }
  const now = new Date();
  const note = parsed.data.note?.trim() || null;
  const [row] = await db
    .insert(emergencyCheckinsTable)
    .values({ broadcastId: id, tenantId, status: parsed.data.status, note, updatedAt: now })
    .onConflictDoUpdate({
      target: [emergencyCheckinsTable.broadcastId, emergencyCheckinsTable.tenantId],
      set: { status: parsed.data.status, note, updatedAt: now },
    })
    .returning();
  res.json(
    SubmitEmergencyCheckinResponse.parse({
      broadcastId: row.broadcastId,
      tenantId: row.tenantId,
      status: row.status,
      note: row.note,
      updatedAt: row.updatedAt.toISOString(),
    }),
  );
});

// ── GET /coop/emergency/broadcasts/:id/checkins — network status roster ─────
router.get("/coop/emergency/broadcasts/:id/checkins", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  const isAdmin = tenantIdFrom(req) == null && sessionIsPlatformAdmin(req);
  const id = Number(req.params.id);
  const found = Number.isInteger(id) ? await visibleBroadcast(id, tenantId, isAdmin) : null;
  if (!found) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  res.json(ListEmergencyCheckinsResponse.parse(await rosterForBroadcast(id)));
});

export default router;
