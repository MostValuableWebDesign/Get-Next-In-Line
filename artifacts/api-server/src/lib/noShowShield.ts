import {
  db,
  modulesTable,
  tenantModulesTable,
  sosDepositHoldsTable,
  sosAppointmentsTable,
  sosCustomersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { getLegacySettings, resolveSettings, type SosSettingsRow } from "./settings";
import { sendMessageSafe } from "./messaging";
import { getUncachableStripeClient, isStripeConfigured } from "./stripeClient";
import { logger } from "./logger";
import { recordDepositOutcomeSafe } from "./platformLedger";

export const NO_SHOW_SHIELD_SLUG = "no_show_shield";

export type DepositHoldRow = typeof sosDepositHoldsTable.$inferSelect;

/** Dollars (numeric string, e.g. "25.00") → Stripe integer cents. */
function cents(amount: string): number {
  return Math.round(parseFloat(amount) * 100);
}

/** Base URL customers land on after completing/abandoning Stripe Checkout. */
function appBaseUrl(): string {
  const fromEnv = process.env.APP_BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const domain =
    process.env.REPLIT_DOMAINS?.split(",")[0]?.trim() ||
    process.env.REPLIT_DEV_DOMAIN;
  return domain ? `https://${domain}` : "http://localhost:5173";
}

/**
 * Whether the No-Show Shield module has been provisioned for the given
 * tenant scope. Under tenant context only that tenant's subscription counts;
 * for the legacy (NULL-tenant) scope, any subscription counts — that record
 * pre-dates per-tenant provisioning.
 */
export async function isNoShowShieldProvisioned(
  tenantId?: number | null,
): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tenantModulesTable)
    .innerJoin(modulesTable, eq(tenantModulesTable.moduleId, modulesTable.id))
    .where(
      and(
        eq(modulesTable.slug, NO_SHOW_SHIELD_SLUG),
        tenantId == null ? undefined : eq(tenantModulesTable.tenantId, tenantId),
      ),
    );
  return (row?.n ?? 0) > 0;
}

/** The policy is active only when the module is provisioned AND enabled. */
export async function isNoShowShieldActive(
  settings?: SosSettingsRow,
): Promise<boolean> {
  const s = settings ?? (await getLegacySettings());
  if (!s.noShowShieldEnabled) return false;
  return isNoShowShieldProvisioned(s.tenantId);
}

type DepositEvent = "held" | "released" | "captured_late_cancel" | "captured_no_show";

/**
 * Text the appointment's customer about a deposit event (hold placed,
 * released, or fee captured). Sends through the unified message pipeline
 * (sendMessageSafe) so the text shows up in the comms log; skipped entirely
 * when the customer has no phone or has opted out of SMS. Never throws —
 * a notification failure must not affect the deposit state transition.
 */
async function notifyDepositEvent(
  hold: DepositHoldRow,
  event: DepositEvent,
): Promise<void> {
  try {
    const [row] = await db
      .select({
        appt: sosAppointmentsTable,
        customer: sosCustomersTable,
      })
      .from(sosAppointmentsTable)
      .innerJoin(
        sosCustomersTable,
        eq(sosAppointmentsTable.customerId, sosCustomersTable.id),
      )
      .where(eq(sosAppointmentsTable.id, hold.appointmentId));
    if (!row) return;
    const { appt, customer } = row;
    // Same convention as the waitlist broadcast: don't record a skipped row
    // for customers we were never going to text.
    if (!customer.smsOptIn || !customer.phone) return;

    const deposit = `$${parseFloat(hold.depositAmount).toFixed(2)}`;
    const fee = `$${parseFloat(hold.feeAmount).toFixed(2)}`;
    const when = appt.startsAt.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    let body: string;
    switch (event) {
      case "held":
        body = `Hi ${customer.name}, your ${appt.serviceType} appointment on ${when} is confirmed. A ${deposit} deposit hold has been placed on your card. Cancel at least ${hold.cancellationWindowHours}h before your start time for a full release; late cancellations or no-shows incur a ${fee} fee.`;
        break;
      case "released":
        body = `Hi ${customer.name}, your ${appt.serviceType} appointment on ${when} was cancelled outside the ${hold.cancellationWindowHours}h window. Your ${deposit} deposit hold has been fully released — no fee was charged.`;
        break;
      case "captured_late_cancel":
        body = `Hi ${customer.name}, your ${appt.serviceType} appointment on ${when} was cancelled within the ${hold.cancellationWindowHours}h cancellation window, so the agreed ${fee} late-cancellation fee was charged from your deposit hold.`;
        break;
      case "captured_no_show":
        body = `Hi ${customer.name}, you were marked as a no-show for your ${appt.serviceType} appointment on ${when}. Per the deposit policy you agreed to at booking, the ${fee} no-show fee was charged from your deposit hold.`;
        break;
    }

    await sendMessageSafe({
      tenantId: appt.tenantId,
      customerId: customer.id,
      toNumber: customer.phone,
      kind: "deposit_update",
      body,
      context: { depositHoldId: hold.id, depositEvent: event },
    });
  } catch (err) {
    logger.error(
      { err, holdId: hold.id, event },
      "Failed to send deposit notification SMS",
    );
  }
}

/**
 * Record the policy agreement and start a REAL card deposit authorization
 * for a newly booked appointment: a Stripe Checkout session (manual-capture
 * PaymentIntent) whose link the customer completes to place the hold. Terms
 * are snapshotted from the settings in force at booking time. No-op when the
 * policy is inactive.
 *
 * Never throws: a hold failure must not abort the booking itself — but a
 * failure to reach Stripe is recorded as a "failed" hold with the error in
 * outcomeReason so staff see it, instead of silently pretending money is held.
 */
export async function placeDepositHoldIfActive(
  appointmentId: number,
): Promise<DepositHoldRow | null> {
  try {
    // Policy terms come from the settings of the tenant that owns the
    // appointment (legacy global record for NULL-tenant bookings).
    const [appt] = await db
      .select({ tenantId: sosAppointmentsTable.tenantId })
      .from(sosAppointmentsTable)
      .where(eq(sosAppointmentsTable.id, appointmentId));
    const settings = await resolveSettings(appt?.tenantId ?? null);
    if (!(await isNoShowShieldActive(settings))) return null;

    // Real card authorization via Stripe Checkout (manual capture).
    let stripeError: string | null = null;
    let checkoutSessionId: string | null = null;
    let checkoutUrl: string | null = null;
    let paymentIntentId: string | null = null;
    if (!isStripeConfigured()) {
      stripeError =
        "Stripe is not connected — no card authorization was created. Connect the Stripe integration to place real deposit holds.";
    } else {
      try {
        const stripe = await getUncachableStripeClient();
        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          payment_method_types: ["card"],
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: cents(settings.noShowDepositAmount),
                product_data: {
                  name: `${settings.businessName} — no-show deposit hold`,
                  description: `Refundable card hold of $${settings.noShowDepositAmount}. Released if you cancel at least ${settings.noShowCancellationWindowHours}h before your appointment; a $${settings.noShowFee} fee applies to late cancellations and no-shows.`,
                },
              },
            },
          ],
          payment_intent_data: {
            capture_method: "manual",
            metadata: { appointmentId: String(appointmentId) },
          },
          metadata: { appointmentId: String(appointmentId) },
          success_url: `${appBaseUrl()}/?deposit=authorized`,
          cancel_url: `${appBaseUrl()}/?deposit=cancelled`,
        });
        checkoutSessionId = session.id;
        checkoutUrl = session.url ?? null;
        paymentIntentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : (session.payment_intent?.id ?? null);
      } catch (err) {
        stripeError = err instanceof Error ? err.message : String(err);
        logger.error(
          { err, appointmentId },
          "Stripe deposit authorization could not be created",
        );
      }
    }

    const [hold] = await db
      .insert(sosDepositHoldsTable)
      .values({
        appointmentId,
        depositAmount: settings.noShowDepositAmount,
        feeAmount: settings.noShowFee,
        cancellationWindowHours: settings.noShowCancellationWindowHours,
        status: stripeError ? "failed" : "pending_authorization",
        stripeCheckoutSessionId: checkoutSessionId,
        stripePaymentIntentId: paymentIntentId,
        checkoutUrl,
        outcomeReason: stripeError
          ? `Card authorization FAILED — no money is held for this booking. ${stripeError}`
          : `Awaiting card authorization: send the customer the payment link to place the $${settings.noShowDepositAmount} deposit hold (cancel ≥${settings.noShowCancellationWindowHours}h before start for a full release).`,
      })
      .onConflictDoNothing()
      .returning();
    // The "deposit held" text is sent when the customer actually completes
    // the card authorization (checkout.session.completed webhook) — at this
    // point no money is held yet.
    // Holds born failed (Stripe unreachable) are already terminal — ledger them.
    if (hold && hold.status === "failed") await recordDepositOutcomeSafe(hold);
    return hold ?? null;
  } catch (err) {
    logger.error({ err, appointmentId }, "Failed to place No-Show Shield deposit hold");
    return null;
  }
}

/** Void a Stripe authorization; returns an error message instead of throwing. */
async function voidAuthorization(paymentIntentId: string): Promise<string | null> {
  try {
    const stripe = await getUncachableStripeClient();
    await stripe.paymentIntents.cancel(paymentIntentId);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, paymentIntentId }, "Failed to void Stripe authorization");
    return msg;
  }
}

/**
 * Expire an unpaid Stripe Checkout session so the customer can no longer
 * authorize a hold for an appointment that has already been settled.
 * Returns an error message instead of throwing.
 */
async function expireCheckoutSession(sessionId: string): Promise<string | null> {
  try {
    const stripe = await getUncachableStripeClient();
    await stripe.checkout.sessions.expire(sessionId);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId }, "Failed to expire Stripe Checkout session");
    return msg;
  }
}

/** Capture (part of) a Stripe authorization; returns an error message instead of throwing. */
async function captureAuthorization(
  paymentIntentId: string,
  amountCents: number,
): Promise<string | null> {
  try {
    const stripe = await getUncachableStripeClient();
    await stripe.paymentIntents.capture(paymentIntentId, {
      amount_to_capture: amountCents,
    });
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, paymentIntentId }, "Failed to capture Stripe authorization");
    return msg;
  }
}

/** Conditionally settle a hold that is still in `fromStatus`. */
async function settleHold(
  holdId: number,
  fromStatus: string,
  updates: Partial<typeof sosDepositHoldsTable.$inferInsert>,
): Promise<DepositHoldRow | null> {
  const [settled] = await db
    .update(sosDepositHoldsTable)
    .set(updates)
    .where(
      and(
        eq(sosDepositHoldsTable.id, holdId),
        eq(sosDepositHoldsTable.status, fromStatus),
      ),
    )
    .returning();
  // Compliance ledger: terminal outcomes (captured/released/failed) land as
  // immutable entries. Only the call that performed the transition records.
  if (settled) await recordDepositOutcomeSafe(settled);
  return settled ?? null;
}

/**
 * Record a Stripe operation failure on the hold WITHOUT changing its status:
 * the authorization is still out there, so staff must see the error and the
 * hold stays actionable rather than silently flipping to a paper outcome.
 */
async function recordStripeFailure(
  holdId: number,
  message: string,
): Promise<DepositHoldRow | null> {
  const [updated] = await db
    .update(sosDepositHoldsTable)
    .set({ outcomeReason: message })
    .where(eq(sosDepositHoldsTable.id, holdId))
    .returning();
  return updated ?? null;
}

/**
 * Settle the hold when an appointment is cancelled: cancelling outside the
 * agreed window voids the Stripe authorization; cancelling inside it captures
 * the fee from the authorization. Uses the terms snapshotted on the hold, not
 * current settings. Conditional update: only settles an unresolved hold.
 */
export async function settleHoldOnCancellation(
  appointmentId: number,
  startsAt: Date,
  now: Date = new Date(),
): Promise<DepositHoldRow | null> {
  const [hold] = await db
    .select()
    .from(sosDepositHoldsTable)
    .where(eq(sosDepositHoldsTable.appointmentId, appointmentId));
  if (!hold) return null;
  if (hold.status !== "held" && hold.status !== "pending_authorization") {
    return hold;
  }

  const cutoff = new Date(
    startsAt.getTime() - hold.cancellationWindowHours * 60 * 60 * 1000,
  );
  const outsideWindow = now <= cutoff;

  // Customer never completed the card authorization: there is no money to
  // release or capture — expire the payment link so it can't be completed
  // later, then record the true outcome so staff can follow up.
  if (hold.status === "pending_authorization") {
    if (hold.stripeCheckoutSessionId) {
      await expireCheckoutSession(hold.stripeCheckoutSessionId);
    }
    return (
      (await settleHold(hold.id, "pending_authorization", {
        status: outsideWindow ? "released" : "failed",
        resolvedAt: now,
        outcomeReason: outsideWindow
          ? `Cancelled more than ${hold.cancellationWindowHours}h before the start time — no card was ever authorized, nothing to release.`
          : `Cancelled within the ${hold.cancellationWindowHours}h window, but the customer never completed the card authorization — the $${hold.feeAmount} late-cancellation fee could NOT be charged.`,
      })) ?? hold
    );
  }

  // Real authorization exists: void or capture it on Stripe first. Legacy
  // paper holds (no PaymentIntent) settle as bookkeeping only.
  if (hold.stripePaymentIntentId) {
    const stripeError = outsideWindow
      ? await voidAuthorization(hold.stripePaymentIntentId)
      : await captureAuthorization(hold.stripePaymentIntentId, cents(hold.feeAmount));
    if (stripeError) {
      return (
        (await recordStripeFailure(
          hold.id,
          `Stripe ${outsideWindow ? "release" : "fee capture"} FAILED — the card hold is still active and needs staff attention: ${stripeError}`,
        )) ?? hold
      );
    }
  }

  const settled = await settleHold(hold.id, "held", {
    status: outsideWindow ? "released" : "captured",
    resolvedAt: now,
    outcomeReason: outsideWindow
      ? `Cancelled more than ${hold.cancellationWindowHours}h before the start time — deposit hold released, no fee charged.`
      : `Cancelled within the ${hold.cancellationWindowHours}h cancellation window — late-cancellation fee of $${hold.feeAmount} captured from the held deposit.`,
  });
  // Notify only when this call performed the transition (concurrency guard).
  if (settled) {
    await notifyDepositEvent(
      settled,
      outsideWindow ? "released" : "captured_late_cancel",
    );
  }
  return settled ?? hold;
}

/** Capture the held deposit as a no-show penalty fee. */
export async function captureHoldForNoShow(
  appointmentId: number,
  now: Date = new Date(),
): Promise<DepositHoldRow | null> {
  const [hold] = await db
    .select()
    .from(sosDepositHoldsTable)
    .where(eq(sosDepositHoldsTable.appointmentId, appointmentId));
  if (!hold) return null;

  // Customer never completed the card authorization: no money to capture.
  // Expire the payment link so it can't be completed after the fact.
  if (hold.status === "pending_authorization") {
    if (hold.stripeCheckoutSessionId) {
      await expireCheckoutSession(hold.stripeCheckoutSessionId);
    }
    return (
      (await settleHold(hold.id, "pending_authorization", {
        status: "failed",
        resolvedAt: now,
        outcomeReason: `Marked as a no-show, but the customer never completed the card authorization — the $${hold.feeAmount} no-show fee could NOT be charged.`,
      })) ?? hold
    );
  }
  if (hold.status !== "held") return hold;

  if (hold.stripePaymentIntentId) {
    const stripeError = await captureAuthorization(
      hold.stripePaymentIntentId,
      cents(hold.feeAmount),
    );
    if (stripeError) {
      return (
        (await recordStripeFailure(
          hold.id,
          `Stripe no-show fee capture FAILED — the card hold is still active and needs staff attention: ${stripeError}`,
        )) ?? hold
      );
    }
  }

  const captured = await settleHold(hold.id, "held", {
    status: "captured",
    resolvedAt: now,
    outcomeReason: `Marked as a no-show — $${hold.feeAmount} no-show fee captured from the held deposit.`,
  });
  // Notify only when this call performed the transition (concurrency guard).
  if (captured) await notifyDepositEvent(captured, "captured_no_show");
  return captured ?? hold;
}

// ── Stripe webhook lifecycle ─────────────────────────────────────────────────

/** Minimal shape of the Stripe events this module reacts to. */
export type StripeDepositEvent = {
  type: string;
  data: {
    object: {
      id: string;
      payment_intent?: string | { id: string } | null;
    };
  };
};

/**
 * Apply a (signature-verified) Stripe webhook event to the deposit-hold
 * lifecycle:
 *  - checkout.session.completed → card authorized, hold becomes "held"
 *  - checkout.session.expired   → link expired unauthorized, hold "failed"
 *  - payment_intent.canceled    → authorization voided/expired on Stripe's
 *    side (e.g. the 7-day auto-expiry), hold "released"
 */
export async function applyStripeDepositEvent(
  event: StripeDepositEvent,
): Promise<void> {
  const obj = event.data?.object;
  if (!obj?.id) return;

  if (event.type === "checkout.session.completed") {
    const paymentIntentId =
      typeof obj.payment_intent === "string"
        ? obj.payment_intent
        : (obj.payment_intent?.id ?? null);
    const heldRows = await db
      .update(sosDepositHoldsTable)
      .set({
        status: "held",
        stripePaymentIntentId: paymentIntentId,
        outcomeReason:
          "Card authorized — deposit held on the customer's card under the No-Show Shield policy.",
      })
      .where(
        and(
          eq(sosDepositHoldsTable.stripeCheckoutSessionId, obj.id),
          eq(sosDepositHoldsTable.status, "pending_authorization"),
        ),
      )
      .returning();
    for (const row of heldRows) await notifyDepositEvent(row, "held");

    // Defensive: the session was completed but no pending hold matched — the
    // appointment was already cancelled/no-showed. Void the orphan
    // authorization so no untracked money stays held on the customer's card.
    if (heldRows.length === 0 && paymentIntentId) {
      const [staleHold] = await db
        .select()
        .from(sosDepositHoldsTable)
        .where(eq(sosDepositHoldsTable.stripeCheckoutSessionId, obj.id));
      if (staleHold) {
        logger.warn(
          { sessionId: obj.id, paymentIntentId, holdId: staleHold.id },
          "Late checkout completion on a settled hold — voiding orphan authorization",
        );
        const voidError = await voidAuthorization(paymentIntentId);
        await db
          .update(sosDepositHoldsTable)
          .set({
            outcomeReason: voidError
              ? `${staleHold.outcomeReason ?? ""} The customer later authorized the expired payment link and the automatic void FAILED — a card hold may still be active and needs staff attention: ${voidError}`.trim()
              : `${staleHold.outcomeReason ?? ""} The customer later authorized the payment link after settlement; the authorization was automatically voided — no money is held.`.trim(),
          })
          .where(eq(sosDepositHoldsTable.id, staleHold.id));
      }
    }
    return;
  }

  if (event.type === "checkout.session.expired") {
    const failedRows = await db
      .update(sosDepositHoldsTable)
      .set({
        status: "failed",
        resolvedAt: new Date(),
        outcomeReason:
          "The payment link expired before the customer authorized the deposit — no money is held for this booking.",
      })
      .where(
        and(
          eq(sosDepositHoldsTable.stripeCheckoutSessionId, obj.id),
          eq(sosDepositHoldsTable.status, "pending_authorization"),
        ),
      )
      .returning();
    for (const row of failedRows) await recordDepositOutcomeSafe(row);
    return;
  }

  if (event.type === "payment_intent.canceled") {
    const releasedRows = await db
      .update(sosDepositHoldsTable)
      .set({
        status: "released",
        resolvedAt: new Date(),
        outcomeReason:
          "The card authorization was voided or expired on Stripe — the deposit hold is no longer active.",
      })
      .where(
        and(
          eq(sosDepositHoldsTable.stripePaymentIntentId, obj.id),
          eq(sosDepositHoldsTable.status, "held"),
        ),
      )
      .returning();
    for (const row of releasedRows) await recordDepositOutcomeSafe(row);
  }
}

/** Serialize a hold row into the SosDepositHold API shape (or null). */
export function serializeDepositHold(hold: DepositHoldRow | null | undefined) {
  if (!hold) return null;
  return {
    id: hold.id,
    status: hold.status,
    depositAmount: parseFloat(hold.depositAmount),
    feeAmount: parseFloat(hold.feeAmount),
    cancellationWindowHours: hold.cancellationWindowHours,
    outcomeReason: hold.outcomeReason,
    checkoutUrl: hold.checkoutUrl,
    createdAt: hold.createdAt.toISOString(),
    resolvedAt: hold.resolvedAt ? hold.resolvedAt.toISOString() : null,
  };
}
