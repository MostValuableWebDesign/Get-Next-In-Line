import {
  db,
  messagesTable,
  sosCustomersTable,
  clientProfilesTable,
  type Message,
} from "@workspace/db";
import { and, eq, notInArray } from "drizzle-orm";
import { deliverSms, normalizeToE164 } from "./sms";
import { logger } from "./logger";

// ── Unified messaging service ────────────────────────────────────────────────
// Every outbound message on the platform — waitlist auto-fills, "you're next"
// texts, AI receptionist follow-ups, concierge reminders/rebooking nudges,
// and manual sends — goes through `sendMessage`, which applies the same
// opt-out check, phone normalization, simulated-mode fallback, and failure
// recording, and writes one row into the unified `messages` table. Inbound
// texts are recorded through `recordInboundMessage`.

export type OutboundMessageKind =
  | "you_are_next"
  | "slot_open"
  | "ai_followup"
  | "manual"
  | "claim_confirmation"
  | "send_reminder"
  | "rebooking_nudge"
  | "deposit_update"
  | "wallet_login_code"
  | "perk_expiry_reminder"
  | "coop_monthly_report"
  | "safety_alert"
  | "coop_dispute"
  | "coop_financial_dispute"
  | "coop_invite"
  | "coop_campaign_blast"
  | "coop_tier_change"
  | "passport_reward"
  | "emergency_broadcast"
  | "coop_event_broadcast"
  | "retail_low_stock"
  | "coop_reputation"
  | "coop_feedback_request";

export type MessageOrigin = "operational" | "concierge" | "marketing";

export interface SendMessageOptions {
  /** Tenant scope; null/omitted for legacy single-tenant SOS operational sends. */
  tenantId?: number | null;
  /**
   * What surface the message belongs to. Defaults to "operational" (SOS
   * texts); concierge automation sends must pass "concierge".
   */
  origin?: MessageOrigin;
  /** Operational (SOS) customer this message is for, when known. */
  customerId?: number | null;
  /** Marketing (concierge) client profile this message is for, when known. */
  clientProfileId?: number | null;
  /** Engagement rule that triggered an automated send. */
  ruleId?: number | null;
  toNumber: string | null | undefined;
  body: string;
  kind: OutboundMessageKind;
  /** Defaults to "sms" — the only channel dispatched today. */
  channel?: string;
  /** Extra structured context stored in the message payload. */
  context?: Record<string, unknown>;
}

interface Guard {
  errorCode: "unsupported_channel" | "opted_out" | "no_phone";
  errorMessage: string;
}

/**
 * Resolve the effective opt-out state for a recipient: a STOP recorded on
 * either the operational (SOS customer) record or the marketing (client
 * profile) record blocks the send, whichever side the caller referenced.
 */
async function findOptOutGuard(
  customerId: number | null,
  clientProfileId: number | null,
): Promise<Guard | null> {
  let profileId = clientProfileId;

  if (customerId != null) {
    const [customer] = await db
      .select({
        smsOptIn: sosCustomersTable.smsOptIn,
        clientProfileId: sosCustomersTable.clientProfileId,
      })
      .from(sosCustomersTable)
      .where(eq(sosCustomersTable.id, customerId))
      .limit(1);
    if (customer && !customer.smsOptIn) {
      return {
        errorCode: "opted_out",
        errorMessage: "Customer has opted out of SMS",
      };
    }
    profileId ??= customer?.clientProfileId ?? null;
  }

  if (profileId != null) {
    const [profile] = await db
      .select({ smsOptIn: clientProfilesTable.smsOptIn })
      .from(clientProfilesTable)
      .where(eq(clientProfilesTable.id, profileId))
      .limit(1);
    if (profile && !profile.smsOptIn) {
      return {
        errorCode: "opted_out",
        errorMessage: "Client has opted out of SMS",
      };
    }
    if (customerId == null && clientProfileId != null) {
      // Sending to a marketing profile: the same person's operational (SOS)
      // record may say STOP — respect it even if the profile hasn't caught up.
      const [linked] = await db
        .select({ smsOptIn: sosCustomersTable.smsOptIn })
        .from(sosCustomersTable)
        .where(eq(sosCustomersTable.clientProfileId, clientProfileId))
        .limit(1);
      if (linked && !linked.smsOptIn) {
        return {
          errorCode: "opted_out",
          errorMessage: "Linked SOS customer has opted out of SMS",
        };
      }
    }
  }

  return null;
}

/**
 * Send one outbound message: records a pending `messages` row, applies the
 * shared guards (channel support, opt-out, missing phone), dispatches via
 * Twilio or simulated mode, and finalizes status/error details. Returns the
 * finalized row. Never throws for delivery problems — they are recorded.
 */
export async function sendMessage(opts: SendMessageOptions): Promise<Message> {
  const channel = opts.channel || "sms";

  let guard: Guard | null = null;
  if (channel !== "sms") {
    guard = {
      errorCode: "unsupported_channel",
      errorMessage: `Channel "${channel}" is not dispatchable yet (SMS only)`,
    };
  } else {
    guard = await findOptOutGuard(
      opts.customerId ?? null,
      opts.clientProfileId ?? null,
    );
    if (!guard && !opts.toNumber) {
      guard = { errorCode: "no_phone", errorMessage: "Recipient has no phone number" };
    }
  }

  const [pending] = await db
    .insert(messagesTable)
    .values({
      tenantId: opts.tenantId ?? null,
      origin: opts.origin ?? "operational",
      customerId: opts.customerId ?? null,
      clientProfileId: opts.clientProfileId ?? null,
      ruleId: opts.ruleId ?? null,
      direction: "outbound",
      kind: opts.kind,
      channel,
      toNumber: normalizeToE164(opts.toNumber) ?? opts.toNumber ?? null,
      body: opts.body,
      payload: opts.context ?? {},
      status: "pending",
    })
    .returning();

  let status: string;
  let providerSid: string | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  if (guard) {
    status = "skipped";
    errorCode = guard.errorCode;
    errorMessage = guard.errorMessage;
  } else {
    try {
      const result = await deliverSms(opts.toNumber, opts.body, opts.tenantId ?? null);
      status = result.status;
      providerSid = result.providerSid;
      errorCode = result.errorCode;
      errorMessage = result.errorMessage;
    } catch (err) {
      status = "failed";
      errorMessage = err instanceof Error ? err.message : "Unknown send error";
      logger.error({ err, messageId: pending.id }, "SMS dispatch threw");
    }
  }

  const [finalized] = await db
    .update(messagesTable)
    .set({ status, providerSid, errorCode, errorMessage, updatedAt: new Date() })
    .where(eq(messagesTable.id, pending.id))
    .returning();
  return finalized;
}

/**
 * Like `sendMessage`, but guaranteed not to throw even on unexpected
 * infrastructure errors (e.g. the messages insert itself failing). Use in
 * operational flows (queue advance, waitlist broadcast, receptionist) where
 * a messaging problem must never block the customer-state transition.
 * Returns null when the send could not even be recorded.
 */
export async function sendMessageSafe(
  opts: SendMessageOptions,
): Promise<Message | null> {
  try {
    return await sendMessage(opts);
  } catch (err) {
    logger.error(
      { err, kind: opts.kind, customerId: opts.customerId ?? null },
      "sendMessage threw unexpectedly; continuing flow without blocking",
    );
    return null;
  }
}

// Statuses that are final: a late/out-of-order Twilio callback must never
// downgrade them back to an interim state.
const FINAL_STATUSES = ["delivered", "failed"];

export interface DeliveryStatusUpdate {
  providerSid: string;
  /** Twilio MessageStatus, e.g. queued|sending|sent|delivered|undelivered|failed|read */
  messageStatus: string;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/**
 * Apply a Twilio StatusCallback delivery update to the matching outbound
 * message in the unified `messages` table. Interim statuses (queued/sending/
 * accepted) are ignored; "sent" only applies while the row isn't already
 * final. Returns the updated row, or null when nothing matched/changed.
 */
export async function applyDeliveryStatus(
  update: DeliveryStatusUpdate,
): Promise<Message | null> {
  let status: string;
  switch (update.messageStatus) {
    case "delivered":
    case "read":
      status = "delivered";
      break;
    case "failed":
    case "undelivered":
      status = "failed";
      break;
    case "sent":
      status = "sent";
      break;
    default:
      // queued / accepted / sending — interim, nothing to record yet.
      return null;
  }

  const conditions = [
    eq(messagesTable.providerSid, update.providerSid),
    eq(messagesTable.direction, "outbound"),
  ];
  if (status === "sent") {
    // Never downgrade a final status with an out-of-order interim callback.
    conditions.push(notInArray(messagesTable.status, FINAL_STATUSES));
  }

  const [row] = await db
    .update(messagesTable)
    .set({
      status,
      errorCode: status === "failed" ? (update.errorCode ?? null) : null,
      errorMessage: status === "failed" ? (update.errorMessage ?? null) : null,
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning();
  if (!row) {
    logger.warn(
      { providerSid: update.providerSid, messageStatus: update.messageStatus },
      "Status callback matched no outbound message (or was out of order)",
    );
    return null;
  }
  return row;
}

export interface RecordInboundOptions {
  /** Tenant scope of the matched sender; null for legacy/unknown senders. */
  tenantId?: number | null;
  customerId?: number | null;
  clientProfileId?: number | null;
  /** The sender — shown as the counterparty in the log. */
  fromNumber: string | null;
  body: string;
  providerSid?: string | null;
}

/** Record one inbound message in the unified table (status "received"). */
export async function recordInboundMessage(
  opts: RecordInboundOptions,
): Promise<Message> {
  const [row] = await db
    .insert(messagesTable)
    .values({
      tenantId: opts.tenantId ?? null,
      origin: "operational",
      customerId: opts.customerId ?? null,
      clientProfileId: opts.clientProfileId ?? null,
      direction: "inbound",
      kind: "inbound",
      channel: "sms",
      toNumber: opts.fromNumber,
      body: opts.body,
      status: "received",
      providerSid: opts.providerSid ?? null,
    })
    .returning();
  return row;
}
