import { Router, type IRouter } from "express";
import { GetProcastStatusResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// Procast remains the source of truth and is integrated via file upload in
// Phase 1. A direct API connection can replace this stub later without any
// frontend change.
router.get("/procast/status", async (_req, res): Promise<void> => {
  res.json(
    GetProcastStatusResponse.parse({
      connected: true,
      mode: "upload",
      lastSyncAt: null,
      message: "Procast data is imported via CSV/Excel upload.",
    }),
  );
});

export default router;
