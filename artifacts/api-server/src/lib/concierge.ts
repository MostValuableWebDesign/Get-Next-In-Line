import {
  db,
  clientProfilesTable,
  engagementRulesTable,
  messageLogsTable,
  sosCustomersTable,
  type ClientProfile,
  type EngagementRule,
  type MessageLog,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { sendSms } from "./sms";
import { logger } from "./logger";

// ── Shared concierge dispatch/engagement logic ───────────────────────────────
// Used by both the /concierge routes and the background worker so a message
// dispatch is always audited in message_logs the same way.

export type ConciergeJobType = "manual" | "send_reminder" | "rebooking_nudge";

/** Upsell rule config shape (rule_type = "upsell"). */
export const upsellRuleConfigSchema = z.object({
  addOns: z
    .array(
      z.object({
        name: z.string().min(1),
        price: z.number().nullable().optional(),
        description: z.string().nullable().optional(),
        // Service names this add-on is compatible with (case-insensitive).
        // Empty/missing = compatible with every service.
        compatibleServices: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});

/** Reminder rule config shape (rule_type = "reminder"). */
export const reminderRuleConfigSchema = z.object({
  // How far ahead of next_visit_at a reminder should go out.
  leadHours: z.number().int().positive().default(24),
  // {{name}} and {{when}} placeholders are substituted.
  template: z
    .string()
    .default("Hi {{name}}, this is a reminder about your upcoming appointment on {{when}}. See you soon!"),
});

/** Rebooking nudge rule config shape (rule_type = "rebooking_nudge"). */
export const rebookingRuleConfigSchema = z.object({
  // Minimum days between nudges to the same client.
  cooldownDays: z.number().int().positive().default(7),
  // {{name}} and {{days}} placeholders are substituted.
  template: z
    .string()
    .default("Hi {{name}}, it's been a while since your last visit — reply to this text to book your next appointment!"),
});

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? "");
}

export async function getActiveRule(
  tenantId: number,
  ruleType: string,
): Promise<EngagementRule | null> {
  const [rule] = await db
    .select()
    .from(engagementRulesTable)
    .where(
      and(
        eq(engagementRulesTable.tenantId, tenantId),
        eq(engagementRulesTable.ruleType, ruleType),
        eq(engagementRulesTable.isActive, true),
      ),
    )
    .limit(1);
  return rule ?? null;
}

export interface DispatchOptions {
  tenantId: number;
  profile: ClientProfile;
  body: string;
  jobType: ConciergeJobType;
  ruleId?: number | null;
  /** Extra structured context stored in the audit payload. */
  context?: Record<string, unknown>;
}

/**
 * Dispatch a message to a client profile via its preferred channel, recording
 * a message_logs row first (status "pending") and updating it with the send
 * outcome. Only SMS is dispatched today; a non-SMS preferred channel is
 * logged as "skipped" rather than silently dropped.
 */
export async function dispatchToProfile(opts: DispatchOptions): Promise<MessageLog> {
  const { tenantId, profile, body, jobType } = opts;
  const channel = profile.preferredChannel || "sms";

  const [log] = await db
    .insert(messageLogsTable)
    .values({
      tenantId,
      clientProfileId: profile.id,
      ruleId: opts.ruleId ?? null,
      jobType,
      channel,
      toNumber: profile.phone ?? null,
      payload: { body, ...(opts.context ?? {}) },
      status: "pending",
    })
    .returning();

  let status: string;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  if (channel !== "sms") {
    status = "skipped";
    errorCode = "unsupported_channel";
    errorMessage = `Channel "${channel}" is not dispatchable yet (SMS only)`;
  } else if (!profile.smsOptIn) {
    status = "skipped";
    errorCode = "opted_out";
    errorMessage = "Client has opted out of SMS";
  } else if (await linkedSosCustomerOptedOut(profile.id)) {
    // The same person's operational (SOS) record says STOP — respect it even
    // if the marketing profile hasn't caught up yet.
    status = "skipped";
    errorCode = "opted_out";
    errorMessage = "Linked SOS customer has opted out of SMS";
  } else if (!profile.phone) {
    status = "skipped";
    errorCode = "no_phone";
    errorMessage = "Client profile has no phone number";
  } else {
    try {
      const result = await sendSms({
        toNumber: profile.phone,
        body,
        kind: "concierge",
      });
      status = result.deliveryStatus; // sent | failed | simulated
    } catch (err) {
      status = "failed";
      errorMessage = err instanceof Error ? err.message : "Unknown send error";
      logger.error({ err, logId: log.id }, "Concierge SMS dispatch threw");
    }
  }

  const [updated] = await db
    .update(messageLogsTable)
    .set({ status, errorCode, errorMessage, updatedAt: new Date() })
    .where(eq(messageLogsTable.id, log.id))
    .returning();
  return updated;
}

/** True when an SOS customer is linked to this profile and has opted out. */
async function linkedSosCustomerOptedOut(clientProfileId: number): Promise<boolean> {
  const [row] = await db
    .select({ smsOptIn: sosCustomersTable.smsOptIn })
    .from(sosCustomersTable)
    .where(eq(sosCustomersTable.clientProfileId, clientProfileId))
    .limit(1);
  return row != null && !row.smsOptIn;
}

export async function getProfileForTenant(
  tenantId: number,
  clientProfileId: number,
): Promise<ClientProfile | null> {
  const [profile] = await db
    .select()
    .from(clientProfilesTable)
    .where(
      and(
        eq(clientProfilesTable.id, clientProfileId),
        eq(clientProfilesTable.tenantId, tenantId),
      ),
    );
  return profile ?? null;
}
