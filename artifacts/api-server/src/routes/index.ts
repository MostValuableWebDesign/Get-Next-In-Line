import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth";
import healthRouter from "./health";
import authRouter from "./auth";
import agencyRouter from "./agency";
import tenantsRouter from "./tenants";
import modulesRouter from "./modules";
import billingRouter from "./billing";
import adminRouter from "./admin";
import sosRouter from "./sos";
import conciergeRouter from "./concierge";
import partnersRouter from "./partners";
import publicBookingRouter from "./publicBooking";

const router: IRouter = Router();

// ── Public routes ────────────────────────────────────────────────────────────
// These do not require an authenticated session.
router.use(healthRouter); // GET /healthz
router.use(authRouter);   // POST /auth/login, POST /auth/logout, GET /auth/me
// Public booking flow (/public/booking/:slug/...) — deliberately
// unauthenticated: customers book without an account. Slug-scoped, exposes
// only the public booking surface, and booking creation is rate limited.
router.use(publicBookingRouter);

// ── Protected routes ─────────────────────────────────────────────────────────
// All routes below this middleware require a valid session — except the
// Twilio inbound webhook, which is called by Twilio (no session) and is
// authenticated by its own X-Twilio-Signature validation inside the handler.
// Exported for the regression test that guards this list against silent
// growth — every entry here is a session-auth bypass.
export const SESSION_EXEMPT_PATHS = new Set([
  "/sos/twilio/inbound",
  "/sos/twilio/status",
]);
// Parameterized session-auth bypasses (paths with dynamic segments that a
// static Set can't express). Same guarded-growth rule applies: every pattern
// here is a session-auth bypass and must carry its own authentication story.
// Partner webhooks are server-to-server calls from partner platforms (no
// session; sandbox pattern — signature verification drops in with real creds).
export const SESSION_EXEMPT_PATTERNS: RegExp[] = [
  /^\/v1\/partners\/[a-z0-9-]+\/webhook$/,
];
router.use((req, res, next) => {
  if (SESSION_EXEMPT_PATHS.has(req.path) || SESSION_EXEMPT_PATTERNS.some((p) => p.test(req.path))) {
    next();
    return;
  }
  requireAuth(req, res, next);
});
router.use(sosRouter);    // SOS operations section of GNIL OS (behind the same session auth)
router.use(agencyRouter);
router.use(tenantsRouter);
router.use(modulesRouter);
router.use(billingRouter);
router.use(adminRouter);
router.use(conciergeRouter); // AI Concierge & Automation module
router.use(partnersRouter); // Partner-Direct Integrations proxy engine (/v1/partners)

export default router;
