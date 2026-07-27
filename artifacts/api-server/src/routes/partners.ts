import { Router, type IRouter, type Request } from "express";
import { randomUUID } from "crypto";
import {
  db,
  modulesTable,
  partnerConnectionsTable,
  partnerConnectionEventsTable,
  type Module,
  type PartnerConnection,
} from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  ListPartnerConnectionsResponse,
  ConnectPartnerResponse,
  CompletePartnerAuthorizationBody,
  CompletePartnerAuthorizationResponse,
  GetPartnerConnectionStatusResponse,
  DisconnectPartnerResponse,
} from "@workspace/api-zod";
import { encryptToken } from "../lib/partnerCrypto";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Partner-Direct Integrations proxy engine — /api/v1/partners/{partnerId}
//
// partnerId is a URL-safe key derived from the customer-facing partner brand
// ("deel", "next-insurance", …). Internal module slugs / hidden connector
// details are never exposed here — the white-label contract's narrow partner
// exception covers only the brand itself.
//
// Tenant scoping follows the platform convention: the `x-tenant-id` header
// carries tenant context; absent/invalid means the legacy agency-level
// workspace (tenant_id NULL, strict NULL matching).
//
// OAuth is simulated (sandbox pattern) — no live partner credentials exist.
// The handshake shape (initiate → state token → callback code exchange →
// encrypted token storage) mirrors real OAuth so live endpoints can drop in.
// ---------------------------------------------------------------------------

/** URL-safe partner key from a brand name, e.g. "Next Insurance" → "next-insurance". */
export function partnerKey(brand: string): string {
  return brand
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function tenantMatch(column: PgColumn, tenantId: number | null) {
  return tenantId == null ? isNull(column) : eq(column, tenantId);
}

async function partnerModules(): Promise<Module[]> {
  return db.select().from(modulesTable).where(eq(modulesTable.categorySlug, "partners"));
}

async function findPartnerModule(partnerId: string): Promise<Module | undefined> {
  const mods = await partnerModules();
  return mods.find((m) => m.partnerBrand != null && partnerKey(m.partnerBrand) === partnerId);
}

async function findConnection(
  moduleId: number,
  tenantId: number | null
): Promise<PartnerConnection | undefined> {
  const [conn] = await db
    .select()
    .from(partnerConnectionsTable)
    .where(
      and(
        eq(partnerConnectionsTable.moduleId, moduleId),
        tenantMatch(partnerConnectionsTable.tenantId, tenantId)
      )
    );
  return conn;
}

async function recordEvent(connectionId: number, eventType: string, details?: string) {
  await db.insert(partnerConnectionEventsTable).values({
    connectionId,
    eventType,
    details: details ?? null,
  });
}

/** Tenant-safe status payload — NEVER include token or oauthState fields. */
function statusPayload(
  module: Module,
  conn: PartnerConnection | undefined,
  events: Array<{ id: number; eventType: string; details: string | null; createdAt: Date }>
) {
  return {
    partnerId: partnerKey(module.partnerBrand!),
    moduleId: module.id,
    moduleName: module.name,
    partnerBrand: module.partnerBrand!,
    status: (conn?.status ?? "not_connected") as "not_connected" | "pending" | "active" | "error",
    lastSyncAt: conn?.lastSyncAt?.toISOString() ?? null,
    connectedAt: conn?.connectedAt?.toISOString() ?? null,
    lastError: conn?.lastError ?? null,
    events: events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      details: e.details,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

// ── GET /v1/partners — connection state overview for all partner modules ────
router.get("/v1/partners", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  const mods = (await partnerModules()).filter((m) => m.partnerBrand != null);
  const conns = await db
    .select()
    .from(partnerConnectionsTable)
    .where(tenantMatch(partnerConnectionsTable.tenantId, tenantId));
  const connByModule = new Map(conns.map((c) => [c.moduleId, c]));

  res.json(
    ListPartnerConnectionsResponse.parse(
      mods
        .sort((a, b) => a.partnerBrand!.localeCompare(b.partnerBrand!))
        .map((m) => {
          const conn = connByModule.get(m.id);
          return {
            partnerId: partnerKey(m.partnerBrand!),
            moduleId: m.id,
            moduleName: m.name,
            partnerBrand: m.partnerBrand!,
            isActive: m.isActive,
            status: conn?.status ?? "not_connected",
            lastSyncAt: conn?.lastSyncAt?.toISOString() ?? null,
            connectedAt: conn?.connectedAt?.toISOString() ?? null,
          };
        })
    )
  );
});

// ── POST /v1/partners/:partnerId/connect — initiate OAuth handshake ────────
router.post("/v1/partners/:partnerId/connect", async (req, res): Promise<void> => {
  const module = await findPartnerModule(req.params.partnerId);
  if (!module) {
    res.status(404).json({ error: "Partner not found" });
    return;
  }
  const tenantId = tenantIdFrom(req);
  const state = `st_${randomUUID().replace(/-/g, "")}`;

  const existing = await findConnection(module.id, tenantId);
  let connectionId: number;
  if (existing) {
    await db
      .update(partnerConnectionsTable)
      .set({ status: "pending", oauthState: state, lastError: null, updatedAt: new Date() })
      .where(eq(partnerConnectionsTable.id, existing.id));
    connectionId = existing.id;
  } else {
    const [inserted] = await db
      .insert(partnerConnectionsTable)
      .values({ tenantId, moduleId: module.id, status: "pending", oauthState: state })
      .returning({ id: partnerConnectionsTable.id });
    connectionId = inserted.id;
  }
  await recordEvent(connectionId, "connection_initiated", "OAuth handshake started (sandbox)");

  res.json(
    ConnectPartnerResponse.parse({
      partnerId: req.params.partnerId,
      status: "pending",
      // Sandbox authorization URL — a real partner OAuth endpoint drops in here.
      authorizationUrl: `https://sandbox.partner-gateway.local/oauth/authorize?partner=${req.params.partnerId}&state=${state}`,
      state,
    })
  );
});

// ── POST /v1/partners/:partnerId/callback — authorization code exchange ─────
router.post("/v1/partners/:partnerId/callback", async (req, res): Promise<void> => {
  const parsed = CompletePartnerAuthorizationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const module = await findPartnerModule(req.params.partnerId);
  if (!module) {
    res.status(404).json({ error: "Partner not found" });
    return;
  }
  const tenantId = tenantIdFrom(req);
  const conn = await findConnection(module.id, tenantId);
  if (!conn || conn.status !== "pending" || !conn.oauthState) {
    res.status(400).json({ error: "No pending authorization for this partner" });
    return;
  }
  if (conn.oauthState !== parsed.data.state) {
    await db
      .update(partnerConnectionsTable)
      .set({ status: "error", lastError: "Handshake state mismatch", updatedAt: new Date() })
      .where(eq(partnerConnectionsTable.id, conn.id));
    await recordEvent(conn.id, "connection_error", "Authorization rejected: state mismatch");
    res.status(400).json({ error: "Invalid or expired handshake state" });
    return;
  }

  // Simulated token exchange — encrypt-at-rest, server-side only.
  const now = new Date();
  await db
    .update(partnerConnectionsTable)
    .set({
      status: "active",
      oauthState: null,
      accessTokenEncrypted: encryptToken(`sandbox_access_${parsed.data.code}_${randomUUID()}`),
      refreshTokenEncrypted: encryptToken(`sandbox_refresh_${randomUUID()}`),
      connectedAt: now,
      lastSyncAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(partnerConnectionsTable.id, conn.id));
  await recordEvent(conn.id, "connection_authorized", "Authorization completed; credentials stored");
  logger.info({ partnerId: req.params.partnerId, tenantId }, "Partner connection activated");

  const updated = await findConnection(module.id, tenantId);
  const events = await recentEvents(conn.id);
  res.json(CompletePartnerAuthorizationResponse.parse(statusPayload(module, updated, events)));
});

async function recentEvents(connectionId: number) {
  return db
    .select()
    .from(partnerConnectionEventsTable)
    .where(eq(partnerConnectionEventsTable.connectionId, connectionId))
    .orderBy(desc(partnerConnectionEventsTable.createdAt), desc(partnerConnectionEventsTable.id))
    .limit(20);
}

// ── GET /v1/partners/:partnerId/status — state + audit history ─────────────
router.get("/v1/partners/:partnerId/status", async (req, res): Promise<void> => {
  const module = await findPartnerModule(req.params.partnerId);
  if (!module) {
    res.status(404).json({ error: "Partner not found" });
    return;
  }
  const conn = await findConnection(module.id, tenantIdFrom(req));
  const events = conn ? await recentEvents(conn.id) : [];
  res.json(GetPartnerConnectionStatusResponse.parse(statusPayload(module, conn, events)));
});

// ── POST /v1/partners/:partnerId/disconnect — purge credentials ────────────
router.post("/v1/partners/:partnerId/disconnect", async (req, res): Promise<void> => {
  const module = await findPartnerModule(req.params.partnerId);
  if (!module) {
    res.status(404).json({ error: "Partner not found" });
    return;
  }
  const tenantId = tenantIdFrom(req);
  const conn = await findConnection(module.id, tenantId);
  if (conn) {
    await db
      .update(partnerConnectionsTable)
      .set({
        status: "not_connected",
        oauthState: null,
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        connectedAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(partnerConnectionsTable.id, conn.id));
    await recordEvent(conn.id, "disconnected", "Connection disconnected; stored credentials purged");
  }
  const updated = conn ? await findConnection(module.id, tenantId) : undefined;
  const events = conn ? await recentEvents(conn.id) : [];
  res.json(DisconnectPartnerResponse.parse(statusPayload(module, updated, events)));
});

// ── POST /v1/partners/:partnerId/webhook — partner event listener ──────────
// Server-to-server: session-exempt (see SESSION_EXEMPT_PATTERNS in routes/index).
// Only connections in "active" state accept events; every event is recorded in
// the audit log and refreshes the connection's lastSyncAt.
router.post("/v1/partners/:partnerId/webhook", async (req, res): Promise<void> => {
  const module = await findPartnerModule(req.params.partnerId);
  if (!module) {
    res.status(404).json({ error: "Partner not found" });
    return;
  }
  const body = (req.body ?? {}) as { event?: unknown; tenantId?: unknown };
  const eventName = typeof body.event === "string" && body.event.trim() ? body.event.trim() : null;
  if (!eventName) {
    res.status(400).json({ error: "Missing event name" });
    return;
  }
  // Tenant scope comes ONLY from the server-side header convention (or the
  // agency-level NULL workspace). A tenantId in the webhook body is untrusted
  // caller input and is ignored — it can never redirect an event to another
  // tenant's connection.
  const tenantId = tenantIdFrom(req);
  if (body.tenantId !== undefined) {
    logger.warn(
      { partnerId: req.params.partnerId, bodyTenantId: body.tenantId, scopedTenantId: tenantId },
      "Ignoring tenantId supplied in partner webhook body"
    );
  }

  const conn = await findConnection(module.id, tenantId);
  if (!conn || conn.status !== "active") {
    res.status(404).json({ error: "No active connection for this partner" });
    return;
  }
  const now = new Date();
  await db
    .update(partnerConnectionsTable)
    .set({ lastSyncAt: now, updatedAt: now })
    .where(eq(partnerConnectionsTable.id, conn.id));
  await recordEvent(conn.id, "webhook_received", eventName.slice(0, 500));
  res.json({ received: true });
});

export default router;
