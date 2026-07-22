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

const router: IRouter = Router();

// ── Public routes ────────────────────────────────────────────────────────────
// These do not require an authenticated session.
router.use(healthRouter); // GET /healthz
router.use(authRouter);   // POST /auth/login, POST /auth/logout, GET /auth/me

// ── Protected routes ─────────────────────────────────────────────────────────
// All routes below this middleware require a valid session.
router.use(requireAuth);
router.use(sosRouter);    // SOS operations section of GNIL OS (behind the same session auth)
router.use(agencyRouter);
router.use(tenantsRouter);
router.use(modulesRouter);
router.use(billingRouter);
router.use(adminRouter);

export default router;
