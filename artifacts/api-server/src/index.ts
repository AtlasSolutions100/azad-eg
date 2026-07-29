import app from "./app";
import { logger } from "./lib/logger";
import { ensureDirs } from "./lib/paths";
import { seedDatabase } from "./lib/seed";
import { startProcasScheduler } from "./lib/procasScheduler";
import { reencryptProcasConnectionIfNeeded, autoConnectProcasFromEnv } from "./lib/procas";
import { backfillTimesheetEmployeeIds } from "./lib/employeeResolve";
import { pruneGeneratedFiles } from "./lib/generatedCleanup";

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
    // If the connection was ever lost (fresh database, disconnect, unreadable
    // credential), silently restore it from the PROCAS_USERNAME /
    // PROCAS_PASSWORD secrets so live data keeps flowing without manual help.
    if (await autoConnectProcasFromEnv()) {
      logger.info("Procas connection restored automatically from stored secrets");
    }
  } catch (reconnectErr) {
    logger.error({ err: reconnectErr }, "Procas auto-reconnect from secrets failed");
  }

  try {
    // Legacy timesheet rows created before employee IDs were stored are
    // linked by name here; ambiguous names are left alone.
    const backfilled = await backfillTimesheetEmployeeIds();
    if (backfilled > 0) {
      logger.info({ backfilled }, "Backfilled employeeId on legacy timesheet entries");
    }
  } catch (backfillErr) {
    logger.error({ err: backfillErr }, "Timesheet employeeId backfill failed");
  }

  try {
    // Sweep old generated export files (legacy ZIPs, stale intermediates) so
    // storage does not grow forever.
    pruneGeneratedFiles();
  } catch (pruneErr) {
    logger.error({ err: pruneErr }, "Failed to prune generated export files");
  }

  // Re-run the sweep daily so stale files are trimmed even if the server
  // runs for weeks without a restart or an export. Best-effort: failures
  // are logged and never crash the server.
  const pruneTimer = setInterval(() => {
    try {
      pruneGeneratedFiles();
    } catch (pruneErr) {
      logger.error({ err: pruneErr }, "Periodic generated-file prune failed");
    }
  }, 24 * 60 * 60 * 1000);
  pruneTimer.unref();

  try {
    await startProcasScheduler();
  } catch (schedErr) {
    logger.error({ err: schedErr }, "Failed to start Procas scheduler");
  }

  logger.info({ port }, "Server listening");
});
