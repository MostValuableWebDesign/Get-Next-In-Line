import { db, sosMessagesTable, sosSettingsTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * SMS sending service. Uses Twilio when credentials are available (via the
 * Replit Twilio connector or TWILIO_* env vars); otherwise records the
 * message with deliveryStatus "simulated" so the product flow keeps working
 * end-to-end and is explicit about the fact that nothing was really sent.
 */

interface SendSmsOptions {
  customerId?: number | null;
  toNumber: string | null | undefined;
  body: string;
  kind: "you_are_next" | "slot_open" | "ai_followup" | "manual";
}

interface TwilioCreds {
  accountSid: string;
  authToken: string;
  fromNumber: string | null;
}

async function getTwilioCreds(): Promise<TwilioCreds | null> {
  // Replit Twilio connector exposes credentials through the connectors proxy.
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (hostname && xReplitToken) {
    try {
      const res = await fetch(
        `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=twilio`,
        { headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken } },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          items?: Array<{ settings?: Record<string, string> }>;
        };
        const settings = data.items?.[0]?.settings;
        const accountSid = settings?.account_sid ?? settings?.accountSid;
        const authToken = settings?.api_key ?? settings?.auth_token ?? settings?.authToken;
        const fromNumber = settings?.phone_number ?? settings?.from_number ?? null;
        if (accountSid && authToken) {
          return { accountSid, authToken, fromNumber };
        }
      }
    } catch (err) {
      logger.warn({ err }, "Twilio connector lookup failed; falling back");
    }
  }

  // Plain env var fallback
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (accountSid && authToken) {
    return {
      accountSid,
      authToken,
      fromNumber: process.env.TWILIO_PHONE_NUMBER ?? null,
    };
  }
  return null;
}

export async function sendSms(opts: SendSmsOptions): Promise<{
  id: number;
  deliveryStatus: string;
}> {
  const [settings] = await db.select().from(sosSettingsTable).limit(1);
  const creds = await getTwilioCreds();
  const fromNumber = settings?.smsFromNumber ?? creds?.fromNumber ?? null;

  let deliveryStatus: "sent" | "failed" | "simulated" = "simulated";
  let providerSid: string | null = null;

  if (creds && fromNumber && opts.toNumber) {
    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization:
              "Basic " +
              Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: opts.toNumber,
            From: fromNumber,
            Body: opts.body,
          }),
        },
      );
      if (res.ok) {
        const payload = (await res.json()) as { sid?: string };
        providerSid = payload.sid ?? null;
        deliveryStatus = "sent";
      } else {
        const errText = await res.text();
        logger.error({ status: res.status, errText }, "Twilio send failed");
        deliveryStatus = "failed";
      }
    } catch (err) {
      logger.error({ err }, "Twilio send threw");
      deliveryStatus = "failed";
    }
  }

  const [row] = await db
    .insert(sosMessagesTable)
    .values({
      customerId: opts.customerId ?? null,
      toNumber: opts.toNumber ?? null,
      direction: "outbound",
      body: opts.body,
      kind: opts.kind,
      deliveryStatus,
      providerSid,
    })
    .returning({ id: sosMessagesTable.id });

  return { id: row.id, deliveryStatus };
}
