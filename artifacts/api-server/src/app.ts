import { DB_PUSH_COMMAND, describeDrift, knownSchemaDrift } from "./lib/schemaDrift";
import express, { type Express } from "express";
import type { ErrorRequestHandler } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

/**
 * Last-resort error handler for the API. Without one, anything a route
 * throws reaches Express's default handler, which answers with an HTML page
 * — and the browser shows the biller "HTTP 500 <!DOCTYPE html> <html
 * lang=…" as the reason she could not create a package. Every API error is
 * JSON, and the one failure with a known remedy — the database missing a
 * column the code expects, because the deploy's `db push` step was skipped —
 * is spelled out with the command that fixes it.
 */
export const apiErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const pgCode = postgresErrorCode(err);
  req.log?.error({ err, pgCode }, "Unhandled API error");
  if (res.headersSent) return;
  if (pgCode === "42703" || pgCode === "42P01") {
    const drift = knownSchemaDrift();
    res.status(500).json({
      error:
        drift.length > 0
          ? describeDrift(drift)
          : `The database is missing a column or table the code expects. The schema step of the ` +
            `deploy was skipped — on the deployment run \`${DB_PUSH_COMMAND}\`, then restart the server.`,
      code: "schema_out_of_date",
    });
    return;
  }
  res.status(500).json({ error: "Internal server error" });
};
app.use(apiErrorHandler);

/** Postgres SQLSTATE from an error, walking the cause chain drizzle wraps it in. */
function postgresErrorCode(err: unknown): string | null {
  for (let cur = err; cur instanceof Error; cur = cur.cause) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

export default app;
