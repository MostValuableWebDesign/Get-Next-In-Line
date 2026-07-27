import { Router, type Request, type IRouter } from "express";
import { randomBytes, randomInt } from "crypto";
import {
  db,
  perkPassesTable,
  merchantCoopPartnershipsTable,
  tenantsTable,
  walletLoginCodesTable,
  walletSessionsTable,
  type PerkPass,
  type MerchantCoopPartnership,
  type WalletSession,
} from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  RequestWalletLoginCodeBody,
  RequestWalletLoginCodeResponse,
  VerifyWalletLoginCodeBody,
  VerifyWalletLoginCodeResponse,
  ListWalletPassesResponse,
  GetWalletPassResponse,
} from "@workspace/api-zod";
import { normalizeToE164 } from "../lib/sms";
import { sendMessageSafe } from "../lib/messaging";
import { redeemAtSide } from "../lib/perkPasses";

// ── Local Perks wallet — public (customer-facing) API ────────────────────────
// Deliberately unauthenticated at the session level: customers sign in with
// their phone number via an SMS code. Registered BEFORE the staff session
// middleware. Wallet reads are gated by an unguessable bearer session token
// (x-wallet-session header) minted only after SMS verification.

const router: IRouter = Router();

const CODE_TTL_MS = 10 * 60 * 1000; // login code lifetime
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // wallet session lifetime
const MAX_VERIFY_ATTEMPTS = 5;

// ── Abuse guard: fixed-window rate limit on code requests ───────────────────
// Keyed by both the requesting IP and the target phone so neither can be
// used to spam SMS. Same in-process pattern as the public booking limiter.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const codeRequests = new Map<string, { windowStart: number; count: number }>();

function isRateLimited(key: string, now = Date.now()): boolean {
  const entry = codeRequests.get(key);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    codeRequests.set(key, { windowStart: now, count: 1 });
    if (codeRequests.size > 10_000) {
      for (const [k, v] of codeRequests) {
        if (now - v.windowStart >= RATE_LIMIT_WINDOW_MS) codeRequests.delete(k);
      }
    }
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

/** Test-only hook so integration tests don't trip each other's limits. */
export function __resetWalletRateLimit(): void {
  codeRequests.clear();
}

/** Resolve the wallet session from the x-wallet-session bearer header. */
async function sessionFrom(req: Request): Promise<WalletSession | null> {
  const token = req.header("x-wallet-session")?.trim();
  if (!token) return null;
  const [session] = await db
    .select()
    .from(walletSessionsTable)
    .where(and(eq(walletSessionsTable.token, token), gt(walletSessionsTable.expiresAt, new Date())));
  return session ?? null;
}

// ── POST /wallet/login/request — send an SMS verification code ──────────────
router.post("/wallet/login/request", async (req, res): Promise<void> => {
  const parsed = RequestWalletLoginCodeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const phone = normalizeToE164(parsed.data.phone);
  if (!phone) {
    res.status(400).json({ message: "Enter a valid mobile phone number" });
    return;
  }
  const ip = req.ip || "unknown";
  if (isRateLimited(`ip:${ip}`) || isRateLimited(`phone:${phone}`)) {
    res.status(429).json({ message: "Too many code requests — try again in a few minutes" });
    return;
  }

  // 6-digit code, crypto-random. Stored server-side, never echoed in the API.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.insert(walletLoginCodesTable).values({
    phone,
    code,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  // Uses the shared messaging service — simulated-SMS fallback applies when
  // Twilio isn't configured, and the send is audited in `messages`.
  await sendMessageSafe({
    tenantId: null,
    toNumber: phone,
    kind: "wallet_login_code",
    body: `Your Local Perks sign-in code is ${code}. It expires in 10 minutes.`,
  });

  res.json(RequestWalletLoginCodeResponse.parse({ sent: true, phone }));
});

// ── POST /wallet/login/verify — exchange the code for a session token ───────
router.post("/wallet/login/verify", async (req, res): Promise<void> => {
  const parsed = VerifyWalletLoginCodeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const phone = normalizeToE164(parsed.data.phone);
  const code = parsed.data.code.trim();
  if (!phone || !code) {
    res.status(400).json({ message: "Phone and code are required" });
    return;
  }

  const [pending] = await db
    .select()
    .from(walletLoginCodesTable)
    .where(
      and(
        eq(walletLoginCodesTable.phone, phone),
        isNull(walletLoginCodesTable.consumedAt),
        gt(walletLoginCodesTable.expiresAt, new Date())
      )
    )
    .orderBy(desc(walletLoginCodesTable.createdAt), desc(walletLoginCodesTable.id))
    .limit(1);
  if (!pending) {
    res.status(400).json({ message: "Code expired or not found — request a new one" });
    return;
  }
  if (pending.attempts >= MAX_VERIFY_ATTEMPTS) {
    res.status(429).json({ message: "Too many attempts — request a new code" });
    return;
  }
  if (pending.code !== code) {
    await db
      .update(walletLoginCodesTable)
      .set({ attempts: sql`${walletLoginCodesTable.attempts} + 1` })
      .where(eq(walletLoginCodesTable.id, pending.id));
    res.status(400).json({ message: "That code doesn't match — check the text and try again" });
    return;
  }

  // Conditional consume: a concurrent double-submit of the same code mints
  // exactly one session.
  const [consumed] = await db
    .update(walletLoginCodesTable)
    .set({ consumedAt: new Date() })
    .where(and(eq(walletLoginCodesTable.id, pending.id), isNull(walletLoginCodesTable.consumedAt)))
    .returning({ id: walletLoginCodesTable.id });
  if (!consumed) {
    res.status(400).json({ message: "Code expired or not found — request a new one" });
    return;
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const [session] = await db
    .insert(walletSessionsTable)
    .values({ token: randomBytes(32).toString("base64url"), phone, expiresAt })
    .returning();
  res.json(
    VerifyWalletLoginCodeResponse.parse({
      token: session.token,
      phone,
      expiresAt: expiresAt.toISOString(),
    })
  );
});

// ── pass serialization ───────────────────────────────────────────────────────

function passStatus(p: PerkPass, now = new Date()): "active" | "redeemed" | "expired" {
  if (p.redeemedAt != null) return "redeemed";
  if (p.expiresAt <= now) return "expired";
  return "active";
}

function serializePass(
  p: PerkPass,
  partnership: MerchantCoopPartnership,
  hostTenantName: string,
  partnerTenantName: string
) {
  // The business to redeem at is the other side of the partnership relative
  // to the business whose checkout granted the pass.
  const side = redeemAtSide(partnership, p.grantedByTenantId);
  return {
    id: p.id,
    perkTitle: partnership.perkTitle,
    perkDescription: partnership.perkDescription,
    redeemAtBusinessName: side === "partner" ? partnerTenantName : hostTenantName,
    grantedByBusinessName: side === "partner" ? hostTenantName : partnerTenantName,
    status: passStatus(p),
    token: p.token,
    grantedAt: p.grantedAt.toISOString(),
    expiresAt: p.expiresAt.toISOString(),
    redeemedAt: p.redeemedAt ? p.redeemedAt.toISOString() : null,
  };
}

function passRows() {
  const hostTenant = alias(tenantsTable, "wallet_host_tenant");
  const partnerTenant = alias(tenantsTable, "wallet_partner_tenant");
  return db
    .select({
      pass: perkPassesTable,
      partnership: merchantCoopPartnershipsTable,
      hostTenantName: hostTenant.brandName,
      partnerTenantName: partnerTenant.brandName,
    })
    .from(perkPassesTable)
    .innerJoin(
      merchantCoopPartnershipsTable,
      eq(perkPassesTable.partnershipId, merchantCoopPartnershipsTable.id)
    )
    .innerJoin(hostTenant, eq(merchantCoopPartnershipsTable.hostTenantId, hostTenant.id))
    .innerJoin(partnerTenant, eq(merchantCoopPartnershipsTable.partnerTenantId, partnerTenant.id));
}

// ── GET /wallet/passes — all of the customer's passes, newest first ─────────
router.get("/wallet/passes", async (req, res): Promise<void> => {
  const session = await sessionFrom(req);
  if (!session) {
    res.status(401).json({ message: "Wallet session required" });
    return;
  }
  const rows = await passRows()
    .where(eq(perkPassesTable.customerPhone, session.phone))
    .orderBy(desc(perkPassesTable.grantedAt), desc(perkPassesTable.id));
  res.json(
    ListWalletPassesResponse.parse({
      phone: session.phone,
      passes: rows.map((r) =>
        serializePass(r.pass, r.partnership, r.hostTenantName, r.partnerTenantName)
      ),
    })
  );
});

// ── GET /wallet/passes/:id — one pass with its QR payload ───────────────────
router.get("/wallet/passes/:id", async (req, res): Promise<void> => {
  const session = await sessionFrom(req);
  if (!session) {
    res.status(401).json({ message: "Wallet session required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Pass not found" });
    return;
  }
  const [row] = await passRows().where(
    and(eq(perkPassesTable.id, id), eq(perkPassesTable.customerPhone, session.phone))
  );
  if (!row) {
    res.status(404).json({ message: "Pass not found" });
    return;
  }
  res.json(
    GetWalletPassResponse.parse({
      ...serializePass(row.pass, row.partnership, row.hostTenantName, row.partnerTenantName),
      // The QR payload staff scan at the partner storefront.
      qrPayload: row.pass.token,
    })
  );
});

export default router;
