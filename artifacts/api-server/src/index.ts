import app from "./app";
import { logger } from "./lib/logger";
import { seedConnectorMapping } from "./lib/connectorSeed";
import { startConciergeWorker, type ConciergeWorkerHandle } from "./workers/concierge";
import { pool, checkSchemaDrift, formatDriftReport } from "@workspace/db";

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

// Startup validation: warn loudly if the database is missing tables/columns
// that exist in the Drizzle schema (i.e. schema changes were never pushed).
checkSchemaDrift(pool)
  .then((report) => {
    if (!report.ok) {
      logger.error({ report }, formatDriftReport(report));
    } else {
      logger.info("Database schema matches code schema");
    }
  })
  .catch((err) => {
    logger.error({ err }, "Schema drift check failed");
  });

// Idempotent: upsert the hidden connector mapping so the admin Connector
// Registry is always complete, in every environment.
seedConnectorMapping().catch((err) => {
  logger.error({ err }, "Connector mapping seed failed");
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
