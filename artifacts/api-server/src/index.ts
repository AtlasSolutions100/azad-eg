import app from "./app";
import { logger } from "./lib/logger";
import { ensureDirs } from "./lib/paths";
import { seedDatabase } from "./lib/seed";
import { startProcastScheduler } from "./lib/procastScheduler";

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

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  ensureDirs();
  try {
    await seedDatabase();
  } catch (seedErr) {
    logger.error({ err: seedErr }, "Database seed failed");
  }

  try {
    await startProcastScheduler();
  } catch (schedErr) {
    logger.error({ err: schedErr }, "Failed to start Procast scheduler");
  }

  logger.info({ port }, "Server listening");
});
