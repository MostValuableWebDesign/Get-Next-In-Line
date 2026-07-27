import { Router, type IRouter, type Request } from "express";
import { randomBytes } from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  db,
  posIntegrationsTable,
  posInboundEventsTable,
  type PosIntegration,
} from "@workspace/db";
import {
  ListPosIntegrationsResponse,
  EnablePosIntegrationResponse,
  DisablePosIntegrationResponse,
  ListPosEventsResponse,
  SimulatePosEventBody,
  SimulatePosEventResponse,
} from "@workspace/api-zod";
import { encryptToken, decryptToken } from "../lib/partnerCrypto";
import {
  POS_VENDORS,
  POS_VENDOR_LABELS,
  POS_SIGNATURE_HEADERS,
  isPosVendor,
  verifyPosSignature,
  computePosSignature,
  buildSimulatedPosPayload,
  type PosVendor,
} from "../lib/posVendors";
import { processPosDelivery, type PosProcessResult } from "../lib/posEvents";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// External POS webhook connectors (Square, Clover, Boulevard, Vagaro).
//
// Merchant-facing configuration lives under /pos/* behind the normal session
// auth + tenant authorization (x-tenant-id header convention, NULL = legacy
// agency-level workspace). The inbound webhook endpoint itself is mounted in
// app.ts BEFORE express.json() (raw body needed for HMAC verification) and is
// authenticated by per-integration signing secrets, not sessions.
// ---------------------------------------------------------------------------

function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function tenantMatch(column: PgColumn, tenantId: number | null) {
  return tenantId == null ? isNull(column) : eq(column, tenantId);
}

function webhookUrl(req: Request, integration: PosIntegration): string {
  const host = req.get("host") ?? "localhost";
  const proto = req.protocol;
  return `${proto}://${host}/api/pos/webhooks/${integration.vendor}/${integration.webhookToken}`;
}

/**
 * Integration payload for the owning merchant. The signing secret IS included
 * here by design — the merchant must paste it into their POS vendor's webhook
 * configuration. This surface is session-authed and tenant-authorized; the
 * secret never appears on webhook or public responses.
 */
function serializeIntegration(req: Request, vendor: PosVendor, row: PosIntegration | undefined) {
  return {
    vendor,
    vendorLabel: POS_VENDOR_LABELS[vendor],
    status: (row?.status ?? "not_configured") as "not_configured" | "active" | "disabled",
    webhookUrl: row ? webhookUrl(req, row) : null,
    signingSecret: row ? decryptToken(row.signingSecretEncrypted) : null,
    signatureHeader: POS_SIGNATURE_HEADERS[vendor],
    lastEventAt: row?.lastEventAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
    connectedAt: row?.createdAt.toISOString() ?? null,
  };
}

async function findIntegration(
  tenantId: number | null,
  vendor: PosVendor
): Promise<PosIntegration | undefined> {
  const [row] = await db
    .select()
    .from(posIntegrationsTable)
    .where(
      and(
        eq(posIntegrationsTable.vendor, vendor),
        tenantMatch(posIntegrationsTable.tenantId, tenantId)
      )
    );
  return row;
}

// ── GET /pos/integrations — all four vendors with connection state ──────────
router.get("/pos/integrations", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  const rows = await db
    .select()
    .from(posIntegrationsTable)
    .where(tenantMatch(posIntegrationsTable.tenantId, tenantId));
  const byVendor = new Map(rows.map((r) => [r.vendor, r]));
  res.json(
    ListPosIntegrationsResponse.parse(
      POS_VENDORS.map((v) => serializeIntegration(req, v, byVendor.get(v)))
    )
  );
});

// ── POST /pos/integrations/{vendor}/enable — enable (or re-enable) ──────────
router.post("/pos/integrations/:vendor/enable", async (req, res): Promise<void> => {
  const vendor = req.params.vendor;
  if (!isPosVendor(vendor)) {
    res.status(404).json({ message: "Unknown POS vendor" });
    return;
  }
  const tenantId = tenantIdFrom(req);
  const existing = await findIntegration(tenantId, vendor);
  if (existing) {
    await db
      .update(posIntegrationsTable)
      .set({ status: "active", lastError: null, updatedAt: new Date() })
      .where(eq(posIntegrationsTable.id, existing.id));
  } else {
    await db.insert(posIntegrationsTable).values({
      tenantId,
      vendor,
      status: "active",
      webhookToken: `pwh_${randomBytes(18).toString("hex")}`,
      signingSecretEncrypted: encryptToken(`possk_${randomBytes(24).toString("hex")}`),
    });
  }
  const row = await findIntegration(tenantId, vendor);
  logger.info({ vendor, tenantId }, "POS integration enabled");
  res.json(EnablePosIntegrationResponse.parse(serializeIntegration(req, vendor, row)));
});

// ── POST /pos/integrations/{vendor}/disable — stop accepting webhooks ───────
router.post("/pos/integrations/:vendor/disable", async (req, res): Promise<void> => {
  const vendor = req.params.vendor;
  if (!isPosVendor(vendor)) {
    res.status(404).json({ message: "Unknown POS vendor" });
    return;
  }
  const tenantId = tenantIdFrom(req);
  const existing = await findIntegration(tenantId, vendor);
  if (existing) {
    await db
      .update(posIntegrationsTable)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(eq(posIntegrationsTable.id, existing.id));
  }
  const row = await findIntegration(tenantId, vendor);
  res.json(DisablePosIntegrationResponse.parse(serializeIntegration(req, vendor, row)));
});

// ── GET /pos/events — inspectable inbound event log ─────────────────────────
router.get("/pos/events", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  const vendorFilter = typeof req.query.vendor === "string" ? req.query.vendor : null;
  const rows = await db
    .select()
    .from(posInboundEventsTable)
    .where(
      and(
        tenantMatch(posInboundEventsTable.tenantId, tenantId),
        vendorFilter && isPosVendor(vendorFilter)
          ? eq(posInboundEventsTable.vendor, vendorFilter)
          : undefined
      )
    )
    .orderBy(desc(posInboundEventsTable.createdAt), desc(posInboundEventsTable.id))
    .limit(100);
  res.json(
    ListPosEventsResponse.parse(
      rows.map((r) => ({
        id: r.id,
        vendor: r.vendor,
        externalEventId: r.externalEventId,
        eventKind: r.eventKind,
        status: r.status,
        detail: r.detail,
        customerId: r.customerId,
        visitId: r.visitId,
        createdAt: r.createdAt.toISOString(),
      }))
    )
  );
});

// ── shared webhook delivery handler (used by app.ts mount + simulator) ──────
export async function handlePosDelivery(
  vendorRaw: string,
  token: string,
  rawBody: Buffer,
  signatureHeader: string | undefined
): Promise<{ http: number; body: Record<string, unknown> }> {
  if (!isPosVendor(vendorRaw)) {
    return { http: 404, body: { message: "Unknown POS vendor" } };
  }
  const vendor = vendorRaw;
  const [integration] = await db
    .select()
    .from(posIntegrationsTable)
    .where(
      and(eq(posIntegrationsTable.webhookToken, token), eq(posIntegrationsTable.vendor, vendor))
    );
  if (!integration) {
    return { http: 404, body: { message: "Unknown webhook endpoint" } };
  }
  if (integration.status !== "active") {
    return { http: 409, body: { message: "Integration is disabled" } };
  }
  const secret = decryptToken(integration.signingSecretEncrypted);
  if (!verifyPosSignature(vendor, rawBody, signatureHeader, secret)) {
    logger.warn({ vendor, integrationId: integration.id }, "POS webhook signature rejected");
    return { http: 401, body: { message: "Invalid webhook signature" } };
  }
  const result: PosProcessResult = await processPosDelivery(
    integration,
    rawBody.toString("utf8")
  );
  // Always 200 once authenticated — vendor retry loops are driven by the
  // idempotency log, not by HTTP failures on our processing outcomes.
  return { http: 200, body: { received: true, status: result.status, detail: result.detail } };
}

// ── POST /pos/simulate — dev-only vendor payload simulator ──────────────────
// Builds a vendor-shaped payload, signs it with the integration's real
// signing secret, and runs it through the exact same delivery handler the
// public webhook endpoint uses (signature verification included).
router.post("/pos/simulate", async (req, res): Promise<void> => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const body = SimulatePosEventBody.parse(req.body);
  if (!isPosVendor(body.vendor)) {
    res.status(404).json({ message: "Unknown POS vendor" });
    return;
  }
  const tenantId = tenantIdFrom(req);
  const integration = await findIntegration(tenantId, body.vendor);
  if (!integration || integration.status !== "active") {
    res.status(409).json({ message: "Enable this POS integration first" });
    return;
  }
  const payload = buildSimulatedPosPayload(body.vendor, {
    externalEventId: body.externalEventId ?? `sim_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    kind: body.kind,
    customerName: body.customerName ?? null,
    customerPhone: body.customerPhone ?? null,
    customerEmail: body.customerEmail ?? null,
    serviceType: body.serviceType ?? null,
    staffName: body.staffName ?? null,
    paymentAmount: body.paymentAmount ?? null,
    perkToken: body.perkToken ?? null,
  });
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  const secret = decryptToken(integration.signingSecretEncrypted);
  const signature = computePosSignature(body.vendor, raw, secret);
  const out = await handlePosDelivery(body.vendor, integration.webhookToken, raw, signature);
  res.status(out.http === 200 ? 200 : out.http).json(
    out.http === 200
      ? SimulatePosEventResponse.parse({
          received: true,
          status: String(out.body.status),
          detail: (out.body.detail as string | null) ?? null,
          payload: JSON.stringify(payload),
        })
      : out.body
  );
});

export default router;
