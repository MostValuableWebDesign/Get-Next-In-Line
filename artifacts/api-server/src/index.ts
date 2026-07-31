import { assertProductionEnv } from "./lib/startupChecks";

// Fail fast BEFORE loading app/session middleware: production with missing
// critical secrets must abort with an actionable message, never serve.
assertProductionEnv();

import app from "./app";
import { logger } from "./lib/logger";
import { seedConnectorMapping } from "./lib/connectorSeed";
import { backfillCustomerLinks } from "./lib/customerLink";
import { backfillVisitCadence } from "./lib/visitCadence";
import { startConciergeWorker, type ConciergeWorkerHandle } from "./workers/concierge";
import {
  pool,
  checkSchemaDrift,
  formatDriftReport,
  applyPendingMigrations,
  findMigrationsDir,
} from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Startup self-heal: the Replit dev database can be restored to an older
// checkpoint snapshot while the code (and its migrations) stay newer. When
// that happens, apply the pending migrations in reconcile mode — strictly
// additive-forward (never drops or rewinds data) — and THEN run the connector
// seed so partner brands / hidden connectors / markups are backfilled into
// the repaired schema. All steps are idempotent and safe to re-run.
async function ensureDatabaseReady(): Promise<void> {
  const isProduction = process.env.NODE_ENV === "production";
  try {
    let report = await checkSchemaDrift(pool);
    if (!report.ok && isProduction) {
      // Production must never auto-apply migrations on boot. Report the
      // drift loudly and refuse to serve until it is resolved deliberately
      // (run the migration workflow, then redeploy).
      logger.error(
        { report },
        `FATAL: production database schema does not match the code schema. ` +
          `Refusing to start — apply pending migrations deliberately ` +
          `(pnpm run db:push / db:reconcile against the production DB) and redeploy.\n` +
          formatDriftReport(report),
      );
      process.exit(1);
    }
    if (!report.ok) {
      logger.warn(
        { report },
        `Dev DB is behind the code schema (likely a checkpoint DB restore) — self-healing by applying pending migrations (non-destructive):\n${formatDriftReport(report)}`,
      );
      const migrationsDir = findMigrationsDir();
      if (!migrationsDir) {
        logger.error(
          "Cannot self-heal: lib/db/migrations not found from cwd. Run `pnpm run db:reconcile` manually.",
        );
      } else {
        const result = await applyPendingMigrations(pool, {
          migrationsDir,
          reconcile: true,
          log: (m) => logger.info(m),
        });
        report = await checkSchemaDrift(pool);
        if (report.ok) {
          logger.info(
            { applied: result.applied, skippedStatements: result.skippedStatements },
            "Dev DB drift repaired: schema now matches code schema",
          );
        } else {
          logger.error({ report }, formatDriftReport(report));
        }
      }
    } else {
      logger.info("Database schema matches code schema");
    }
  } catch (err) {
    logger.error({ err }, "Schema drift check/self-heal failed");
  }

  // Idempotent: remove tenants stranded by crashed integration-test runs
  // (structural subdomain match + age guard, so real tenants and live test
  // runs are never touched).
  try {
    const { sweepStaleTestTenants } = await import("./lib/testTenantSweep");
    await sweepStaleTestTenants();
  } catch (err) {
    logger.error({ err }, "Stale test-tenant sweep failed");
  }

  // Idempotent: upsert the hidden connector mapping so the admin Connector
  // Registry (8 partner brands, hidden resale connectors, markup overrides)
  // is always complete, in every environment — runs AFTER schema repair so
  // the backfill lands in the repaired columns.
  try {
    await seedConnectorMapping();
  } catch (err) {
    logger.error({ err }, "Connector mapping seed failed");
  }

  // Idempotent: migrate legacy comma-separated serviceNames settings into the
  // structured service catalog (skips scopes that already have catalog rows).
  // Runs AFTER schema repair so the sos_services table is guaranteed present.
  try {
    const { backfillServiceCatalog } = await import("./lib/serviceCatalog");
    await backfillServiceCatalog();
  } catch (err) {
    logger.error({ err }, "Service catalog backfill failed");
  }

  // Idempotent: clear obvious placeholder sms_from_number overrides (e.g. the
  // legacy demo +15550100000) so they can't silently break live sends with
  // Twilio error 21659. New writes are rejected at the settings routes.
  try {
    const { clearPlaceholderFromNumbers } = await import("./lib/sms");
    const cleared = await clearPlaceholderFromNumbers();
    if (cleared > 0) {
      logger.warn({ cleared }, "Cleared placeholder SMS From-number overrides from settings");
    }
  } catch (err) {
    logger.error({ err }, "Placeholder SMS From-number cleanup failed");
  }

  // Idempotent: give pre-existing co-op partnerships their direction-aware
  // cross-promotion tracking codes (new rows get codes at insert time).
  try {
    const { backfillCoopTrackingCodes } = await import("./lib/coopTracking");
    await backfillCoopTrackingCodes();
  } catch (err) {
    logger.error({ err }, "Coop tracking code backfill failed");
  }
}
ensureDatabaseReady().catch((err) => {
  logger.error({ err }, "Database readiness bootstrap failed");
});

// Idempotent: link pre-existing SOS customers to concierge client profiles
// by unambiguous phone match (link is a durable FK once established).
backfillCustomerLinks()
  .then(() =>
    // Runs after linking so freshly linked customers' history counts too.
    // Idempotent: recomputes last-visit/average-cycle from completed visits,
    // respecting manual overrides.
    backfillVisitCadence(),
  )
  .catch((err) => {
    logger.error({ err }, "Customer link / visit cadence backfill failed");
  });

// Neighborhood Passport: idempotent stamp backfill from historical perk
// redemptions so existing customers start with credit (never sends messages).
import("./lib/passport")
  .then(({ backfillPassportStampsSafe }) => backfillPassportStampsSafe())
  .catch((err) => {
    logger.error({ err }, "Passport stamp backfill failed to start");
  });

// Stripe (No-Show Shield deposit holds): create the stripe schema, register
// the managed webhook, and backfill existing data. Failure-tolerant so a
// Stripe outage never blocks the API from serving; deposit authorization
// attempts surface their own errors per booking.
async function initStripe() {
  const { isStripeConfigured, getStripeSync } = await import("./lib/stripeClient");
  if (!isStripeConfigured()) {
    logger.warn(
      "Stripe connector not configured — No-Show Shield deposit holds cannot create real card authorizations",
    );
    return;
  }
  const { runMigrations } = await import("stripe-replit-sync");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL required for Stripe integration");
  await runMigrations({ databaseUrl });
  const stripeSync = await getStripeSync();
  const { currentStripeWebhookUrl } = await import("./lib/stripeWebhookSelfHeal");
  const webhookUrl = currentStripeWebhookUrl();
  if (webhookUrl) {
    await stripeSync.findOrCreateManagedWebhook(webhookUrl);
  } else {
    logger.warn("No public domain known — skipping Stripe managed webhook registration");
  }
  stripeSync
    .syncBackfill()
    .then(() => logger.info("Stripe data synced"))
    .catch((err) => logger.error({ err }, "Stripe data backfill failed"));
  logger.info("Stripe initialized (webhook + schema ready)");
}
initStripe().catch((err) => {
  logger.error({ err }, "Stripe initialization failed");
});

// One structured summary of which optional integrations (Stripe, Twilio SMS,
// email, OpenAI) are live vs simulated, so misconfiguration is visible at
// boot. Never throws; required-setting fail-fast stays in app.ts.
import("./lib/startupConfig")
  .then(({ logStartupConfigReport }) => logStartupConfigReport())
  .catch((err) => {
    logger.error({ err }, "Startup config report failed to load");
  });

// Twilio webhook domain-drift self-heal: if the dev/production domain rotated
// while the Twilio number's inbound SMS/voice webhooks pointed at the old
// URL, repair them via the existing auto-configure. No-op under test mode or
// when creds/proxy/public URL are absent; throttled inside the module.
import("./lib/twilioWebhookSelfHeal")
  .then(({ runTwilioWebhookSelfHeal }) => runTwilioWebhookSelfHeal())
  .catch((err) => {
    logger.error({ err }, "Twilio webhook self-heal failed to start");
  });

// Concierge background worker (reminders + rebooking nudges). BullMQ when
// REDIS_URL is set; in-process interval scheduler otherwise.
let conciergeWorker: ConciergeWorkerHandle | null = null;
startConciergeWorker()
  .then((handle) => {
    conciergeWorker = handle;
  })
  .catch((err) => {
    logger.error({ err }, "Concierge worker failed to start");
  });

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Graceful shutdown: stop the worker and close the HTTP server.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  try {
    await conciergeWorker?.stop();
  } catch (err) {
    logger.error({ err }, "Error stopping concierge worker");
  }
  server.close(() => process.exit(0));
  // Hard exit if connections refuse to drain.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
