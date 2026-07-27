import { Router, type IRouter } from "express";
import {
  db,
  tenantsTable,
  tenantActivitiesTable,
  sosSettingsTable,
  platformInvitesTable,
  merchantCoopPartnershipsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { randomBytes } from "crypto";
import {
  GetPublicPlatformInviteResponse,
  RegisterViaPlatformInviteBody,
  RegisterViaPlatformInviteResponse,
} from "@workspace/api-zod";
import { INVITE_TOKEN_RE, effectiveInviteStatus } from "../lib/platformInvites";
import { logger } from "../lib/logger";

// ── Public platform-invite flow ──────────────────────────────────────────────
// Deliberately unauthenticated: the invited business owner has no account yet.
// GET  /join/:token                      — trackable link: marks clicked, 302s
//                                          to the SPA fast-track page.
// GET  /public/coop/invites/:token       — invite context for the page.
// POST /public/coop/invites/:token/register — creates the tenant + storefront,
//                                          marks the invite registered
//                                          (single-use), and auto-creates the
//                                          pending co-op partnership from the
//                                          inviter (same-industry guardrail
//                                          still applies).

const router: IRouter = Router();

// ── Abuse guard: per-IP fixed-window rate limit on registration ─────────────
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const registerAttempts = new Map<string, { windowStart: number; count: number }>();

function isRateLimited(ip: string, now = Date.now()): boolean {
  const entry = registerAttempts.get(ip);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    registerAttempts.set(ip, { windowStart: now, count: 1 });
    if (registerAttempts.size > 10_000) {
      for (const [key, val] of registerAttempts) {
        if (now - val.windowStart >= RATE_LIMIT_WINDOW_MS) registerAttempts.delete(key);
      }
    }
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX_ATTEMPTS;
}

/** Test-only hook so integration tests don't trip each other's limits. */
export function __resetPlatformInviteRateLimit(): void {
  registerAttempts.clear();
}

async function findInvite(rawToken: string) {
  const token = String(rawToken || "").toLowerCase();
  if (!INVITE_TOKEN_RE.test(token)) return null;
  const [row] = await db
    .select({
      invite: platformInvitesTable,
      inviterName: tenantsTable.brandName,
      inviterId: tenantsTable.id,
    })
    .from(platformInvitesTable)
    .innerJoin(tenantsTable, eq(platformInvitesTable.inviterTenantId, tenantsTable.id))
    .where(eq(platformInvitesTable.token, token));
  return row ?? null;
}

/** Best-effort sent → clicked transition; must never block the visitor. */
async function markClicked(inviteId: number): Promise<void> {
  try {
    await db
      .update(platformInvitesTable)
      .set({ status: "clicked", clickedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(platformInvitesTable.id, inviteId), eq(platformInvitesTable.status, "sent"))
      );
  } catch (err) {
    logger.error({ err, inviteId }, "Failed to mark platform invite clicked");
  }
}

// ── GET /join/:token — the trackable link itself ─────────────────────────────
router.get("/join/:token", async (req, res): Promise<void> => {
  const row = await findInvite(req.params.token);
  if (!row) {
    res
      .status(404)
      .type("text/plain")
      .send("This invitation link isn't valid. Please ask the business that invited you for a new one.");
    return;
  }
  if (effectiveInviteStatus(row.invite) === "clicked" || row.invite.status === "sent") {
    await markClicked(row.invite.id);
  }
  // The SPA renders the friendly expired/used states itself.
  res.redirect(302, `/join/${encodeURIComponent(row.invite.token)}`);
});

// ── GET /public/coop/invites/:token — context for the registration page ─────
router.get("/public/coop/invites/:token", async (req, res): Promise<void> => {
  const row = await findInvite(req.params.token);
  if (!row) {
    res.status(404).json({ message: "This invitation link isn't valid." });
    return;
  }
  const status = effectiveInviteStatus(row.invite);
  if (status === "clicked" && row.invite.status === "sent") {
    await markClicked(row.invite.id);
  }
  res.json(
    GetPublicPlatformInviteResponse.parse({
      inviterBusinessName: row.inviterName,
      invitedBusinessName: row.invite.invitedBusinessName,
      status,
    })
  );
});

/** Same lowercase comparison the merchant-facing guardrail uses. */
function industryKey(
  s: { businessCategory: string; industryType: string } | null | undefined
): string | null {
  if (!s) return null;
  const cat = s.businessCategory.trim() || s.industryType.trim();
  return cat ? cat.toLowerCase() : null;
}

// ── POST /public/coop/invites/:token/register — fast-track registration ─────
router.post("/public/coop/invites/:token/register", async (req, res): Promise<void> => {
  const ip = req.ip ?? "unknown";
  if (isRateLimited(ip)) {
    res.status(429).json({ message: "Too many attempts. Please try again later." });
    return;
  }

  const parsed = RegisterViaPlatformInviteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const row = await findInvite(req.params.token);
  if (!row) {
    res.status(404).json({ message: "This invitation link isn't valid." });
    return;
  }
  const status = effectiveInviteStatus(row.invite);
  if (status === "registered") {
    res.status(409).json({ message: "This invitation has already been used." });
    return;
  }
  if (status === "expired") {
    res.status(410).json({ message: "This invitation has expired. Ask the business that invited you for a new link." });
    return;
  }

  const brandName = parsed.data.businessName.trim();
  const subdomain = parsed.data.subdomain.trim().toLowerCase();
  const contactName = parsed.data.contactName?.trim() || null;
  const contactEmail = parsed.data.contactEmail?.trim() || null;
  const category = parsed.data.category?.trim() || null;
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    res.status(400).json({ message: "That email address doesn't look right." });
    return;
  }
  const [subdomainTaken] = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.subdomain, subdomain));
  if (subdomainTaken) {
    res.status(409).json({ message: "That web address is already taken — try another." });
    return;
  }

  // Everything (tenant + storefront + invite consumption + partnership) in one
  // transaction: the conditional invite update is the single-use guard — two
  // concurrent registrations race on it and the loser rolls back cleanly.
  type Outcome =
    | { kind: "used" }
    | {
        kind: "registered";
        tenantId: number;
        partnershipCreated: boolean;
        partnershipBlockedReason: string | null;
      };
  let outcome: Outcome;
  try {
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      const [consumed] = await tx
        .update(platformInvitesTable)
        .set({ status: "registered", registeredAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(platformInvitesTable.id, row.invite.id),
            inArray(platformInvitesTable.status, ["sent", "clicked"])
          )
        )
        .returning({ id: platformInvitesTable.id });
      if (!consumed) return { kind: "used" as const };

      // Same provisioning shape as the admin flow (routes/tenants.ts).
      const [tenant] = await tx
        .insert(tenantsTable)
        .values({
          brandName,
          subdomain,
          contactEmail,
          contactName,
          status: "active",
          mrr: "0",
          modulesEnabled: 0,
        })
        .returning();
      await tx.insert(tenantActivitiesTable).values({
        tenantId: tenant.id,
        action: "Tenant provisioned",
        details: `${tenant.brandName}.${tenant.subdomain}.getnextinline.io deployed via platform invite from ${row.inviterName}`,
      });
      // Storefront settings row (what the public landing/booking pages read).
      await tx.insert(sosSettingsTable).values({
        tenantId: tenant.id,
        businessName: brandName,
        ...(category ? { businessCategory: category } : {}),
      });
      await tx
        .update(platformInvitesTable)
        .set({ resultingTenantId: tenant.id, updatedAt: new Date() })
        .where(eq(platformInvitesTable.id, row.invite.id));

      // Auto-create the pending co-op partnership from the inviter — unless
      // the same-industry guardrail blocks the pairing (registration still
      // succeeds; they just don't get an automatic partnership request).
      const [inviterSettings] = await tx
        .select({
          businessCategory: sosSettingsTable.businessCategory,
          industryType: sosSettingsTable.industryType,
        })
        .from(sosSettingsTable)
        .where(eq(sosSettingsTable.tenantId, row.inviterId));
      const mine = industryKey(inviterSettings);
      const theirs = category ? category.toLowerCase() : null;
      if (mine != null && theirs != null && mine === theirs) {
        return {
          kind: "registered" as const,
          tenantId: tenant.id,
          partnershipCreated: false,
          partnershipBlockedReason:
            "Same-industry pairings are restricted by platform guidelines.",
        };
      }
      await tx.insert(merchantCoopPartnershipsTable).values({
        hostTenantId: row.inviterId,
        partnerTenantId: tenant.id,
        perkTitle: `Cross-promotion perk with ${row.inviterName}`,
        perkDescription: `Proposed automatically when ${brandName} joined through ${row.inviterName}'s invitation. Edit or accept it from your Co-Op hub.`,
        redemptionCode: generateCode(),
        requestedByTenantId: row.inviterId,
        status: "pending",
        isActive: false,
      });
      return {
        kind: "registered" as const,
        tenantId: tenant.id,
        partnershipCreated: true,
        partnershipBlockedReason: null,
      };
    });
  } catch (err) {
    const pgCode =
      (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    if (pgCode === "23505") {
      res.status(409).json({ message: "That web address is already taken — try another." });
      return;
    }
    throw err;
  }

  if (outcome.kind === "used") {
    res.status(409).json({ message: "This invitation has already been used." });
    return;
  }

  logger.info(
    { inviteId: row.invite.id, tenantId: outcome.tenantId, inviterTenantId: row.inviterId },
    "Platform invite registration completed"
  );
  res.status(201).json(
    RegisterViaPlatformInviteResponse.parse({
      tenantId: outcome.tenantId,
      subdomain,
      brandName,
      partnershipCreated: outcome.partnershipCreated,
      partnershipBlockedReason: outcome.partnershipBlockedReason,
    })
  );
});

/** Random, human-readable redemption code (same alphabet as coop.ts). */
function generateCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `COOP-${out}`;
}

export default router;
