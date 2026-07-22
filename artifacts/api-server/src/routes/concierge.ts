import { Router, type IRouter } from "express";
import { db, tenantsTable, type Message } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  SuggestConciergeUpsellsBody,
  SuggestConciergeUpsellsResponse,
  DispatchConciergeMessageBody,
  DispatchConciergeMessageResponse,
} from "@workspace/api-zod";
import {
  dispatchToProfile,
  getActiveRule,
  getProfileForTenant,
  upsellRuleConfigSchema,
  type ConciergeJobType,
} from "../lib/concierge";

const router: IRouter = Router();

function serializeLog(log: Message) {
  return {
    id: log.id,
    tenantId: log.tenantId,
    clientProfileId: log.clientProfileId,
    ruleId: log.ruleId,
    jobType: log.kind,
    channel: log.channel,
    toNumber: log.toNumber,
    status: log.status,
    errorCode: log.errorCode,
    errorMessage: log.errorMessage,
    createdAt: log.createdAt.toISOString(),
  };
}

async function tenantExists(tenantId: number): Promise<boolean> {
  const [t] = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  return Boolean(t);
}

// ── POST /concierge/suggest-upsells ──────────────────────────────────────────
// Returns the active add-ons/enhancements compatible with a given service
// selection for the tenant, driven by the tenant's active "upsell"
// engagement rule config.
router.post("/concierge/suggest-upsells", async (req, res): Promise<void> => {
  const body = SuggestConciergeUpsellsBody.parse(req.body);

  if (!(await tenantExists(body.tenantId))) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const rule = await getActiveRule(body.tenantId, "upsell");
  const service = body.serviceName.trim().toLowerCase();

  let suggestions: Array<{
    name: string;
    price: number | null;
    description: string | null;
    ruleId: number;
  }> = [];

  if (rule) {
    const parsed = upsellRuleConfigSchema.safeParse(rule.config);
    if (!parsed.success) {
      res.status(500).json({
        error: "Invalid upsell rule configuration",
        message: `Engagement rule ${rule.id} has a malformed config`,
      });
      return;
    }
    suggestions = parsed.data.addOns
      .filter(
        (a) =>
          !a.compatibleServices ||
          a.compatibleServices.length === 0 ||
          a.compatibleServices.some((s) => s.trim().toLowerCase() === service),
      )
      .map((a) => ({
        name: a.name,
        price: a.price ?? null,
        description: a.description ?? null,
        ruleId: rule.id,
      }));
  }

  res.json(
    SuggestConciergeUpsellsResponse.parse({
      tenantId: body.tenantId,
      serviceName: body.serviceName,
      suggestions,
    }),
  );
});

// ── POST /concierge/dispatch-message ─────────────────────────────────────────
// Looks up the client's contact info and preferred channel, records a
// unified messages row, sends via the SMS service (simulated without Twilio
// creds), and returns the updated log.
router.post("/concierge/dispatch-message", async (req, res): Promise<void> => {
  const body = DispatchConciergeMessageBody.parse(req.body);

  if (!(await tenantExists(body.tenantId))) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const profile = await getProfileForTenant(body.tenantId, body.clientProfileId);
  if (!profile) {
    res.status(404).json({ error: "Client profile not found for this tenant" });
    return;
  }

  const log = await dispatchToProfile({
    tenantId: body.tenantId,
    profile,
    body: body.body,
    jobType: (body.jobType ?? "manual") as ConciergeJobType,
  });

  const statusCode = log.status === "skipped" ? 409 : 201;
  res.status(statusCode).json(DispatchConciergeMessageResponse.parse(serializeLog(log)));
});

export default router;
