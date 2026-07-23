import {
  db,
  clientProfilesTable,
  engagementRulesTable,
  type ClientProfile,
  type EngagementRule,
  type Message,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { sendMessage } from "./messaging";

// ── Shared concierge dispatch/engagement logic ───────────────────────────────
// Used by both the /concierge routes and the background worker so a message
// dispatch is always audited in the unified messages table the same way.

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
 * Dispatch a message to a client profile via its preferred channel through
 * the unified messaging service, which records the message, applies the
 * shared guards (opt-out on either the profile or its linked SOS customer,
 * unsupported channel, missing phone), and finalizes the send outcome.
 */
export async function dispatchToProfile(opts: DispatchOptions): Promise<Message> {
  const { tenantId, profile, body, jobType } = opts;
  return sendMessage({
    tenantId,
    origin: "concierge",
    clientProfileId: profile.id,
    ruleId: opts.ruleId ?? null,
    toNumber: profile.phone,
    body,
    kind: jobType,
    channel: profile.preferredChannel || "sms",
    context: opts.context,
  });
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
