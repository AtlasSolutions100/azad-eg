import { describe, it, expect, beforeEach, vi } from "vitest";

// The scheduler module imports `@workspace/db`, whose index throws at import
// time unless DATABASE_URL is set. These tests exercise only the in-memory
// batching logic of runProcasSyncCycle (which open invoices get auto-synced vs
// skipped), so we mock the database, the Procas connection, and the per-invoice
// sync entirely — no real Postgres is touched.

type FakeInvoice = { id: number; status: string; invoiceNumber: string | null };

// vi.mock factories are hoisted above the imports, so everything they reference
// must be created inside vi.hoisted (which runs first).
const h = vi.hoisted(() => ({
  state: {
    invoices: [] as FakeInvoice[],
    connected: true,
  },
  getProcasConnection: vi.fn(),
  credsFromConnection: vi.fn(),
  autoConnectProcasFromEnv: vi.fn(),
  syncInvoiceFromProcas: vi.fn(),
  syncReferenceFromProcas: vi.fn(),
  importWorkPlansFromProcas: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(h.state.invoices),
      }),
    }),
  },
  pool: {},
  invoicesTable: { status: { name: "status" } },
  procasSchedulerTable: {},
  procasSchedulerRunsTable: {},
}));

vi.mock("./procas", () => ({
  getProcasConnection: h.getProcasConnection,
  credsFromConnection: h.credsFromConnection,
  autoConnectProcasFromEnv: h.autoConnectProcasFromEnv,
}));

vi.mock("./procasSync", () => ({
  syncInvoiceFromProcas: h.syncInvoiceFromProcas,
  syncReferenceFromProcas: h.syncReferenceFromProcas,
  importWorkPlansFromProcas: h.importWorkPlansFromProcas,
}));

vi.mock("./logger", () => ({
  logger: {
    info: h.loggerInfo,
    warn: h.loggerWarn,
    error: h.loggerError,
    debug: h.loggerDebug,
  },
}));

// Imported after the mocks are registered.
import { runProcasSyncCycle } from "./procasScheduler";

describe("runProcasSyncCycle status gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.connected = true;
    h.state.invoices = [];
    h.getProcasConnection.mockImplementation(async () =>
      h.state.connected
        ? { connected: true, companyCode: "AZADEN", username: "u", password: "p" }
        : null,
    );
    h.credsFromConnection.mockImplementation((conn: unknown) =>
      conn ? { companyCode: "AZADEN", username: "u", password: "p" } : null,
    );
    h.autoConnectProcasFromEnv.mockResolvedValue(false);
    h.syncInvoiceFromProcas.mockResolvedValue({ ok: true });
    h.syncReferenceFromProcas.mockResolvedValue({});
    h.importWorkPlansFromProcas.mockResolvedValue({});
  });

  it("auto-syncs draft invoices but skips in_review ones (human-in-the-loop guard)", async () => {
    h.state.invoices = [
      { id: 1, status: "draft", invoiceNumber: "INV-1" },
      { id: 2, status: "in_review", invoiceNumber: "INV-2" },
      { id: 3, status: "draft", invoiceNumber: "INV-3" },
      { id: 4, status: "in_review", invoiceNumber: "INV-4" },
    ];

    const result = await runProcasSyncCycle();

    expect(result.skipped).toBe(false);
    // Only the two drafts were synced.
    expect(result.synced).toBe(2);
    expect(result.failed).toBe(0);
    expect(h.syncInvoiceFromProcas).toHaveBeenCalledTimes(2);

    const syncedIds = h.syncInvoiceFromProcas.mock.calls.map(
      (c) => (c[0] as FakeInvoice).id,
    );
    expect(syncedIds.sort()).toEqual([1, 3]);
    // The in_review invoices were never handed to the sync function.
    const syncedStatuses = h.syncInvoiceFromProcas.mock.calls.map(
      (c) => (c[0] as FakeInvoice).status,
    );
    expect(syncedStatuses).not.toContain("in_review");

    // The skip is logged per invoice so it is observable in the logs.
    const skipLogs = h.loggerInfo.mock.calls.filter(
      (c) => typeof c[1] === "string" && c[1].includes("under review"),
    );
    expect(skipLogs.length).toBe(2);
  });

  it("syncs everything when no invoice is under review", async () => {
    h.state.invoices = [
      { id: 10, status: "draft", invoiceNumber: "INV-10" },
      { id: 11, status: "draft", invoiceNumber: "INV-11" },
    ];

    const result = await runProcasSyncCycle();

    expect(result.synced).toBe(2);
    expect(h.syncInvoiceFromProcas).toHaveBeenCalledTimes(2);
  });

  it("does not sync in_review invoices even when they are the only open ones", async () => {
    h.state.invoices = [
      { id: 20, status: "in_review", invoiceNumber: "INV-20" },
      { id: 21, status: "in_review", invoiceNumber: "INV-21" },
    ];

    const result = await runProcasSyncCycle();

    expect(result.skipped).toBe(false);
    expect(result.synced).toBe(0);
    expect(h.syncInvoiceFromProcas).not.toHaveBeenCalled();
  });

  it("skips the whole cycle when Procas is not connected", async () => {
    h.state.connected = false;
    h.state.invoices = [{ id: 30, status: "draft", invoiceNumber: "INV-30" }];

    const result = await runProcasSyncCycle();

    expect(result.skipped).toBe(true);
    expect(h.syncInvoiceFromProcas).not.toHaveBeenCalled();
  });
});
