import { Router, type IRouter, type Request, type Response } from "express";
import { createHash, randomBytes } from "crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  db,
  gatewayApiTokensTable,
  gatewayApiCallsTable,
  merchantCoopPartnershipsTable,
  tenantsTable,
  type GatewayApiToken,
} from "@workspace/db";
import { aliasedTable } from "drizzle-orm";
import {
  ListGatewayTokensResponse,
  CreateGatewayTokenBody,
  CreateGatewayTokenResponse,
  RotateGatewayTokenResponse,
  RevokeGatewayTokenResponse,
  ListGatewayCallsResponse,
} from "@workspace/api-zod";
import { perkWindowOpen } from "../lib/coopPerks";
import { findWalletPass, isWalletPassToken } from "../lib/perkPasses";
import { redeemWalletPassAsTenant } from "../lib/walletRedemption";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Co-Op API & Third-Party POS Integration Gateway — tokenized developer API.
//
// Two surfaces live here:
//   1. Merchant management (/gateway/*): session-authed + tenant-authorized —
//      create/rotate/revoke bearer tokens (the token value is shown exactly
//      once) and inspect the per-tenant API call log.
//   2. Public versioned API (/v1/gateway/*): session-EXEMPT (see
//      SESSION_EXEMPT_PATTERNS in routes/index) — authenticated purely by
//      bearer token. The token binds the caller to exactly one tenant scope;
//      no header/body field can redirect a call to another tenant's data.
//
// Sandbox tokens (gwk_test_…) exercise the same routes against isolated,
// clearly flagged test fixtures and NEVER touch live perks, redemptions, or
// customer records — the only live write for a sandbox call is its call log.
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

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

function generateGatewayToken(sandbox: boolean): string {
  return `gwk_${sandbox ? "test" : "live"}_${randomBytes(24).toString("hex")}`;
}

/** Non-secret display prefix for the token list ("gwk_live_3fa9…"). */
function tokenPrefixOf(token: string): string {
  return `${token.slice(0, 13)}…`;
}

function serializeToken(t: GatewayApiToken) {
  return {
    id: t.id,
    label: t.label,
    tokenPrefix: t.tokenPrefix,
    sandbox: t.sandbox,
    status: t.status as "active" | "revoked",
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    rotatedAt: t.rotatedAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

// ── Merchant management surface (session-authed) ─────────────────────────────

router.get("/gateway/tokens", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  const rows = await db
    .select()
    .from(gatewayApiTokensTable)
    .where(tenantMatch(gatewayApiTokensTable.tenantId, tenantId))
    .orderBy(desc(gatewayApiTokensTable.createdAt), desc(gatewayApiTokensTable.id));
  res.json(ListGatewayTokensResponse.parse(rows.map(serializeToken)));
});

router.post("/gateway/tokens", async (req, res): Promise<void> => {
  const body = CreateGatewayTokenBody.parse(req.body);
  const tenantId = tenantIdFrom(req);
  const sandbox = body.sandbox ?? false;
  const token = generateGatewayToken(sandbox);
  const [row] = await db
    .insert(gatewayApiTokensTable)
    .values({
      tenantId,
      label: body.label.trim(),
      // One-way hash only — the plaintext token is returned exactly once,
      // right here, and can never be recovered afterwards.
      tokenHash: sha256(token),
      tokenPrefix: tokenPrefixOf(token),
      sandbox,
    })
    .returning();
  logger.info({ tenantId, tokenId: row.id, sandbox }, "Gateway API token created");
  res.status(201).json(CreateGatewayTokenResponse.parse({ ...serializeToken(row), token }));
});

async function findOwnToken(req: Request, res: Response): Promise<GatewayApiToken | null> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Token not found" });
    return null;
  }
  const [row] = await db
    .select()
    .from(gatewayApiTokensTable)
    .where(
      and(
        eq(gatewayApiTokensTable.id, id),
        tenantMatch(gatewayApiTokensTable.tenantId, tenantIdFrom(req))
      )
    );
  if (!row) {
    res.status(404).json({ message: "Token not found" });
    return null;
  }
  return row;
}

// Rotate: mint a new secret in place — the old value stops working instantly.
router.post("/gateway/tokens/:id/rotate", async (req, res): Promise<void> => {
  const existing = await findOwnToken(req, res);
  if (!existing) return;
  if (existing.status !== "active") {
    res.status(409).json({ message: "Revoked tokens cannot be rotated — create a new token" });
    return;
  }
  const token = generateGatewayToken(existing.sandbox);
  const now = new Date();
  const [row] = await db
    .update(gatewayApiTokensTable)
    .set({
      tokenHash: sha256(token),
      tokenPrefix: tokenPrefixOf(token),
      rotatedAt: now,
      updatedAt: now,
    })
    .where(eq(gatewayApiTokensTable.id, existing.id))
    .returning();
  logger.info({ tokenId: existing.id }, "Gateway API token rotated");
  res.json(RotateGatewayTokenResponse.parse({ ...serializeToken(row), token }));
});

router.post("/gateway/tokens/:id/revoke", async (req, res): Promise<void> => {
  const existing = await findOwnToken(req, res);
  if (!existing) return;
  const now = new Date();
  const [row] = await db
    .update(gatewayApiTokensTable)
    .set({ status: "revoked", revokedAt: existing.revokedAt ?? now, updatedAt: now })
    .where(eq(gatewayApiTokensTable.id, existing.id))
    .returning();
  logger.info({ tokenId: existing.id }, "Gateway API token revoked");
  res.json(RevokeGatewayTokenResponse.parse(serializeToken(row)));
});

// ── GET /gateway/calls — merchant-viewable API call log ─────────────────────
router.get("/gateway/calls", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  const rows = await db
    .select({
      call: gatewayApiCallsTable,
      tokenLabel: gatewayApiTokensTable.label,
    })
    .from(gatewayApiCallsTable)
    .leftJoin(gatewayApiTokensTable, eq(gatewayApiCallsTable.tokenId, gatewayApiTokensTable.id))
    .where(tenantMatch(gatewayApiCallsTable.tenantId, tenantId))
    .orderBy(desc(gatewayApiCallsTable.createdAt), desc(gatewayApiCallsTable.id))
    .limit(100);
  res.json(
    ListGatewayCallsResponse.parse(
      rows.map(({ call, tokenLabel }) => ({
        id: call.id,
        tokenLabel: tokenLabel ?? null,
        method: call.method,
        path: call.path,
        httpStatus: call.httpStatus,
        outcome: call.outcome,
        detail: call.detail,
        sandbox: call.sandbox,
        createdAt: call.createdAt.toISOString(),
      }))
    )
  );
});

// ── Public versioned developer API (/v1/gateway/*, bearer-token authed) ──────

interface GatewayAuth {
  token: GatewayApiToken;
}

/** Best-effort call log — a logging failure must never break an API response. */
async function logCall(
  req: Request,
  auth: GatewayAuth | null,
  httpStatus: number,
  outcome: string,
  detail: string | null
): Promise<void> {
  try {
    await db.insert(gatewayApiCallsTable).values({
      tokenId: auth?.token.id ?? null,
      tenantId: auth?.token.tenantId ?? null,
      method: req.method,
      path: req.path,
      httpStatus,
      outcome,
      detail,
      sandbox: auth?.token.sandbox ?? false,
    });
  } catch (err) {
    logger.error({ err, path: req.path }, "Gateway call log write failed");
  }
}

/**
 * Resolve and validate the bearer token. Every failure is answered with a
 * clear error AND (when the token maps to a known connection) logged so the
 * merchant can see rejected attempts.
 */
async function authenticate(req: Request, res: Response): Promise<GatewayAuth | null> {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) {
    await logCall(req, null, 401, "auth_failed", "Missing bearer token");
    res.status(401).json({
      error: "missing_token",
      message: "Provide your gateway API token as: Authorization: Bearer <token>",
    });
    return null;
  }
  const [row] = await db
    .select()
    .from(gatewayApiTokensTable)
    .where(eq(gatewayApiTokensTable.tokenHash, sha256(match[1])));
  if (!row) {
    await logCall(req, null, 401, "auth_failed", "Unknown or invalid token");
    res.status(401).json({ error: "invalid_token", message: "Unknown or invalid API token" });
    return null;
  }
  if (row.status !== "active") {
    await logCall(req, { token: row }, 401, "auth_failed", "Token has been revoked");
    res.status(401).json({
      error: "revoked_token",
      message: "This API token has been revoked. Create or rotate a token in the gateway settings.",
    });
    return null;
  }
  // Tenant binding comes ONLY from the token row. Any x-tenant-id header on
  // a public gateway call is untrusted caller input and is ignored.
  if (req.header("x-tenant-id")) {
    logger.warn(
      { tokenId: row.id, headerTenantId: req.header("x-tenant-id") },
      "Ignoring x-tenant-id header on public gateway call"
    );
  }
  await db
    .update(gatewayApiTokensTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(gatewayApiTokensTable.id, row.id));
  return { token: row };
}

// ── Sandbox fixtures ─────────────────────────────────────────────────────────
// Deterministic, in-code test data. Sandbox calls never read or write live
// perk, redemption, or customer rows.

export const SANDBOX_VOUCHERS = {
  valid: "WPASS-SANDBOX-VALID",
  redeemed: "WPASS-SANDBOX-REDEEMED",
  expired: "WPASS-SANDBOX-EXPIRED",
} as const;

const SANDBOX_PARTNERS = [
  {
    partnershipId: 900001,
    partnerName: "Sandbox Coffee Co.",
    perkTitle: "Free small coffee with any service",
    perkDescription: "Test partner perk — sandbox data only",
    mutualRewardTerms: null,
    perkEndsAt: null,
  },
  {
    partnershipId: 900002,
    partnerName: "Sandbox Barber Lounge",
    perkTitle: "10% off first visit",
    perkDescription: "Test partner perk — sandbox data only",
    mutualRewardTerms: null,
    perkEndsAt: null,
  },
];

function sandboxVoucherState(code: string): { valid: boolean; reason: string | null } {
  switch (code) {
    case SANDBOX_VOUCHERS.valid:
      return { valid: true, reason: null };
    case SANDBOX_VOUCHERS.redeemed:
      return { valid: false, reason: "This pass was already redeemed" };
    case SANDBOX_VOUCHERS.expired:
      return { valid: false, reason: "This pass has expired" };
    default:
      return {
        valid: false,
        reason: `Unknown sandbox voucher. Use one of: ${Object.values(SANDBOX_VOUCHERS).join(", ")}`,
      };
  }
}

// ── GET /v1/gateway/partners — the tenant's local partner directory ─────────
router.get("/v1/gateway/partners", async (req, res): Promise<void> => {
  const auth = await authenticate(req, res);
  if (!auth) return;
  if (auth.token.sandbox) {
    await logCall(req, auth, 200, "ok", `Sandbox directory (${SANDBOX_PARTNERS.length} partners)`);
    res.json({ sandbox: true, partners: SANDBOX_PARTNERS });
    return;
  }
  const tenantId = auth.token.tenantId;
  if (tenantId == null) {
    await logCall(req, auth, 200, "ok", "Legacy workspace token — no co-op directory");
    res.json({ sandbox: false, partners: [] });
    return;
  }
  const hostTenant = aliasedTable(tenantsTable, "gw_host_tenant");
  const partnerTenant = aliasedTable(tenantsTable, "gw_partner_tenant");
  const rows = await db
    .select({
      partnership: merchantCoopPartnershipsTable,
      hostName: hostTenant.brandName,
      partnerName: partnerTenant.brandName,
    })
    .from(merchantCoopPartnershipsTable)
    .innerJoin(hostTenant, eq(merchantCoopPartnershipsTable.hostTenantId, hostTenant.id))
    .innerJoin(partnerTenant, eq(merchantCoopPartnershipsTable.partnerTenantId, partnerTenant.id))
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        eq(merchantCoopPartnershipsTable.isActive, true),
        eq(merchantCoopPartnershipsTable.disputeSuspended, false),
        isNull(merchantCoopPartnershipsTable.bannedAt),
        isNull(merchantCoopPartnershipsTable.performancePausedAt),
        perkWindowOpen(),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
        )
      )
    )
    .orderBy(desc(merchantCoopPartnershipsTable.createdAt), desc(merchantCoopPartnershipsTable.id));
  const partners = rows.map(({ partnership: p, hostName, partnerName }) => ({
    partnershipId: p.id,
    partnerName: p.hostTenantId === tenantId ? partnerName : hostName,
    perkTitle: p.perkTitle,
    perkDescription: p.perkDescription,
    mutualRewardTerms: p.mutualRewardTerms,
    perkEndsAt: p.perkEndsAt ? p.perkEndsAt.toISOString() : null,
  }));
  await logCall(req, auth, 200, "ok", `Listed ${partners.length} live partner(s)`);
  res.json({ sandbox: false, partners });
});

// ── POST /v1/gateway/vouchers/validate — read-only voucher check ────────────
router.post("/v1/gateway/vouchers/validate", async (req, res): Promise<void> => {
  const auth = await authenticate(req, res);
  if (!auth) return;
  const code = typeof (req.body as { code?: unknown })?.code === "string"
    ? (req.body as { code: string }).code.trim()
    : "";
  if (!code) {
    await logCall(req, auth, 400, "invalid", "Missing voucher code");
    res.status(400).json({ error: "missing_code", message: "Provide a voucher code in `code`" });
    return;
  }
  if (auth.token.sandbox) {
    const state = sandboxVoucherState(code);
    await logCall(req, auth, 200, "ok", `Sandbox validate ${code}: ${state.valid ? "valid" : state.reason}`);
    res.json({ sandbox: true, code, valid: state.valid, reason: state.reason, perkTitle: state.valid ? SANDBOX_PARTNERS[0].perkTitle : null });
    return;
  }
  if (!isWalletPassToken(code)) {
    await logCall(req, auth, 200, "ok", `Validate ${code}: not a wallet pass token`);
    res.json({ sandbox: false, code, valid: false, reason: "Unrecognized voucher code (expected a WPASS- wallet pass token)", perkTitle: null });
    return;
  }
  const row = await findWalletPass(code);
  // Cross-tenant guard: a voucher is only inspectable by a business that is
  // party to its partnership — outsiders learn nothing beyond "not valid".
  const isParticipant =
    row != null &&
    auth.token.tenantId != null &&
    (auth.token.tenantId === row.partnership.hostTenantId ||
      auth.token.tenantId === row.partnership.partnerTenantId);
  if (!row || !isParticipant) {
    const detail = !row ? "Unknown voucher" : "Voucher belongs to another business's partnership";
    await logCall(req, auth, 200, row ? "rejected" : "ok", `Validate: ${detail}`);
    res.json({ sandbox: false, code, valid: false, reason: "Unknown or inaccessible voucher", perkTitle: null });
    return;
  }
  let reason: string | null = null;
  if (!row.partnership.isActive || row.partnership.status !== "accepted") {
    reason = "This partnership is no longer active";
  } else if (row.pass.redeemedAt != null) reason = "This pass was already redeemed";
  else if (row.pass.expiresAt <= new Date()) reason = "This pass has expired";
  await logCall(req, auth, 200, "ok", `Validate ${code}: ${reason ?? "valid"}`);
  res.json({
    sandbox: false,
    code,
    valid: reason == null,
    reason,
    perkTitle: row.partnership.perkTitle,
    expiresAt: row.pass.expiresAt.toISOString(),
  });
});

// ── POST /v1/gateway/redemptions — push a redemption in real time ───────────
router.post("/v1/gateway/redemptions", async (req, res): Promise<void> => {
  const auth = await authenticate(req, res);
  if (!auth) return;
  const code = typeof (req.body as { code?: unknown })?.code === "string"
    ? (req.body as { code: string }).code.trim()
    : "";
  if (!code) {
    await logCall(req, auth, 400, "invalid", "Missing voucher code");
    res.status(400).json({ error: "missing_code", message: "Provide a voucher code in `code`" });
    return;
  }
  if (auth.token.sandbox) {
    // Sandbox redemptions are simulated — no live rows are ever touched.
    const state = sandboxVoucherState(code);
    const status = state.valid ? "processed" : code === SANDBOX_VOUCHERS.redeemed ? "ignored" : "error";
    await logCall(req, auth, 200, "ok", `Sandbox redemption ${code}: ${status}`);
    res.json({
      sandbox: true,
      code,
      status,
      detail: state.valid ? `Sandbox voucher ${code} redeemed (simulated)` : state.reason,
    });
    return;
  }
  // Same integrity rules as native and POS-webhook redemptions: participant
  // enforcement, single-use lock, exactly-once attribution.
  const result = await redeemWalletPassAsTenant(auth.token.tenantId, code);
  const outcome = result.status === "processed" ? "ok" : result.status === "ignored" ? "ok" : "rejected";
  await logCall(req, auth, 200, outcome, result.detail);
  res.json({ sandbox: false, code, status: result.status, detail: result.detail });
});

export default router;
