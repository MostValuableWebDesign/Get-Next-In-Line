import { Router, type IRouter } from "express";
import {
  db,
  tenantsTable,
  engagementRulesTable,
  clientProfilesTable,
  messagesTable,
  type Message,
  type EngagementRule,
  type ClientProfile,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  SuggestConciergeUpsellsBody,
  SuggestConciergeUpsellsResponse,
  DispatchConciergeMessageBody,
  DispatchConciergeMessageResponse,
  ListEngagementRulesResponse,
  CreateEngagementRuleBody,
  CreateEngagementRuleResponse,
  UpdateEngagementRuleBody,
  UpdateEngagementRuleResponse,
  ListClientProfilesResponse,
  CreateClientProfileBody,
  CreateClientProfileResponse,
  UpdateClientProfileBody,
  UpdateClientProfileResponse,
  ListConciergeMessageLogsResponse,
} from "@workspace/api-zod";
import {
  dispatchToProfile,
  getActiveRule,
  getProfileForTenant,
  upsellRuleConfigSchema,
  reminderRuleConfigSchema,
  rebookingRuleConfigSchema,
  type ConciergeJobType,
} from "../lib/concierge";

const router: IRouter = Router();

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function serializeLog(log: Message, clientName: string | null = null) {
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
    clientName,
    body: log.body || null,
    createdAt: log.createdAt.toISOString(),
  };
}

function serializeRule(rule: EngagementRule) {
  return {
    id: rule.id,
    tenantId: rule.tenantId,
    ruleType: rule.ruleType,
    config: rule.config as Record<string, unknown>,
    isActive: rule.isActive,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

function serializeProfile(p: ClientProfile) {
  return {
    id: p.id,
    tenantId: p.tenantId,
    name: p.name,
    phone: p.phone,
    email: p.email,
    preferredChannel: p.preferredChannel,
    smsOptIn: p.smsOptIn,
    lastVisitAt: iso(p.lastVisitAt),
    nextVisitAt: iso(p.nextVisitAt),
    averageCycleDays: p.averageCycleDays,
    createdAt: p.createdAt.toISOString(),
  };
}

/**
 * Validate a rule's config against the schema for its type, applying
 * defaults. Returns the normalized config, or null when invalid.
 */
function normalizeRuleConfig(
  ruleType: string,
  config: unknown,
): Record<string, unknown> | null {
  const schema =
    ruleType === "reminder"
      ? reminderRuleConfigSchema
      : ruleType === "rebooking_nudge"
        ? rebookingRuleConfigSchema
        : upsellRuleConfigSchema;
  const parsed = schema.safeParse(config ?? {});
  return parsed.success ? parsed.data : null;
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

// ── engagement rules CRUD (tenant-scoped) ────────────────────────────────────

router.get("/tenants/:id/engagement-rules", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.id);
  if (!Number.isInteger(tenantId) || !(await tenantExists(tenantId))) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const rules = await db
    .select()
    .from(engagementRulesTable)
    .where(eq(engagementRulesTable.tenantId, tenantId))
    .orderBy(engagementRulesTable.id);
  res.json(ListEngagementRulesResponse.parse(rules.map(serializeRule)));
});

router.post("/tenants/:id/engagement-rules", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.id);
  const body = CreateEngagementRuleBody.parse(req.body);
  if (!Number.isInteger(tenantId) || !(await tenantExists(tenantId))) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const config = normalizeRuleConfig(body.ruleType, body.config);
  if (!config) {
    res.status(400).json({ error: `Invalid config for rule type "${body.ruleType}"` });
    return;
  }
  const [rule] = await db
    .insert(engagementRulesTable)
    .values({
      tenantId,
      ruleType: body.ruleType,
      config,
      isActive: body.isActive ?? true,
    })
    .returning();
  res.status(201).json(CreateEngagementRuleResponse.parse(serializeRule(rule)));
});

router.patch(
  "/tenants/:id/engagement-rules/:ruleId",
  async (req, res): Promise<void> => {
    const tenantId = Number(req.params.id);
    const ruleId = Number(req.params.ruleId);
    const body = UpdateEngagementRuleBody.parse(req.body);
    const [existing] = await db
      .select()
      .from(engagementRulesTable)
      .where(
        and(
          eq(engagementRulesTable.id, ruleId),
          eq(engagementRulesTable.tenantId, tenantId),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Rule not found for this tenant" });
      return;
    }
    let config: Record<string, unknown> | undefined;
    if (body.config !== undefined) {
      const normalized = normalizeRuleConfig(existing.ruleType, body.config);
      if (!normalized) {
        res
          .status(400)
          .json({ error: `Invalid config for rule type "${existing.ruleType}"` });
        return;
      }
      config = normalized;
    }
    const [updated] = await db
      .update(engagementRulesTable)
      .set({
        ...(config !== undefined ? { config } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(eq(engagementRulesTable.id, existing.id))
      .returning();
    res.json(UpdateEngagementRuleResponse.parse(serializeRule(updated)));
  },
);

router.delete(
  "/tenants/:id/engagement-rules/:ruleId",
  async (req, res): Promise<void> => {
    const tenantId = Number(req.params.id);
    const ruleId = Number(req.params.ruleId);
    const [deleted] = await db
      .delete(engagementRulesTable)
      .where(
        and(
          eq(engagementRulesTable.id, ruleId),
          eq(engagementRulesTable.tenantId, tenantId),
        ),
      )
      .returning({ id: engagementRulesTable.id });
    if (!deleted) {
      res.status(404).json({ error: "Rule not found for this tenant" });
      return;
    }
    res.status(204).send();
  },
);

// ── client profiles CRUD (tenant-scoped) ─────────────────────────────────────

const toDate = (v: string | null | undefined): Date | null | undefined =>
  v === undefined ? undefined : v === null ? null : new Date(v);

router.get("/tenants/:id/client-profiles", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.id);
  if (!Number.isInteger(tenantId) || !(await tenantExists(tenantId))) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const profiles = await db
    .select()
    .from(clientProfilesTable)
    .where(eq(clientProfilesTable.tenantId, tenantId))
    .orderBy(desc(clientProfilesTable.createdAt));
  res.json(ListClientProfilesResponse.parse(profiles.map(serializeProfile)));
});

router.post("/tenants/:id/client-profiles", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.id);
  const body = CreateClientProfileBody.parse(req.body);
  if (!Number.isInteger(tenantId) || !(await tenantExists(tenantId))) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const [profile] = await db
    .insert(clientProfilesTable)
    .values({
      tenantId,
      name: body.name,
      phone: body.phone ?? null,
      email: body.email ?? null,
      preferredChannel: body.preferredChannel ?? "sms",
      smsOptIn: body.smsOptIn ?? true,
      lastVisitAt: toDate(body.lastVisitAt) ?? null,
      nextVisitAt: toDate(body.nextVisitAt) ?? null,
      averageCycleDays: body.averageCycleDays ?? null,
    })
    .returning();
  res.status(201).json(CreateClientProfileResponse.parse(serializeProfile(profile)));
});

router.patch(
  "/tenants/:id/client-profiles/:profileId",
  async (req, res): Promise<void> => {
    const tenantId = Number(req.params.id);
    const profileId = Number(req.params.profileId);
    const body = UpdateClientProfileBody.parse(req.body);
    const [updated] = await db
      .update(clientProfilesTable)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
        ...(body.preferredChannel !== undefined
          ? { preferredChannel: body.preferredChannel }
          : {}),
        ...(body.smsOptIn !== undefined ? { smsOptIn: body.smsOptIn } : {}),
        ...(body.lastVisitAt !== undefined
          ? { lastVisitAt: toDate(body.lastVisitAt) }
          : {}),
        ...(body.nextVisitAt !== undefined
          ? { nextVisitAt: toDate(body.nextVisitAt) }
          : {}),
        ...(body.averageCycleDays !== undefined
          ? { averageCycleDays: body.averageCycleDays }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(clientProfilesTable.id, profileId),
          eq(clientProfilesTable.tenantId, tenantId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Profile not found for this tenant" });
      return;
    }
    res.json(UpdateClientProfileResponse.parse(serializeProfile(updated)));
  },
);

router.delete(
  "/tenants/:id/client-profiles/:profileId",
  async (req, res): Promise<void> => {
    const tenantId = Number(req.params.id);
    const profileId = Number(req.params.profileId);
    const [deleted] = await db
      .delete(clientProfilesTable)
      .where(
        and(
          eq(clientProfilesTable.id, profileId),
          eq(clientProfilesTable.tenantId, tenantId),
        ),
      )
      .returning({ id: clientProfilesTable.id });
    if (!deleted) {
      res.status(404).json({ error: "Profile not found for this tenant" });
      return;
    }
    res.status(204).send();
  },
);

// ── message dispatch log (tenant-scoped) ─────────────────────────────────────

router.get("/tenants/:id/message-logs", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.id);
  if (!Number.isInteger(tenantId) || !(await tenantExists(tenantId))) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const rows = await db
    .select({ log: messagesTable, clientName: clientProfilesTable.name })
    .from(messagesTable)
    .leftJoin(
      clientProfilesTable,
      eq(messagesTable.clientProfileId, clientProfilesTable.id),
    )
    .where(eq(messagesTable.tenantId, tenantId))
    .orderBy(desc(messagesTable.createdAt))
    .limit(200);
  res.json(
    ListConciergeMessageLogsResponse.parse(
      rows.map((r) => serializeLog(r.log, r.clientName)),
    ),
  );
});

export default router;
