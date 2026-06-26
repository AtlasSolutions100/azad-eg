import { useState } from "react";
import {
  useGetProcastStatus,
  useConnectProcast,
  useDisconnectProcast,
  getGetProcastStatusQueryKey,
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
import { RefreshCw, Wifi, WifiOff, Plug } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";

export default function ProcastIndicator() {
  const { data: status, isLoading } = useGetProcastStatus();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const connectProcast = useConnectProcast();
  const disconnectProcast = useDisconnectProcast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  const connected = status?.connected ?? false;
  const lastSync = status?.lastSyncAt ? new Date(status.lastSyncAt) : null;

  const headline = connected ? "Live Pull Active" : "Upload Mode";
  const detail = connected
    ? lastSync
      ? `Last synced ${formatDistanceToNow(lastSync, { addSuffix: true })}`
      : "Connected to Procast API"
    : "Not connected to Procast API";

  const refreshStatus = () =>
    queryClient.invalidateQueries({ queryKey: getGetProcastStatusQueryKey() });

  const handleConnect = async () => {
    if (!baseUrl.trim() || !apiKey.trim()) return;
    try {
      await connectProcast.mutateAsync({ data: { baseUrl: baseUrl.trim(), apiKey: apiKey.trim() } });
      await refreshStatus();
      setDialogOpen(false);
      setApiKey("");
      toast({
        title: "Procast connected",
        description: "Timesheets can now be pulled live from Procast.",
      });
    } catch (e) {
      toast({
        title: "Connection failed",
        description: e instanceof Error ? e.message : "Could not connect to Procast.",
        variant: "destructive",
      });
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectProcast.mutateAsync();
      await refreshStatus();
      toast({
        title: "Procast disconnected",
        description: "Reverted to Upload Mode. Import timesheet files manually.",
      });
    } catch (e) {
      toast({
        title: "Disconnect failed",
        description: e instanceof Error ? e.message : "Could not disconnect from Procast.",
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
            aria-label="Procast connection status"
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
                  ? "Timesheet data is being pulled directly from Procast."
                  : "Procast is not connected. Upload timesheet files manually to build packages.")}
            </p>
            {connected ? (
              <div className="space-y-2">
                {status?.baseUrl && (
                  <p className="truncate text-xs text-[#5F5F5F]">
                    <span className="font-medium text-[#333333]">Endpoint:</span> {status.baseUrl}
                  </p>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={disconnectProcast.isPending}
                  onClick={handleDisconnect}
                >
                  <Plug className="mr-2 h-4 w-4" />
                  {disconnectProcast.isPending ? "Disconnecting..." : "Disconnect Procast"}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                className="w-full bg-[#CFAF42] text-white hover:bg-[#bd9e36]"
                onClick={() => setDialogOpen(true)}
              >
                <RefreshCw className="mr-2 h-4 w-4" /> Connect to Procast API
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connect to Procast</DialogTitle>
            <DialogDescription>
              Enter your Procast API endpoint and key. We'll verify the connection before saving so
              timesheets can be pulled automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="procast-base-url">API Base URL</Label>
              <Input
                id="procast-base-url"
                placeholder="https://api.procast.example.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="procast-api-key">API Key</Label>
              <Input
                id="procast-api-key"
                type="password"
                placeholder="Your Procast API key"
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
              disabled={!baseUrl.trim() || !apiKey.trim() || connectProcast.isPending}
              onClick={handleConnect}
            >
              {connectProcast.isPending ? "Connecting..." : "Connect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
