import app from "./app";
import { logger } from "./lib/logger";
import { ensureDirs } from "./lib/paths";
import { seedDatabase } from "./lib/seed";
import { startProcasScheduler } from "./lib/procasScheduler";
import { reencryptProcasConnectionIfNeeded } from "./lib/procas";

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
    // Re-seals the stored Procas credential under the current master key when
    // PROCAS_ENC_KEY was rotated (previous key kept in PROCAS_ENC_KEY_OLD).
    if (await reencryptProcasConnectionIfNeeded()) {
      logger.info("Re-encrypted stored Procas credential under the current master key");
    }
  } catch (rotateErr) {
    logger.error({ err: rotateErr }, "Failed to re-encrypt stored Procas credential");
  }

  try {
    await startProcasScheduler();
  } catch (schedErr) {
    logger.error({ err: schedErr }, "Failed to start Procas scheduler");
  }

  logger.info({ port }, "Server listening");
});
