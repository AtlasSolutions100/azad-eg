import { useGetProcastStatus } from "@workspace/api-client-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { RefreshCw, Wifi, WifiOff } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";

export default function ProcastIndicator() {
  const { data: status, isLoading } = useGetProcastStatus();
  const { toast } = useToast();

  const connected = status?.connected ?? false;
  const lastSync = status?.lastSyncAt ? new Date(status.lastSyncAt) : null;

  const headline = connected
    ? "Live Pull Active"
    : "Upload Mode";
  const detail = connected
    ? lastSync
      ? `Last synced ${formatDistanceToNow(lastSync, { addSuffix: true })}`
      : "Connected to Procast API"
    : "Not connected to Procast API";

  return (
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
          {!connected && (
            <Button
              size="sm"
              className="w-full bg-[#CFAF42] text-white hover:bg-[#bd9e36]"
              onClick={() =>
                toast({
                  title: "Procast integration coming soon",
                  description:
                    "Live Procast API connection isn't available yet. Continue in Upload Mode for now.",
                })
              }
            >
              <RefreshCw className="mr-2 h-4 w-4" /> Connect to Procast API
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
