import { getStripeSync } from "./stripeClient";
import { applyStripeDepositEvent, type StripeDepositEvent } from "./noShowShield";
import { logger } from "./logger";

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    // Validate payload is a Buffer
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. " +
          "Received type: " + typeof payload + ". " +
          "This usually means express.json() parsed the body before reaching this handler. " +
          "FIX: Ensure webhook route is registered BEFORE app.use(express.json()).",
      );
    }

    // stripe-replit-sync verifies the signature and syncs Stripe data.
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);

    // Domain logic on the (now signature-verified) event: keep the No-Show
    // Shield deposit-hold lifecycle in step with Stripe. A failure here must
    // not make Stripe retry the already-synced event.
    let event: StripeDepositEvent | null = null;
    try {
      event = JSON.parse(payload.toString("utf8")) as StripeDepositEvent;
      await applyStripeDepositEvent(event);
    } catch (err) {
      logger.error({ err }, "Deposit-hold webhook handling failed");
    }

    // Module checkout payments: provision the paid cart exactly once when its
    // Checkout session completes (failed/expired sessions provision nothing).
    if (event) {
      try {
        const { applyModuleCheckoutEvent } = await import("./moduleCheckout");
        await applyModuleCheckoutEvent(event);
      } catch (err) {
        logger.error({ err }, "Module-checkout webhook handling failed");
      }
    }
  }
}
