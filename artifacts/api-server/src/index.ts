import app from "./app";
import { logger } from "./lib/logger";
import { seedConnectorMapping } from "./lib/connectorSeed";

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

// Idempotent: upsert the hidden connector mapping so the admin Connector
// Registry is always complete, in every environment.
seedConnectorMapping().catch((err) => {
  logger.error({ err }, "Connector mapping seed failed");
});

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
