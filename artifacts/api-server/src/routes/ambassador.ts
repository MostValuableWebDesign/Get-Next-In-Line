import { Router, type Request, type IRouter } from "express";
import { db, ambassadorProgramSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetAmbassadorProgramResponse,
  UpdateAmbassadorProgramBody,
  UpdateAmbassadorProgramResponse,
  GetAmbassadorLedgerResponse,
  RedeemAmbassadorRewardBody,
  RedeemAmbassadorRewardResponse,
} from "@workspace/api-zod";
import {
  buildAmbassadorProgramView,
  buildAmbassadorLedger,
  redeemAmbassadorReward,
} from "../lib/ambassador";

// ── Ambassador Program — merchant console (/coop/ambassador/*) ──────────────
// Tenant-scoped via x-tenant-id (the shared tenant-access middleware
// authorizes it). Settings, pool ledger, and staff reward redemption.

const router: IRouter = Router();

function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── GET /coop/ambassador/program — settings + pool + leaders + stats ────────
router.get("/coop/ambassador/program", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  res.json(GetAmbassadorProgramResponse.parse(await buildAmbassadorProgramView(tenantId)));
});

// ── PUT /coop/ambassador/program — opt in/out + pledge configuration ────────
router.put("/coop/ambassador/program", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = UpdateAmbassadorProgramBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const values: Partial<typeof ambassadorProgramSettingsTable.$inferInsert> = {
    optedIn: parsed.data.optedIn,
    updatedAt: new Date(),
  };
  if (parsed.data.pledgePerRedemption != null) {
    values.pledgePerRedemption = parsed.data.pledgePerRedemption.toFixed(2);
  }
  await db
    .insert(ambassadorProgramSettingsTable)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({ target: ambassadorProgramSettingsTable.tenantId, set: values });
  res.json(UpdateAmbassadorProgramResponse.parse(await buildAmbassadorProgramView(tenantId)));
});

// ── GET /coop/ambassador/ledger — shared pool ledger + balance ──────────────
router.get("/coop/ambassador/ledger", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  res.json(GetAmbassadorLedgerResponse.parse(await buildAmbassadorLedger()));
});

// ── POST /coop/ambassador/rewards/redeem — staff verification & redemption ──
// Always 200 with a valid flag, mirroring the perk redemption endpoints.
router.post("/coop/ambassador/rewards/redeem", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = RedeemAmbassadorRewardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const outcome = await redeemAmbassadorReward({ tenantId, code: parsed.data.code });
  res.json(
    RedeemAmbassadorRewardResponse.parse({
      valid: outcome.valid,
      reason: outcome.reason,
      reward: outcome.reward
        ? {
            id: outcome.reward.id,
            code: outcome.reward.code,
            source: outcome.reward.source,
            amount: Number(outcome.reward.amount),
            status: outcome.reward.status,
            redeemedAtBusiness: null,
            redeemedAt: outcome.reward.redeemedAt
              ? outcome.reward.redeemedAt.toISOString()
              : null,
            createdAt: outcome.reward.createdAt.toISOString(),
          }
        : null,
    }),
  );
});

export default router;
