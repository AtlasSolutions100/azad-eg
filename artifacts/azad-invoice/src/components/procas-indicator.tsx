import { useEffect, useState } from "react";
import {
  useGetProcasStatus,
  useConnectProcas,
  useDisconnectProcas,
  useGetProcasScheduler,
  useUpdateProcasScheduler,
  useRefreshProcasNow,
  getGetProcasStatusQueryKey,
  getGetProcasSchedulerQueryKey,
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
import { RefreshCw, Wifi, WifiOff, Plug, Clock, CheckCircle2, AlertTriangle, Settings2 } from "lucide-react";
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

  const [dialogOpen, setDialogOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
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
      : "Connected to Procas API"
    : "Not connected to Procas API";

  const refreshStatus = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetProcasStatusQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetProcasSchedulerQueryKey() }),
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
    if (!baseUrl.trim() || !apiKey.trim()) return;
    try {
      await connectProcas.mutateAsync({ data: { baseUrl: baseUrl.trim(), apiKey: apiKey.trim() } });
      await refreshStatus();
      setDialogOpen(false);
      setApiKey("");
      toast({
        title: "Procas connected",
        description: "Timesheets can now be pulled live from Procas.",
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
                {status?.baseUrl && (
                  <p className="truncate text-xs text-[#5F5F5F]">
                    <span className="font-medium text-[#333333]">Endpoint:</span> {status.baseUrl}
                  </p>
                )}

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
              Enter your Procas API endpoint and key. We'll verify the connection before saving so
              timesheets can be pulled automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="procas-base-url">API Base URL</Label>
              <Input
                id="procas-base-url"
                placeholder="https://api.procas.example.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="procas-api-key">API Key</Label>
              <Input
                id="procas-api-key"
                type="password"
                placeholder="Your Procas API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-[#CFAF42] text-white hover:bg-[#bd9e36]"
              disabled={!baseUrl.trim() || !apiKey.trim() || connectProcas.isPending}
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
