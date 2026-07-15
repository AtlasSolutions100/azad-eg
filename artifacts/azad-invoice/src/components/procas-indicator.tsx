import { useEffect, useState } from "react";
import {
  useGetProcasStatus,
  useConnectProcas,
  useDisconnectProcas,
  useGetProcasScheduler,
  useUpdateProcasScheduler,
  useRefreshProcasNow,
  useGetProcasSchedulerRuns,
  getGetProcasStatusQueryKey,
  getGetProcasSchedulerQueryKey,
  getGetProcasSchedulerRunsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  RefreshCw,
  Wifi,
  WifiOff,
  Plug,
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

export default function ProcasIndicator() {
  const { data: status, isLoading } = useGetProcasStatus();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const connectProcas = useConnectProcas();
  const disconnectProcas = useDisconnectProcas();

  const connected = status?.connected ?? false;

  const { data: scheduler } = useGetProcasScheduler({
    query: {
      // Only meaningful once a live connection exists; poll while connected so
      // the "last cycle" panel stays fresh.
      queryKey: getGetProcasSchedulerQueryKey(),
      enabled: connected,
      refetchInterval: connected ? 30_000 : false,
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
      enabled: connected && historyOpen,
      refetchInterval: connected && historyOpen ? 30_000 : false,
    },
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [companyCode, setCompanyCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState("");

  const schedulerMinutes = scheduler ? Math.round(scheduler.intervalMs / 60000) : null;

  // Keep the editable interval field in sync with the server value when not
  // actively being changed.
  useEffect(() => {
    if (schedulerMinutes != null) setIntervalMinutes(String(schedulerMinutes));
  }, [schedulerMinutes]);

  const lastSync = status?.lastSyncAt ? new Date(status.lastSyncAt) : null;

  const headline = connected ? "Live Pull Active" : "Upload Mode";
  const detail = connected
    ? lastSync
      ? `Last synced ${formatDistanceToNow(lastSync, { addSuffix: true })}`
      : "Connected to the Procas Web API"
    : "Not connected to the Procas Web API";

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
          ? "Procas is not connected, so no invoices were refreshed."
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

  const handleConnect = async () => {
    if (!companyCode.trim() || !username.trim() || !password) return;
    try {
      await connectProcas.mutateAsync({
        data: { companyCode: companyCode.trim(), username: username.trim(), password },
      });
      await refreshStatus();
      setDialogOpen(false);
      setPassword("");
      toast({
        title: "Procas connected",
        description: "Invoicing data can now be pulled live from Procas (daily 6 AM snapshot).",
      });
    } catch (e) {
      toast({
        title: "Connection failed",
        description: e instanceof Error ? e.message : "Could not connect to Procas.",
        variant: "destructive",
      });
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectProcas.mutateAsync();
      await refreshStatus();
      toast({
        title: "Procas disconnected",
        description: "Reverted to Upload Mode. Import timesheet files manually.",
      });
    } catch (e) {
      toast({
        title: "Disconnect failed",
        description: e instanceof Error ? e.message : "Could not disconnect from Procas.",
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              connected
                ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                : "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
            } ${isLoading ? "opacity-60" : ""}`}
            aria-label="Procas connection status"
          >
            <span className="relative flex h-2 w-2">
              <span
                className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${
                  connected ? "animate-ping bg-emerald-400" : "bg-amber-400"
                }`}
              />
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${
                  connected ? "bg-emerald-500" : "bg-amber-500"
                }`}
              />
            </span>
            <span className="hidden sm:inline">{headline}</span>
            {connected ? (
              <Wifi className="h-3.5 w-3.5" />
            ) : (
              <WifiOff className="h-3.5 w-3.5" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80" align="end">
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span
                className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full ${
                  connected
                    ? "bg-emerald-100 text-emerald-600"
                    : "bg-amber-100 text-amber-600"
                }`}
              >
                {connected ? (
                  <Wifi className="h-4 w-4" />
                ) : (
                  <WifiOff className="h-4 w-4" />
                )}
              </span>
              <div>
                <p className="text-sm font-semibold text-[#333333]">{headline}</p>
                <p className="text-xs text-[#5F5F5F]">{detail}</p>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-[#5F5F5F]">
              {status?.message ||
                (connected
                  ? "Timesheet data is being pulled directly from Procas."
                  : "Procas is not connected. Upload timesheet files manually to build packages.")}
            </p>
            {connected ? (
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
                                    Skipped (not connected)
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

                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={disconnectProcas.isPending}
                  onClick={handleDisconnect}
                >
                  <Plug className="mr-2 h-4 w-4" />
                  {disconnectProcas.isPending ? "Disconnecting..." : "Disconnect Procas"}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                className="w-full bg-[#CFAF42] text-white hover:bg-[#bd9e36]"
                onClick={() => setDialogOpen(true)}
              >
                <RefreshCw className="mr-2 h-4 w-4" /> Connect to Procas API
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connect to Procas</DialogTitle>
            <DialogDescription>
              Enter your Procas company code and your PROCAS username and password. We'll verify
              the connection before saving. Data comes from a copy refreshed daily at 6 AM Eastern.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="procas-company-code">Company Code</Label>
              <Input
                id="procas-company-code"
                placeholder="e.g. AZAD (case-sensitive)"
                value={companyCode}
                onChange={(e) => setCompanyCode(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="procas-username">PROCAS Username</Label>
              <Input
                id="procas-username"
                autoComplete="off"
                placeholder="Your PROCAS username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="procas-password">PROCAS Password</Label>
              <Input
                id="procas-password"
                type="password"
                autoComplete="new-password"
                placeholder="Your PROCAS password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-[#CFAF42] text-white hover:bg-[#bd9e36]"
              disabled={!companyCode.trim() || !username.trim() || !password || connectProcas.isPending}
              onClick={handleConnect}
            >
              {connectProcas.isPending ? "Connecting..." : "Connect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
