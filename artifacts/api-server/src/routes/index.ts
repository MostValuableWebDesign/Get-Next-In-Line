import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth";
import { authorizeTenantAccess } from "../middlewares/tenantAccess";
import healthRouter from "./health";
import authRouter from "./auth";
import agencyRouter from "./agency";
import tenantsRouter from "./tenants";
import modulesRouter from "./modules";
import billingRouter from "./billing";
import adminRouter from "./admin";
import sosRouter from "./sos";
import tipPoolingRouter from "./tipPooling";
import conciergeRouter from "./concierge";
import partnersRouter from "./partners";
import operationsRouter from "./operations";
import coopRouter from "./coop";
import coopSurgeRouter from "./coopSurge";
import coopRetailRouter from "./coopRetail";
import procurementRouter from "./procurement";
import coopComplianceRouter from "./coopCompliance";
import coopSponsorshipRouter from "./coopSponsorship";
import coopCoverageRouter from "./coopCoverage";
import coopMarketingRouter from "./coopMarketing";
import ambassadorRouter from "./ambassador";
import safetyRouter from "./safety";
import emergencyRouter from "./emergency";
import gatewayRouter from "./gateway";
import publicBookingRouter from "./publicBooking";
import landingRouter from "./landing";
import campaignRedirectRouter from "./campaignRedirect";
import platformInviteJoinRouter from "./platformInviteJoin";
import walletRouter from "./wallet";
import governanceRouter from "./governance";
import coopApplicationsRouter from "./coopApplications";
import franchiseRouter from "./franchise";
import settlementRouter from "./settlement";
import reviewsRouter from "./reviews";

const router: IRouter = Router();

// ── Public routes ────────────────────────────────────────────────────────────
// These do not require an authenticated session.
router.use(healthRouter); // GET /healthz
router.use(authRouter);   // POST /auth/login, POST /auth/logout, GET /auth/me
// Public booking flow (/public/booking/:slug/...) — deliberately
// unauthenticated: customers book without an account. Slug-scoped, exposes
// only the public booking surface, and booking creation is rate limited.
router.use(publicBookingRouter);
// Public SEO landing pages (/public/landing/:slug) — server-rendered HTML
// that crawlers can read without executing the app. Read-only, slug-scoped,
// and renders only published data (profile, active services, visible reviews).
router.use(landingRouter);
// Campaign redirect links (/r/:code) — deliberately unauthenticated: ad
// clicks and crawlers hit them without a session. Logs an attribution event
// and 302s to the tenant's public landing page.
router.use(campaignRedirectRouter);
// Platform-invite fast-track flow (/join/:token, /public/coop/invites/:token)
// — deliberately unauthenticated: the invited business owner has no account
// yet. Token-validated, single-use for registration, and rate limited.
router.use(platformInviteJoinRouter);
// Local Perks wallet (/wallet/*) — deliberately unauthenticated at the staff
// session level: customers sign in with an SMS code. Code requests are rate
// limited and wallet reads require an unguessable session token carried in
// an HttpOnly cookie (never readable from JavaScript).
router.use(walletRouter);
// Public co-op join application flow (/public/coop/applications) —
// deliberately unauthenticated: the applying business has no account yet.
// Rate limited; the review queue lives behind the governance console.
router.use(coopApplicationsRouter);

// ── Protected routes ─────────────────────────────────────────────────────────
// All routes below this middleware require a valid session — except the
// Twilio inbound webhook, which is called by Twilio (no session) and is
// authenticated by its own X-Twilio-Signature validation inside the handler.
// Exported for the regression test that guards this list against silent
// growth — every entry here is a session-auth bypass.
export const SESSION_EXEMPT_PATHS = new Set([
  "/sos/twilio/inbound",
  "/sos/twilio/status",
  "/sos/twilio/voice",
  "/sos/twilio/voice/recording",
]);
// Parameterized session-auth bypasses (paths with dynamic segments that a
// static Set can't express). Same guarded-growth rule applies: every pattern
// here is a session-auth bypass and must carry its own authentication story.
// Partner webhooks (/v1/partners/:id/webhook) are HMAC-signed and mounted in
// app.ts with express.raw() BEFORE the session middleware — they never reach
// this router, so no exemption pattern is needed here.
export const SESSION_EXEMPT_PATTERNS: RegExp[] = [
  // Public Co-Op Developer API Gateway: server-to-server calls from
  // developer systems, authenticated by per-tenant bearer tokens inside the
  // gateway router (rotation/revocation enforced there). Never session-authed.
  /^\/v1\/gateway\//,
];
router.use((req, res, next) => {
  if (SESSION_EXEMPT_PATHS.has(req.path) || SESSION_EXEMPT_PATTERNS.some((p) => p.test(req.path))) {
    next();
    return;
  }
  requireAuth(req, res, next);
});
// User↔tenant authorization: after session auth, verify the session user may
// act on every tenant the request references (x-tenant-id header, URL param,
// query, or body). Platform admins pass everywhere; members are restricted
// to their tenants. Session-exempt webhook paths skip this too — they carry
// their own authentication and tenant resolution.
router.use((req, res, next) => {
  if (SESSION_EXEMPT_PATHS.has(req.path) || SESSION_EXEMPT_PATTERNS.some((p) => p.test(req.path))) {
    next();
    return;
  }
  authorizeTenantAccess(req, res, next).catch(next);
});
router.use(sosRouter);    // SOS operations section of GNIL OS (behind the same session auth)
router.use(tipPoolingRouter); // Co-op tip pooling & gratuity splitter (/sos/tip-pooling)
router.use(agencyRouter);
router.use(settlementRouter); // Master Overview & Settlement Clearinghouse (/agency/master-overview, /agency/settlement)
router.use(tenantsRouter);
router.use(reviewsRouter); // Tenant review management (public landing page reviews)
router.use(modulesRouter);
router.use(billingRouter);
router.use(adminRouter);
router.use(conciergeRouter); // AI Concierge & Automation module
router.use(partnersRouter); // Partner-Direct Integrations proxy engine (/v1/partners)
router.use(operationsRouter); // Provider-agnostic Operations Integration Hub
router.use(coopRouter);     // Merchant co-op partnerships (/coop)
router.use(coopSurgeRouter); // Surge pricing & traffic balancing (/coop/capacity, /coop/surge-*)
router.use(coopRetailRouter); // Co-op shelf-space retail inventory (/coop/retail)
router.use(procurementRouter); // Co-Op Supplier & Procurement Marketplace (/coop/procurement, /admin/procurement)
router.use(coopComplianceRouter); // Co-op tax & revenue compliance ledger (/coop/compliance)
router.use(coopCoverageRouter); // Co-op staff shift coverage marketplace (/coop/coverage)
router.use(coopMarketingRouter); // Co-op Marketing & Social Syndication Hub (/coop/marketing)
router.use(ambassadorRouter); // Ambassador Program merchant console (/coop/ambassador)
router.use(franchiseRouter); // Multi-Location Franchise Co-Op Controller (/franchise)
router.use(coopSponsorshipRouter); // Sponsorship Hub: boosts, wallet, admin payouts (/coop/sponsorship, /coop/wallet, /admin/coop)
router.use(gatewayRouter);  // Co-Op API gateway: token mgmt (/gateway) + public API (/v1/gateway)
router.use(safetyRouter);   // Co-op emergency & safety alert network (/coop/safety)
router.use(emergencyRouter); // Co-op emergency & crisis network broadcasts (/coop/emergency)
router.use(governanceRouter); // Network Governance: users/roles + application review (/governance)

export default router;
