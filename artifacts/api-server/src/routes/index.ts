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

const router: IRouter = Router();

// ── Public routes ────────────────────────────────────────────────────────────
// These do not require an authenticated session.
router.use(healthRouter); // GET /healthz
router.use(authRouter);   // POST /auth/login, POST /auth/logout, GET /auth/me

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
router.use((req, res, next) => {
  if (SESSION_EXEMPT_PATHS.has(req.path)) {
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

export default router;
