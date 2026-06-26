import { Router, type IRouter } from "express";
import {
  GetProcastStatusResponse,
  ConnectProcastBody,
  ConnectProcastResponse,
  DisconnectProcastResponse,
} from "@workspace/api-zod";
import {
  getProcastConnection,
  saveProcastConnection,
  pingProcast,
} from "../lib/procast";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

function statusPayload(conn: Awaited<ReturnType<typeof getProcastConnection>>) {
  const connected = !!conn?.connected;
  return {
    connected,
    mode: connected ? ("live" as const) : ("upload" as const),
    baseUrl: conn?.baseUrl ?? null,
    lastSyncAt: conn?.lastSyncAt ? conn.lastSyncAt.toISOString() : null,
    message: connected
      ? "Timesheet data is pulled live from the Procast API."
      : "Procast is not connected. Import timesheet data via CSV/Excel upload.",
  };
}

// Returns the real, persisted Procast connection state. Falls back to upload
// mode whenever no live connection has been established.
router.get("/procast/status", async (_req, res): Promise<void> => {
  const conn = await getProcastConnection();
  res.json(GetProcastStatusResponse.parse(statusPayload(conn)));
});

// Starts the real Procast connection flow: validates the supplied credentials by
// making an authenticated probe request, and persists them only on success.
router.post("/procast/connect", async (req, res): Promise<void> => {
  const parsed = ConnectProcastBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { baseUrl, apiKey } = parsed.data;

  const ping = await pingProcast({ baseUrl, apiKey });
  if (!ping.ok) {
    res.status(502).json({ error: ping.error ?? "Could not connect to Procast." });
    return;
  }

  const conn = await saveProcastConnection({
    connected: true,
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
    apiKey,
    lastSyncAt: null,
  });
  await recordAudit({
    action: "connected Procast",
    entityType: "integration",
    description: `Live Procast connection established (${conn.baseUrl})`,
  });
  res.json(ConnectProcastResponse.parse(statusPayload(conn)));
});

// Tears down the live connection and returns to upload mode.
router.post("/procast/disconnect", async (_req, res): Promise<void> => {
  const conn = await saveProcastConnection({
    connected: false,
    baseUrl: null,
    apiKey: null,
    lastSyncAt: null,
  });
  await recordAudit({
    action: "disconnected Procast",
    entityType: "integration",
    description: "Live Procast connection removed; reverted to upload mode",
  });
  res.json(DisconnectProcastResponse.parse(statusPayload(conn)));
});

export default router;
