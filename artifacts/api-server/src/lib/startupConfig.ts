import { logger } from "./logger";

/**
 * Startup configuration report: one structured log line summarizing which
 * optional integrations are live vs running in simulated/fallback mode, so
 * a deployment missing Twilio/Stripe/etc. is obvious at boot instead of
 * surfacing as mysterious user-facing failures deep inside a request.
 *
 * Fail-fast for truly required settings stays where it already is (the
 * SESSION_SECRET guard in app.ts) — this report never throws.
 */

export type ServiceMode = "live" | "simulated";

export interface ServiceStatus {
  service: "stripe" | "sms" | "email" | "openai";
  mode: ServiceMode;
  detail: string | null;
}

export interface StartupConfigProbes {
  /** True when Stripe credentials are reachable (connector or env). */
  stripeConfigured: () => Promise<boolean>;
  /** Live vs simulated SMS (Twilio creds + From number). */
  smsMode: () => Promise<ServiceMode>;
  /** Live vs simulated transactional email (Resend creds). */
  emailMode: () => Promise<ServiceMode>;
  env?: NodeJS.ProcessEnv;
}

/** OpenAI is configured when both AI-integrations proxy env vars are set. */
export function isOpenAiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.AI_INTEGRATIONS_OPENAI_BASE_URL && env.AI_INTEGRATIONS_OPENAI_API_KEY,
  );
}

/**
 * Evaluate each optional integration. Every probe is wrapped so a failing
 * lookup reports "simulated" with the error instead of breaking startup.
 */
export async function evaluateStartupConfig(
  probes: StartupConfigProbes,
): Promise<ServiceStatus[]> {
  const env = probes.env ?? process.env;

  async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<{ value: T; error: string | null }> {
    try {
      return { value: await fn(), error: null };
    } catch (err) {
      return { value: fallback, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const [stripe, sms, email] = await Promise.all([
    safe(probes.stripeConfigured, false),
    safe(probes.smsMode, "simulated" as ServiceMode),
    safe(probes.emailMode, "simulated" as ServiceMode),
  ]);

  const openaiLive = isOpenAiConfigured(env);

  return [
    {
      service: "stripe",
      mode: stripe.value ? "live" : "simulated",
      detail: stripe.error
        ? `credential check failed: ${stripe.error}`
        : stripe.value
          ? "Stripe connector credentials available"
          : "no Stripe credentials — module checkout runs in simulated mode",
    },
    {
      service: "sms",
      mode: sms.value,
      detail: sms.error
        ? `status check failed: ${sms.error}`
        : sms.value === "live"
          ? "Twilio credentials + From number configured"
          : "no Twilio credentials/From number — SMS sends are simulated",
    },
    {
      service: "email",
      mode: email.value,
      detail: email.error
        ? `status check failed: ${email.error}`
        : email.value === "live"
          ? "Resend credentials configured"
          : "no Resend credentials — email sends are simulated",
    },
    {
      service: "openai",
      mode: openaiLive ? "live" : "simulated",
      detail: openaiLive
        ? "AI integrations proxy configured"
        : "AI_INTEGRATIONS_OPENAI_* not set — AI features use rule-based fallbacks",
    },
  ];
}

/** One-line human summary, e.g. "stripe=live sms=simulated ...". */
export function formatStartupConfigSummary(services: ServiceStatus[]): string {
  return services.map((s) => `${s.service}=${s.mode}`).join(" ");
}

/**
 * Collect the report with the real probes and emit a single structured log
 * line. Never throws.
 */
export async function logStartupConfigReport(): Promise<void> {
  try {
    const [{ isStripeConfigured }, { getSmsStatus }, { getEmailStatus }] =
      await Promise.all([
        import("./stripeClient"),
        import("./sms"),
        import("./email"),
      ]);
    const services = await evaluateStartupConfig({
      stripeConfigured: async () => isStripeConfigured(),
      smsMode: async () => (await getSmsStatus(null)).smsMode,
      emailMode: async () => (await getEmailStatus()).emailMode,
    });
    logger.info(
      { startupConfig: services },
      `Integration config: ${formatStartupConfigSummary(services)}`,
    );
  } catch (err) {
    logger.error({ err }, "Startup config report failed");
  }
}
