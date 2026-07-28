import { sendMessageSafe } from "./messaging";
import { isValidEmail, publicAppBaseUrl } from "./email";

// ── Transactional email touchpoints ─────────────────────────────────────────
// Booking confirmations and checkout receipts, sent as a complement to SMS
// (never a replacement). Gated here on an email being on file; the shared
// messaging layer additionally enforces the customer's email opt-in flag and
// records the send in the unified messages table (channel "email") so it
// shows in the communications timeline.
//
// All URLs are fully qualified — recipients read email outside the app.

interface EmailCustomer {
  id: number;
  name: string;
  email: string | null;
}

const dateFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export interface BookingConfirmationEmailArgs {
  tenantId: number | null;
  customer: EmailCustomer;
  businessName: string;
  /** Tenant subdomain slug for the public booking-page link, when known. */
  slug?: string | null;
  serviceType: string;
  startsAt: Date;
  staffName?: string | null;
  appointmentId: number;
}

/** Send a booking-confirmation email; never throws, never blocks booking. */
export async function sendBookingConfirmationEmailSafe(
  args: BookingConfirmationEmailArgs,
): Promise<void> {
  if (!args.customer.email || !isValidEmail(args.customer.email)) return;
  const base = publicAppBaseUrl();
  const manageUrl = args.slug ? `${base}/book/${args.slug}` : base;
  const lines = [
    `Hi ${args.customer.name},`,
    "",
    `Your appointment at ${args.businessName} is confirmed.`,
    "",
    `Service: ${args.serviceType}`,
    `When: ${dateFmt.format(args.startsAt)}`,
    ...(args.staffName ? [`With: ${args.staffName}`] : []),
    "",
    `Need to make a change? Visit ${manageUrl} or reply to the text messages from ${args.businessName}.`,
    "",
    `— ${args.businessName}`,
  ];
  await sendMessageSafe({
    tenantId: args.tenantId,
    customerId: args.customer.id,
    channel: "email",
    kind: "booking_confirmation",
    toEmail: args.customer.email,
    subject: `Appointment confirmed — ${args.businessName}`,
    body: lines.join("\n"),
    context: { appointmentId: args.appointmentId },
  });
}

export interface ReceiptEmailArgs {
  tenantId: number | null;
  customer: EmailCustomer;
  businessName: string;
  serviceType: string;
  /** Payment amount as a numeric string (e.g. "45.00"), when recorded. */
  paymentAmount: string | null;
  checkedOutAt: Date;
  visitId: number;
}

/** Send a checkout receipt email; never throws, never blocks checkout. */
export async function sendReceiptEmailSafe(args: ReceiptEmailArgs): Promise<void> {
  if (!args.customer.email || !isValidEmail(args.customer.email)) return;
  const base = publicAppBaseUrl();
  const amount =
    args.paymentAmount != null && parseFloat(args.paymentAmount) > 0
      ? `$${parseFloat(args.paymentAmount).toFixed(2)}`
      : null;
  const lines = [
    `Hi ${args.customer.name},`,
    "",
    `Thanks for visiting ${args.businessName}!`,
    "",
    `Service: ${args.serviceType}`,
    ...(amount ? [`Amount paid: ${amount}`] : []),
    `Date: ${dateFmt.format(args.checkedOutAt)}`,
    "",
    `Book your next visit any time at ${base}.`,
    "",
    `— ${args.businessName}`,
  ];
  await sendMessageSafe({
    tenantId: args.tenantId,
    customerId: args.customer.id,
    channel: "email",
    kind: "receipt",
    toEmail: args.customer.email,
    subject: `Your receipt from ${args.businessName}`,
    body: lines.join("\n"),
    context: { visitId: args.visitId },
  });
}
