import { Router, type IRouter } from "express";
import healthRouter from "./health";
import agencyRouter from "./agency";
import tenantsRouter from "./tenants";
import modulesRouter from "./modules";
import billingRouter from "./billing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(agencyRouter);
router.use(tenantsRouter);
router.use(modulesRouter);
router.use(billingRouter);

export default router;
