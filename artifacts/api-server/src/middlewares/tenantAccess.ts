import type { Request, Response, NextFunction } from "express";
import { db, userTenantMembershipsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// User↔tenant authorization — the single tenant-authorization layer for all
// tenant-scoped route families (SOS, concierge, co-op, tenants, partners,
// billing). It resolves every tenant the request *claims to act on* — the
// x-tenant-id header, a /tenants/:id URL param, tenantId in the query string,
// and acting-tenant fields in the body — and verifies the session user is a
// member of each (or a platform admin) before any handler runs.
//
// Notes on scope resolution:
// - Counterparty fields (e.g. partnerTenantId on a co-op invite) are NOT
//   acting scopes and are deliberately not checked — inviting another tenant
//   is legitimate; acting *as* them is not.
// - A request with no tenant reference at all runs in the legacy/global
//   scope (NULL-tenant rows only). SOS routes additionally require that
//   scope to be requested explicitly (`x-tenant-id: legacy`) and reject
//   missing/malformed headers with 400 — that stricter contract lives in
//   lib/tenantScope.ts; this middleware only authorizes numeric refs.
// - Invalid tenant values (non-numeric, <= 0) carry no membership claim and
//   are ignored here; the routes themselves decide whether to reject them.
// ---------------------------------------------------------------------------

function toTenantId(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Every tenant id the request references as an acting scope. */
export function tenantRefsFrom(req: Request): number[] {
  const refs = new Set<number>();

  const header = toTenantId(req.header("x-tenant-id"));
  if (header != null) refs.add(header);

  // URL param: /tenants/:id/... (settings, engagement rules, client
  // profiles, message logs, modules, tenant record itself).
  const m = req.path.match(/^\/tenants\/(\d+)(?:\/|$)/);
  if (m) {
    const fromPath = toTenantId(m[1]);
    if (fromPath != null) refs.add(fromPath);
  }

  // Query: e.g. GET /coop/partnerships?tenantId=, GET /tenants/activity?tenantId=
  const fromQuery = toTenantId((req.query as Record<string, unknown>).tenantId);
  if (fromQuery != null) refs.add(fromQuery);

  // Body: tenantId (concierge dispatch/suggest, billing checkout) and
  // hostTenantId (admin-created co-op partnerships act as the host).
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    const body = req.body as Record<string, unknown>;
    for (const key of ["tenantId", "hostTenantId"]) {
      const fromBody = toTenantId(body[key]);
      if (fromBody != null) refs.add(fromBody);
    }
  }

  return [...refs];
}

/**
 * Surfaces that are platform-admin-only regardless of tenant references:
 * the agency console, the admin console, tenant provisioning/listing, and
 * the unscoped activity feed (which spans every tenant).
 */
function isPlatformAdminOnly(req: Request): boolean {
  if (req.path.startsWith("/agency") || req.path.startsWith("/admin")) return true;
  if (req.path === "/tenants" || req.path === "/tenants/") return true; // list/create
  // Cross-tenant financial aggregates (revenue, MRR, top tenants).
  if (req.path === "/billing/summary") return true;
  // Cross-tenant module rosters (which tenants run which modules).
  if (req.path === "/modules/tenant-counts" || /^\/modules\/\d+\/tenants$/.test(req.path)) {
    return true;
  }
  // Admin-console co-op partnership management: the unscoped list spans all
  // tenants, and the direct edit route is not tenant-scoped (merchants use
  // the invite/respond flow instead).
  if (req.path === "/coop/partnerships" && req.method === "GET" && toTenantId((req.query as Record<string, unknown>).tenantId) == null) {
    return true;
  }
  if (/^\/coop\/partnerships\/\d+$/.test(req.path)) return true; // PATCH edit
  if (req.path === "/coop/partnerships" && req.method === "POST") {
    // Creation is allowed for members acting as the host tenant — the
    // hostTenantId body ref is membership-checked below. (Nothing to do
    // here; listed for completeness of the classification.)
    return false;
  }
  if (req.path === "/tenants/activity" && toTenantId((req.query as Record<string, unknown>).tenantId) == null) {
    return true; // cross-tenant feed
  }
  // Plaza exclusivity dispute console: the conflict list spans all tenants,
  // and releasing an exclusivity is an admin-only override — never tenant-facing.
  if (req.path === "/coop/plaza-conflicts" || /^\/coop\/plaza-conflicts\/\d+\/release$/.test(req.path)) {
    return true;
  }
  return false;
}

/** True when the session belongs to a platform admin. Sessions created
 *  before the user model existed (authenticated, no userId) are the
 *  password-authenticated platform operator — treated as admin so nothing
 *  visibly breaks for existing single-operator workflows. */
export function sessionIsPlatformAdmin(req: Request): boolean {
  const s = req.session;
  if (!s?.authenticated) return false;
  return s.isPlatformAdmin === true || s.userId == null;
}

/**
 * Tenant authorization middleware. Mount AFTER session auth: it assumes the
 * session is already authenticated and only decides *which tenants* the
 * session may act on.
 */
export async function authorizeTenantAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (sessionIsPlatformAdmin(req)) {
    next();
    return;
  }

  const role = req.session?.role ?? "staff";

  if (isPlatformAdminOnly(req)) {
    // Every signed-in role may READ the tenant list — the route filters it
    // to the session user's memberships (district managers see their
    // district, merchants/staff their own business, nobody else's).
    // Everything else on the admin-only surface stays super-admin.
    const scopedListRead =
      (req.method === "GET" || req.method === "HEAD") &&
      (req.path === "/tenants" || req.path === "/tenants/");
    if (!scopedListRead) {
      res.status(403).json({
        error: "Forbidden",
        message: "This operation requires platform administrator access",
      });
      return;
    }
  }

  // Staff have read/operational access: on the governed management surfaces
  // (tenant management and co-op routes) they may look but not change.
  // Checkout-counter verification flows are the deliberate exception — staff
  // scan/enter customer reward codes at the register, exactly like perk
  // redemption, so those POSTs stay open to staff (membership still checked).
  const staffOperationalPost =
    req.method === "POST" && req.path === "/coop/ambassador/rewards/redeem";
  if (
    role === "staff" &&
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    !staffOperationalPost &&
    (req.path.startsWith("/tenants") || req.path.startsWith("/coop"))
  ) {
    res.status(403).json({
      error: "Forbidden",
      message: "Staff accounts have read-only access to this area",
    });
    return;
  }

  const refs = tenantRefsFrom(req);
  if (refs.length === 0) {
    // Legacy/global scope: touches only NULL-tenant rows, same as before.
    next();
    return;
  }

  const userId = req.session.userId;
  if (userId == null) {
    // Authenticated non-admin session with no user identity should not
    // exist; refuse rather than guess.
    res.status(403).json({ error: "Forbidden", message: "No user identity on session" });
    return;
  }

  const rows = await db
    .select({ tenantId: userTenantMembershipsTable.tenantId })
    .from(userTenantMembershipsTable)
    .where(
      and(
        eq(userTenantMembershipsTable.userId, userId),
        inArray(userTenantMembershipsTable.tenantId, refs),
      ),
    );
  const allowed = new Set(rows.map((r) => r.tenantId));
  const denied = refs.filter((id) => !allowed.has(id));
  if (denied.length > 0) {
    res.status(403).json({
      error: "Forbidden",
      message: `You do not have access to tenant ${denied.join(", ")}`,
    });
    return;
  }
  next();
}
