import { createHmac, timingSafeEqual } from "crypto";

/**
 * External POS webhook connectors — vendor adapters.
 *
 * Each supported vendor (Square, Clover, Boulevard, Vagaro) gets:
 *  - signature verification over the raw request body with the integration's
 *    signing secret (vendor-specific header + encoding), and
 *  - payload translation onto the platform's normalized POS event shape.
 *
 * The payloads are vendor-shaped (matching each vendor's webhook style) but
 * simulated — no real vendor sandbox certification is implied. Verification
 * schemes mirror the real ones closely enough that live endpoints drop in.
 */

export const POS_VENDORS = ["square", "clover", "boulevard", "vagaro"] as const;
export type PosVendor = (typeof POS_VENDORS)[number];

export function isPosVendor(v: string): v is PosVendor {
  return (POS_VENDORS as readonly string[]).includes(v);
}

export const POS_VENDOR_LABELS: Record<PosVendor, string> = {
  square: "Square",
  clover: "Clover",
  boulevard: "Boulevard",
  vagaro: "Vagaro",
};

/** Vendor-specific signature header name. */
export const POS_SIGNATURE_HEADERS: Record<PosVendor, string> = {
  square: "x-square-hmacsha256-signature",
  clover: "x-clover-auth",
  boulevard: "x-boulevard-signature",
  vagaro: "x-vagaro-signature",
};

export type NormalizedPosEventKind =
  | "check_in"
  | "service_completed"
  | "perk_redeemed"
  | "unknown";

export interface NormalizedPosCustomer {
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface NormalizedPosEvent {
  /** Vendor-supplied event id — the idempotency key under retries. */
  externalEventId: string;
  kind: NormalizedPosEventKind;
  customer: NormalizedPosCustomer | null;
  serviceType: string | null;
  staffName: string | null;
  paymentAmount: number | null;
  /** Perk pass token (WPASS-…) for perk_redeemed events. */
  perkToken: string | null;
  /** Vendor event descriptor, for the event log on unknown kinds. */
  vendorEventType: string | null;
}

// ── signature verification ───────────────────────────────────────────────────

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Compute the signature header value a vendor would send for this body. */
export function computePosSignature(
  vendor: PosVendor,
  rawBody: Buffer,
  secret: string
): string {
  switch (vendor) {
    case "square":
      // Square-style: base64 HMAC-SHA256 over the raw body.
      return createHmac("sha256", secret).update(rawBody).digest("base64");
    case "clover":
      // Clover-style: shared auth code sent verbatim in X-Clover-Auth.
      return secret;
    case "boulevard":
      // Boulevard-style: hex HMAC-SHA256 over the raw body.
      return createHmac("sha256", secret).update(rawBody).digest("hex");
    case "vagaro":
      // Vagaro-style: base64 HMAC-SHA256 over the raw body.
      return createHmac("sha256", secret).update(rawBody).digest("base64");
  }
}

/** Verify a delivery's signature header against the integration's secret. */
export function verifyPosSignature(
  vendor: PosVendor,
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader) return false;
  return safeEqual(signatureHeader, computePosSignature(vendor, rawBody, secret));
}

// ── payload translation ──────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function asObj(v: unknown): Json {
  return typeof v === "object" && v !== null ? (v as Json) : {};
}
function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function centsToDollars(v: unknown): number | null {
  const n = asNum(v);
  return n == null ? null : Math.round(n) / 100;
}

function customer(o: Json, nameKey = "name", phoneKey = "phone", emailKey = "email") {
  const c: NormalizedPosCustomer = {
    name: asStr(o[nameKey]),
    phone: asStr(o[phoneKey]),
    email: asStr(o[emailKey]),
  };
  return c.name || c.phone || c.email ? c : null;
}

function base(externalEventId: string, vendorEventType: string | null): NormalizedPosEvent {
  return {
    externalEventId,
    kind: "unknown",
    customer: null,
    serviceType: null,
    staffName: null,
    paymentAmount: null,
    perkToken: null,
    vendorEventType,
  };
}

/**
 * Translate a parsed vendor payload into the normalized event shape.
 * Returns null when the payload is malformed (no usable event id).
 * A recognizable payload with an unmapped event type comes back with
 * kind "unknown" so it lands in the event log instead of being dropped.
 */
export function translatePosPayload(vendor: PosVendor, payload: unknown): NormalizedPosEvent | null {
  const p = asObj(payload);
  switch (vendor) {
    case "square": {
      const id = asStr(p.event_id);
      if (!id) return null;
      const type = asStr(p.type);
      const ev = base(id, type);
      const object = asObj(asObj(p.data).object);
      if (type === "booking.updated") {
        const booking = asObj(object.booking);
        const cust = asObj(booking.customer);
        ev.customer = customer(
          { ...cust, name: cust.given_name_and_surname ?? cust.name },
          "name",
          "phone_number",
          "email_address"
        );
        ev.serviceType = asStr(booking.service_name);
        ev.staffName = asStr(booking.team_member_name);
        ev.paymentAmount = centsToDollars(asObj(booking.amount_money).amount);
        const status = asStr(booking.status);
        if (status === "CHECKED_IN") ev.kind = "check_in";
        else if (status === "COMPLETED") ev.kind = "service_completed";
      } else if (type === "loyalty.event.created") {
        const loyalty = asObj(object.loyalty_event);
        if (asStr(loyalty.type) === "REDEEM_REWARD") {
          ev.kind = "perk_redeemed";
          ev.perkToken = asStr(loyalty.reward_code);
          ev.customer = customer(asObj(loyalty.customer), "name", "phone_number", "email_address");
        }
      }
      return ev;
    }
    case "clover": {
      const id = asStr(p.eventId);
      if (!id) return null;
      const type = asStr(p.type);
      const ev = base(id, type);
      const object = asObj(p.object);
      ev.customer = customer(asObj(object.customer));
      ev.serviceType = asStr(object.service);
      ev.staffName = asStr(object.employeeName);
      ev.paymentAmount = centsToDollars(object.total);
      if (type === "CUSTOMER_CHECKIN") ev.kind = "check_in";
      else if (type === "ORDER_COMPLETED") ev.kind = "service_completed";
      else if (type === "REWARD_REDEEMED") {
        ev.kind = "perk_redeemed";
        ev.perkToken = asStr(object.rewardCode);
      }
      return ev;
    }
    case "boulevard": {
      const id = asStr(p.id);
      if (!id) return null;
      const type = asStr(p.event);
      const ev = base(id, type);
      const data = asObj(p.data);
      if (type === "appointment.state_changed") {
        const appt = asObj(data.appointment);
        ev.customer = customer(asObj(appt.client), "name", "mobile_phone", "email");
        ev.serviceType = asStr(appt.service_name);
        ev.staffName = asStr(appt.staff_name);
        ev.paymentAmount = asNum(appt.total_amount);
        const state = asStr(appt.state);
        if (state === "arrived") ev.kind = "check_in";
        else if (state === "completed") ev.kind = "service_completed";
      } else if (type === "reward.redeemed") {
        ev.kind = "perk_redeemed";
        ev.perkToken = asStr(asObj(data.reward).code);
        ev.customer = customer(asObj(data.client), "name", "mobile_phone", "email");
      }
      return ev;
    }
    case "vagaro": {
      const id = asStr(p.eventId);
      if (!id) return null;
      const type = asStr(p.eventType);
      const ev = base(id, type);
      const data = asObj(p.data);
      ev.customer = customer(asObj(data.customer));
      ev.serviceType = asStr(data.serviceTitle);
      ev.staffName = asStr(data.providerName);
      ev.paymentAmount = asNum(data.price);
      if (type === "checkin.created") ev.kind = "check_in";
      else if (type === "appointment.completed") ev.kind = "service_completed";
      else if (type === "promotion.redeemed") {
        ev.kind = "perk_redeemed";
        ev.perkToken = asStr(data.promoCode);
      }
      return ev;
    }
  }
}

// ── simulator payload builders (dev harness + tests) ─────────────────────────

export interface SimulatedPosFields {
  externalEventId: string;
  kind: Exclude<NormalizedPosEventKind, "unknown">;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  serviceType?: string | null;
  staffName?: string | null;
  paymentAmount?: number | null;
  perkToken?: string | null;
}

/** Build a vendor-shaped payload for the dev simulator / integration tests. */
export function buildSimulatedPosPayload(vendor: PosVendor, f: SimulatedPosFields): Json {
  const cents =
    f.paymentAmount != null ? Math.round(f.paymentAmount * 100) : null;
  switch (vendor) {
    case "square": {
      if (f.kind === "perk_redeemed") {
        return {
          event_id: f.externalEventId,
          type: "loyalty.event.created",
          data: {
            object: {
              loyalty_event: {
                type: "REDEEM_REWARD",
                reward_code: f.perkToken ?? null,
                customer: {
                  name: f.customerName ?? null,
                  phone_number: f.customerPhone ?? null,
                  email_address: f.customerEmail ?? null,
                },
              },
            },
          },
        };
      }
      return {
        event_id: f.externalEventId,
        type: "booking.updated",
        data: {
          object: {
            booking: {
              status: f.kind === "check_in" ? "CHECKED_IN" : "COMPLETED",
              customer: {
                name: f.customerName ?? null,
                phone_number: f.customerPhone ?? null,
                email_address: f.customerEmail ?? null,
              },
              service_name: f.serviceType ?? null,
              team_member_name: f.staffName ?? null,
              amount_money: cents == null ? null : { amount: cents, currency: "USD" },
            },
          },
        },
      };
    }
    case "clover":
      return {
        eventId: f.externalEventId,
        type:
          f.kind === "check_in"
            ? "CUSTOMER_CHECKIN"
            : f.kind === "service_completed"
              ? "ORDER_COMPLETED"
              : "REWARD_REDEEMED",
        object: {
          customer: {
            name: f.customerName ?? null,
            phone: f.customerPhone ?? null,
            email: f.customerEmail ?? null,
          },
          service: f.serviceType ?? null,
          employeeName: f.staffName ?? null,
          total: cents,
          rewardCode: f.perkToken ?? null,
        },
      };
    case "boulevard": {
      if (f.kind === "perk_redeemed") {
        return {
          id: f.externalEventId,
          event: "reward.redeemed",
          data: {
            reward: { code: f.perkToken ?? null },
            client: {
              name: f.customerName ?? null,
              mobile_phone: f.customerPhone ?? null,
              email: f.customerEmail ?? null,
            },
          },
        };
      }
      return {
        id: f.externalEventId,
        event: "appointment.state_changed",
        data: {
          appointment: {
            state: f.kind === "check_in" ? "arrived" : "completed",
            client: {
              name: f.customerName ?? null,
              mobile_phone: f.customerPhone ?? null,
              email: f.customerEmail ?? null,
            },
            service_name: f.serviceType ?? null,
            staff_name: f.staffName ?? null,
            total_amount: f.paymentAmount ?? null,
          },
        },
      };
    }
    case "vagaro":
      return {
        eventId: f.externalEventId,
        eventType:
          f.kind === "check_in"
            ? "checkin.created"
            : f.kind === "service_completed"
              ? "appointment.completed"
              : "promotion.redeemed",
        data: {
          customer: {
            name: f.customerName ?? null,
            phone: f.customerPhone ?? null,
            email: f.customerEmail ?? null,
          },
          serviceTitle: f.serviceType ?? null,
          providerName: f.staffName ?? null,
          price: f.paymentAmount ?? null,
          promoCode: f.perkToken ?? null,
        },
      };
  }
}
