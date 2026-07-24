import { useEffect, useState } from "react";
import {
  useGetProcasStatus,
  useGetProcasScheduler,
  useUpdateProcasScheduler,
  useRefreshProcasNow,
  useGetProcasSchedulerRuns,
  useConnectProcas,
  getGetProcasStatusQueryKey,
  getGetProcasSchedulerQueryKey,
  getGetProcasSchedulerRunsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  RefreshCw,
  Wifi,
  WifiOff,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Settings2,
  History,
  ChevronDown,
  ChevronUp,
  MinusCircle,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";

// Header status light for the Procas connection. The connection itself is
// managed server-side with stored credentials — there is no sign-in flow here;
// the light just reports whether Procas is running and when it last synced.
export default function ProcasIndicator() {
  const { data: status, isLoading } = useGetProcasStatus();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const connected = status?.connected ?? false;
  // A stored credential exists but can no longer be decrypted (e.g. after an
  // encryption key rotation) — the live connection is broken until the stored
  // credential is fixed server-side.
  const credentialUnreadable = status?.credentialUnreadable ?? false;
  const running = connected && !credentialUnreadable;

  const { data: scheduler } = useGetProcasScheduler({
    query: {
      // Only meaningful once a live connection exists; poll while connected so
      // the "last cycle" panel stays fresh.
      queryKey: getGetProcasSchedulerQueryKey(),
      enabled: running,
      refetchInterval: running ? 30_000 : false,
    },
  });
  const updateScheduler = useUpdateProcasScheduler();
  const refreshNow = useRefreshProcasNow();

  const [historyOpen, setHistoryOpen] = useState(false);
  const { data: runs } = useGetProcasSchedulerRuns({
    query: {
      queryKey: getGetProcasSchedulerRunsQueryKey(),
      // Only fetch once the biller expands the history panel; keep it fresh
      // while it's open on the same cadence as the scheduler status.
      enabled: running && historyOpen,
      refetchInterval: running && historyOpen ? 30_000 : false,
    },
  });

  const [intervalMinutes, setIntervalMinutes] = useState("");
  const schedulerMinutes = scheduler ? Math.round(scheduler.intervalMs / 60000) : null;

  // Keep the editable interval field in sync with the server value when not
  // actively being changed.
  useEffect(() => {
    if (schedulerMinutes != null) setIntervalMinutes(String(schedulerMinutes));
  }, [schedulerMinutes]);

  const lastSync = status?.lastSyncAt ? new Date(status.lastSyncAt) : null;

  // Repeated scheduler skips (or unsaved refresh results) mean invoice data may
  // be quietly going stale — surface it on the header pill so billers notice
  // without having to open the popover.
  const staleWarning = running && !!(scheduler?.skipWarning || scheduler?.resultsStale);

  const detail = credentialUnreadable
    ? "Procas is not running — the stored credential can no longer be read"
    : running
      ? lastSync
        ? `Running — last synced ${formatDistanceToNow(lastSync, { addSuffix: true })}`
        : "Running — connected to the Procas Web API"
      : "Procas is not running right now";

  const refreshStatus = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetProcasStatusQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetProcasSchedulerQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetProcasSchedulerRunsQueryKey() }),
    ]);

  const handleRefreshNow = async () => {
    try {
      const result = await refreshNow.mutateAsync();
      await refreshStatus();
      toast({
        title: result.lastSkipped ? "Nothing to refresh" : "Refresh complete",
        description: result.lastSkipped
          ? "Procas is not running, so no invoices were refreshed."
          : `${result.lastSynced} invoice(s) synced${
              result.lastFailed ? `, ${result.lastFailed} failed` : ""
            }.`,
        variant: result.lastFailed ? "destructive" : undefined,
      });
    } catch (e) {
      toast({
        title: "Refresh failed",
        description: e instanceof Error ? e.message : "Could not refresh invoices.",
        variant: "destructive",
      });
    }
  };

  // Reconnect form — lets a biller re-enter Procas credentials directly if
  // the stored connection is ever lost, instead of needing an engineer.
  const connectProcas = useConnectProcas();
  const [connectOpen, setConnectOpen] = useState(false);
  const [companyCode, setCompanyCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyCode.trim() || !username.trim() || !password) return;
    try {
      await connectProcas.mutateAsync({
        data: { companyCode: companyCode.trim(), username: username.trim(), password },
      });
      await refreshStatus();
      setConnectOpen(false);
      setPassword("");
      toast({
        title: "Procas connected",
        description: "Credentials verified — live data is flowing again.",
      });
    } catch (err) {
      toast({
        title: "Could not connect",
        description:
          err instanceof Error
            ? err.message
            : "Procas rejected the credentials. Double-check the company code, username, and password.",
        variant: "destructive",
      });
    }
  };

  const handleSaveInterval = async () => {
    const minutes = Number(intervalMinutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      toast({
        title: "Invalid interval",
        description: "Enter a refresh interval between 1 minute and 1440 minutes (24 hours).",
        variant: "destructive",
      });
      return;
    }
    if (schedulerMinutes != null && minutes === schedulerMinutes) return;
    try {
      await updateScheduler.mutateAsync({ data: { intervalMs: Math.round(minutes) * 60000 } });
      await refreshStatus();
      toast({
        title: "Schedule updated",
        description: `Open invoices will now refresh every ${Math.round(minutes)} minute(s).`,
      });
    } catch (e) {
      toast({
        title: "Could not update schedule",
        description: e instanceof Error ? e.message : "Failed to save the refresh interval.",
        variant: "destructive",
      });
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
            !running
              ? "border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
              : staleWarning
                ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
                : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
          } ${isLoading ? "opacity-60" : ""}`}
          aria-label={
            staleWarning
              ? "Procas status — invoice data may be getting stale"
              : "Procas status"
          }
          title={
            staleWarning
              ? "Automatic refreshes are being skipped — invoice data may be getting stale. Click for details."
              : detail
          }
          data-testid="procas-indicator-pill"
        >
          <span className="relative flex h-2 w-2">
            <span
              className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${
                !running
                  ? "animate-ping bg-red-400"
                  : staleWarning
                    ? "animate-ping bg-amber-400"
                    : "animate-ping bg-emerald-400"
              }`}
            />
            <span
              className={`relative inline-flex h-2 w-2 rounded-full ${
                !running ? "bg-red-500" : staleWarning ? "bg-amber-500" : "bg-emerald-500"
              }`}
            />
          </span>
          <span className="hidden sm:inline">Procas</span>
          {!running ? (
            <WifiOff className="h-3.5 w-3.5" />
          ) : staleWarning ? (
            <AlertTriangle
              className="h-3.5 w-3.5 text-amber-600"
              data-testid="procas-stale-badge"
            />
          ) : (
            <Wifi className="h-3.5 w-3.5" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <span
              className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full ${
                !running ? "bg-red-100 text-red-600" : "bg-emerald-100 text-emerald-600"
              }`}
            >
              {!running ? <WifiOff className="h-4 w-4" /> : <Wifi className="h-4 w-4" />}
            </span>
            <div>
              <p className="text-sm font-semibold text-[#333333]">Procas</p>
              <p className="text-xs text-[#5F5F5F]">{detail}</p>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-[#5F5F5F]">
            {running
              ? "Timesheet and billing data is being pulled directly from Procas."
              : credentialUnreadable
                ? "The saved Procas credential can't be read anymore, so live pulls and automatic refreshes have stopped. Contact your administrator to restore the connection."
                : "Procas is not running right now. Live pulls and automatic refreshes are paused until the connection is restored."}
          </p>
          {!running && (
            <div className="space-y-2">
              {!connectOpen ? (
                <Button
                  size="sm"
                  className="w-full bg-[#CFAF42] text-white hover:bg-[#CFAF42]/90"
                  onClick={() => setConnectOpen(true)}
                  data-testid="procas-connect-open"
                >
                  Connect to Procas
                </Button>
              ) : (
                <form onSubmit={handleConnect} className="space-y-2 rounded-md border border-[#EDE6CF] bg-[#FBF8EF] p-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Company code</Label>
                    <Input
                      value={companyCode}
                      onChange={(e) => setCompanyCode(e.target.value)}
                      placeholder="e.g. AZADEN"
                      autoComplete="off"
                      data-testid="procas-connect-company"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Username</Label>
                    <Input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="you@company.com"
                      autoComplete="off"
                      data-testid="procas-connect-username"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Password</Label>
                    <Input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="new-password"
                      data-testid="procas-connect-password"
                    />
                  </div>
                  <p className="text-[11px] leading-relaxed text-[#8A8A8A]">
                    Credentials are verified against the Procas data feed before being
                    saved, and are stored encrypted.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      size="sm"
                      className="flex-1 bg-[#CFAF42] text-white hover:bg-[#CFAF42]/90"
                      disabled={
                        connectProcas.isPending ||
                        !companyCode.trim() ||
                        !username.trim() ||
                        !password
                      }
                      data-testid="procas-connect-submit"
                    >
                      {connectProcas.isPending ? "Connecting…" : "Connect"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setConnectOpen(false)}
                      disabled={connectProcas.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </div>
          )}
          {running && (
            <div className="space-y-3">
              {status?.companyCode && (
                <p className="truncate text-xs text-[#5F5F5F]">
                  <span className="font-medium text-[#333333]">Company code:</span>{" "}
                  {status.companyCode}
                </p>
              )}
              <p className="text-[11px] leading-relaxed text-[#8A8A8A]">
                Procas serves a copy of your data refreshed daily at 6 AM Eastern, so today's
                entries appear tomorrow morning.
              </p>

              <div className="space-y-2 rounded-md border border-[#EDE6CF] bg-[#FBF8EF] p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-[#333333]">
                  <RefreshCw className="h-3.5 w-3.5 text-[#CFAF42]" />
                  Automatic refresh
                </div>

                <p className="flex items-center gap-1.5 text-xs text-[#5F5F5F]">
                  <Clock className="h-3.5 w-3.5" />
                  {schedulerMinutes != null
                    ? `Every ${schedulerMinutes} minute${schedulerMinutes === 1 ? "" : "s"}`
                    : "Loading schedule…"}
                </p>

                {scheduler?.skipWarning && (
                  <div className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    <span>
                      The last {scheduler.consecutiveSkips} automatic refreshes were skipped
                      {scheduler.lastSkipReason === "db_busy"
                        ? " because the database was too busy"
                        : scheduler.lastSkipReason === "lock_held"
                          ? " because another server was already refreshing"
                          : ""}
                      . Invoice data may be getting stale.
                    </span>
                  </div>
                )}

                {scheduler?.resultsStale && (
                  <div className="flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    <span>
                      {scheduler.staleReason === "last_run_age"
                        ? "The last saved refresh is much older than the schedule expects — the status below may be out of date. Refreshes may be failing or their results aren't being saved."
                        : `Refresh results haven't been saved for the last ${scheduler.persistFailures} runs — the status below may be out of date. The database may be having trouble.`}
                    </span>
                  </div>
                )}

                {scheduler && (
                  <div className="text-xs text-[#5F5F5F]">
                    {scheduler.lastRunAt ? (
                      scheduler.lastSkipped ? (
                        <span className="flex items-center gap-1.5 text-amber-600">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          Last cycle skipped (not connected)
                        </span>
                      ) : scheduler.lastError ? (
                        <span className="flex items-start gap-1.5 text-red-600">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                          <span>Last cycle errored: {scheduler.lastError}</span>
                        </span>
                      ) : (
                        <span
                          className={`flex items-center gap-1.5 ${
                            scheduler.lastFailed ? "text-amber-600" : "text-emerald-600"
                          }`}
                        >
                          {scheduler.lastFailed ? (
                            <AlertTriangle className="h-3.5 w-3.5" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          )}
                          {scheduler.lastSynced} synced
                          {scheduler.lastFailed ? `, ${scheduler.lastFailed} failed` : ""}
                        </span>
                      )
                    ) : (
                      <span className="italic">No automatic cycle has run yet.</span>
                    )}
                    {scheduler.lastRunAt && (
                      <p className="mt-0.5 text-[11px] text-[#8A8A8A]">
                        {formatDistanceToNow(new Date(scheduler.lastRunAt), { addSuffix: true })}
                      </p>
                    )}
                  </div>
                )}

                <Button
                  size="sm"
                  className="w-full bg-[#CFAF42] text-white hover:bg-[#bd9e36]"
                  disabled={refreshNow.isPending}
                  onClick={handleRefreshNow}
                >
                  <RefreshCw
                    className={`mr-2 h-4 w-4 ${refreshNow.isPending ? "animate-spin" : ""}`}
                  />
                  {refreshNow.isPending ? "Refreshing…" : "Refresh all open invoices now"}
                </Button>

                <div className="border-t border-[#EDE6CF] pt-2">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between text-xs text-[#5F5F5F] hover:text-[#333333]"
                    onClick={() => setHistoryOpen((open) => !open)}
                    aria-expanded={historyOpen}
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      <History className="h-3.5 w-3.5" />
                      Recent refresh history
                    </span>
                    {historyOpen ? (
                      <ChevronUp className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                  </button>
                  {historyOpen && (
                    <div className="mt-2 max-h-48 space-y-1 overflow-y-auto pr-1">
                      {runs == null ? (
                        <p className="text-[11px] italic text-[#8A8A8A]">Loading history…</p>
                      ) : runs.length === 0 ? (
                        <p className="text-[11px] italic text-[#8A8A8A]">
                          No refresh cycles have completed yet.
                        </p>
                      ) : (
                        runs.map((run) => (
                          <div
                            key={run.id}
                            className="flex items-start justify-between gap-2 rounded border border-[#EDE6CF] bg-white px-2 py-1.5"
                          >
                            <div className="min-w-0">
                              {run.skipped ? (
                                <span className="flex items-center gap-1 text-[11px] text-amber-600">
                                  <MinusCircle className="h-3 w-3 flex-shrink-0" />
                                  {(run.skipCount ?? 1) > 1
                                    ? `Skipped ${run.skipCount} times — ${
                                        run.skipReason === "db_busy"
                                          ? "database busy"
                                          : run.skipReason === "lock_held"
                                            ? "another server was refreshing"
                                            : "not connected"
                                      }`
                                    : run.skipReason === "db_busy"
                                      ? "Skipped — database busy"
                                      : run.skipReason === "lock_held"
                                        ? "Skipped — another server was refreshing"
                                        : "Skipped (not connected)"}
                                </span>
                              ) : run.error ? (
                                <span
                                  className="flex items-start gap-1 text-[11px] text-red-600"
                                  title={run.error}
                                >
                                  <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                                  <span className="truncate">Errored: {run.error}</span>
                                </span>
                              ) : (
                                <span
                                  className={`flex items-center gap-1 text-[11px] ${
                                    run.failed ? "text-amber-600" : "text-emerald-600"
                                  }`}
                                >
                                  {run.failed ? (
                                    <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                                  ) : (
                                    <CheckCircle2 className="h-3 w-3 flex-shrink-0" />
                                  )}
                                  {run.synced} synced
                                  {run.failed ? `, ${run.failed} failed` : ""}
                                </span>
                              )}
                            </div>
                            <span className="flex-shrink-0 whitespace-nowrap text-[10px] text-[#8A8A8A]">
                              {formatDistanceToNow(new Date(run.ranAt), { addSuffix: true })}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>

                <div className="space-y-1.5 border-t border-[#EDE6CF] pt-2">
                  <Label
                    htmlFor="procas-interval"
                    className="flex items-center gap-1.5 text-xs text-[#5F5F5F]"
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                    Refresh interval (minutes)
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="procas-interval"
                      type="number"
                      min={1}
                      max={1440}
                      className="h-8 text-xs"
                      value={intervalMinutes}
                      onChange={(e) => setIntervalMinutes(e.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 flex-shrink-0"
                      disabled={
                        updateScheduler.isPending ||
                        intervalMinutes === "" ||
                        (schedulerMinutes != null && Number(intervalMinutes) === schedulerMinutes)
                      }
                      onClick={handleSaveInterval}
                    >
                      {updateScheduler.isPending ? "Saving…" : "Save"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
