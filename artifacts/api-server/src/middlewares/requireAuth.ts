import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { auditContext } from "../lib/auditContext";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const auth = getAuth(req);
  const userId =
    (auth?.sessionClaims?.userId as string | undefined) || auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = userId;
  // Best-effort human-readable name from session claims, else the user id.
  const claims = auth?.sessionClaims as Record<string, unknown> | undefined;
  const userName =
    (typeof claims?.name === "string" && claims.name) ||
    [claims?.firstName, claims?.lastName].filter((s) => typeof s === "string" && s).join(" ").trim() ||
    (typeof claims?.email === "string" && claims.email) ||
    userId;
  auditContext.run({ userId, userName: userName as string }, () => next());
}
