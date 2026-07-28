import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { db, coopApplicationsTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  SubmitCoopApplicationBody,
  SubmitCoopApplicationResponse,
  GetPublicCoopApplicationStatusResponse,
} from "@workspace/api-zod";

// ── Public co-op join application flow ───────────────────────────────────────
// Deliberately unauthenticated: the applying business has no account yet.
// POST /public/coop/applications           — submit an application (rate limited)
// GET  /public/coop/applications/:token    — applicant-facing status page data
// Review/approval lives behind the governance console (routes/governance.ts).

const router: IRouter = Router();

// Per-IP fixed-window rate limit (same pattern as platformInviteJoin.ts).
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const attempts = new Map<string, { windowStart: number; count: number }>();

function isRateLimited(ip: string, now = Date.now()): boolean {
  const entry = attempts.get(ip);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    attempts.set(ip, { windowStart: now, count: 1 });
    if (attempts.size > 10_000) {
      for (const [key, val] of attempts) {
        if (now - val.windowStart >= RATE_LIMIT_WINDOW_MS) attempts.delete(key);
      }
    }
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX_ATTEMPTS;
}

/** Test-only hook so integration tests don't trip each other's limits. */
export function __resetCoopApplicationRateLimit(): void {
  attempts.clear();
}

const TOKEN_RE = /^[a-f0-9]{32}$/;

router.post("/public/coop/applications", async (req, res): Promise<void> => {
  const ip = req.ip ?? "unknown";
  if (isRateLimited(ip)) {
    res.status(429).json({ message: "Too many attempts. Please try again later." });
    return;
  }
  const parsed = SubmitCoopApplicationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const businessName = parsed.data.businessName.trim();
  const subdomain = parsed.data.subdomain.trim().toLowerCase();
  const contactEmail = parsed.data.contactEmail?.trim() || null;
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(subdomain)) {
    res.status(400).json({ message: "Web address may only contain letters, numbers, and dashes." });
    return;
  }
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    res.status(400).json({ message: "That email address doesn't look right." });
    return;
  }
  // Friendly early check; approval re-checks (an application is not a claim).
  const [taken] = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.subdomain, subdomain));
  if (taken) {
    res.status(409).json({ message: "That web address is already taken — try another." });
    return;
  }
  const statusToken = randomBytes(16).toString("hex");
  const [app] = await db
    .insert(coopApplicationsTable)
    .values({
      businessName,
      subdomain,
      contactName: parsed.data.contactName?.trim() || null,
      contactEmail,
      category: parsed.data.category?.trim() || null,
      pitch: parsed.data.pitch?.trim() || null,
      statusToken,
    })
    .returning();
  res.status(201).json(
    SubmitCoopApplicationResponse.parse({
      id: app.id,
      statusToken,
      status: app.status,
    }),
  );
});

router.get("/public/coop/applications/:token", async (req, res): Promise<void> => {
  const token = String(req.params.token || "").toLowerCase();
  if (!TOKEN_RE.test(token)) {
    res.status(404).json({ message: "Application not found." });
    return;
  }
  const [app] = await db
    .select()
    .from(coopApplicationsTable)
    .where(eq(coopApplicationsTable.statusToken, token));
  if (!app) {
    res.status(404).json({ message: "Application not found." });
    return;
  }
  res.json(
    GetPublicCoopApplicationStatusResponse.parse({
      businessName: app.businessName,
      status: app.status,
      // Vetting notes stay internal; only the rejection reason is shared.
      rejectionReason: app.status === "rejected" ? app.rejectionReason : null,
      submittedAt: app.createdAt.toISOString(),
    }),
  );
});

export default router;
