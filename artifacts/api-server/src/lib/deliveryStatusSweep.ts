import { db, messagesTable } from "@workspace/db";
import { and, eq, gt, isNotNull, lt } from "drizzle-orm";
import { fetchTwilioMessageStatus } from "./sms";
import { applyDeliveryStatus } from "./messaging";
import { logger } from "./logger";

// ── Delivery-status reconciliation ──────────────────────────────────────────
// Twilio's per-message StatusCallback is signature-authenticated with the
// sending account's auth token. When SMS goes out through the Replit Twilio
// connector proxy, that token is withheld, so real callbacks can never pass
// signature validation here — messages would sit at "sent" forever. This
// sweep polls Twilio's Messages API (via the same proxy, which injects auth
// server-side) for the authoritative status and applies it through the same
// applyDeliveryStatus path the callback uses.

/** Don't re-poll a row more often than this (updatedAt is the throttle stamp). */
const MIN_AGE_MS = 60_000;
/** Stop polling messages older than this — Twilio statuses are final long before. */
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** Per-sweep cap so a backlog can't stall the concierge tick. */
const BATCH_LIMIT = 25;

/**
 * Reconcile outbound SMS rows stuck at "sent" against Twilio's authoritative
 * per-message status. Returns the number of rows that reached a final
 * status (delivered/failed) this sweep. Safe to run on every concierge tick:
 * a row whose Twilio status is still interim keeps its "sent" status (the
 * apply bumps updatedAt, which throttles the next poll), and rows without a
 * real Twilio SID (simulated sends) are skipped.
 */
export async function reconcileDeliveryStatuses(now: Date = new Date()): Promise<number> {
  const rows = await db
    .select({ id: messagesTable.id, providerSid: messagesTable.providerSid })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.direction, "outbound"),
        eq(messagesTable.channel, "sms"),
        eq(messagesTable.status, "sent"),
        isNotNull(messagesTable.providerSid),
        lt(messagesTable.updatedAt, new Date(now.getTime() - MIN_AGE_MS)),
        gt(messagesTable.createdAt, new Date(now.getTime() - MAX_AGE_MS)),
      ),
    )
    .orderBy(messagesTable.id)
    .limit(BATCH_LIMIT);

  let finalized = 0;
  for (const row of rows) {
    const sid = row.providerSid;
    if (!sid) continue;
    const fetched = await fetchTwilioMessageStatus(sid);
    if (!fetched) continue;
    const updated = await applyDeliveryStatus({
      providerSid: sid,
      messageStatus: fetched.messageStatus,
      errorCode: fetched.errorCode,
      errorMessage: fetched.errorMessage,
    });
    if (updated && (updated.status === "delivered" || updated.status === "failed")) {
      finalized++;
      logger.info(
        { messageId: updated.id, providerSid: sid, status: updated.status },
        "Delivery status reconciled from Twilio",
      );
    }
  }
  return finalized;
}

/**
 * Verify one message's delivery status against Twilio's API and apply it.
 * Used as the near-real-time path when a StatusCallback arrives but its
 * signature can't be verified (connector-proxy mode): the callback body is
 * never trusted — only Twilio's authoritative answer is applied, so a forged
 * request can at worst trigger a truthful lookup. Never throws.
 */
export async function verifyDeliveryStatusBySid(providerSid: string): Promise<void> {
  try {
    const fetched = await fetchTwilioMessageStatus(providerSid);
    if (!fetched) return;
    await applyDeliveryStatus({
      providerSid,
      messageStatus: fetched.messageStatus,
      errorCode: fetched.errorCode,
      errorMessage: fetched.errorMessage,
    });
  } catch (err) {
    logger.warn({ err, providerSid }, "Delivery status verification failed");
  }
}
