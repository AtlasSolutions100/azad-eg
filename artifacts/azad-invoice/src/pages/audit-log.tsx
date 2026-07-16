import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import type { DateRange } from "react-day-picker";
import { usePagedAuditLogs } from "@/hooks/use-paged-audit-logs";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";
import { AlertTriangle, CalendarIcon, ExternalLink, Loader2, Search, X } from "lucide-react";
import { endOfDay, format, startOfDay } from "date-fns";

const OVERRIDE_ACTION = "approved over budget";

function entityLink(entityType: string, entityId: number | null | undefined): string | null {
  if (entityId == null) return null;
  if (entityType === "invoice") return `/invoices/${entityId}`;
  if (entityType === "package") return `/packages/${entityId}`;
  return null;
}

export default function AuditLog() {
  const { logs, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage, totalCount } =
    usePagedAuditLogs();
  const [overridesOnly, setOverridesOnly] = useState(false);
  const loadMoreRef = useInfiniteScroll({
    hasMore: !!hasNextPage,
    isFetching: isFetchingNextPage,
    onLoadMore: fetchNextPage,
  });
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);

  const isOverride = (action: string) => action === OVERRIDE_ACTION;

  const overrideCount = logs?.filter((log) => isOverride(log.action)).length ?? 0;

  const visibleLogs = useMemo(() => {
    if (!logs) return logs;
    const query = search.trim().toLowerCase();
    const from = dateRange?.from ? startOfDay(dateRange.from) : null;
    const to = dateRange?.to
      ? endOfDay(dateRange.to)
      : dateRange?.from
        ? endOfDay(dateRange.from)
        : null;
    return logs.filter((log) => {
      if (overridesOnly && !isOverride(log.action)) return false;
      if (from || to) {
        const created = new Date(log.createdAt);
        if (from && created < from) return false;
        if (to && created > to) return false;
      }
      if (query) {
        const entity = `${log.entityType} ${log.entityId != null ? `#${log.entityId}` : ""}`;
        const haystack = [log.userName, log.action, entity, log.description]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [logs, overridesOnly, search, dateRange]);

  const hasFilters = search.trim() !== "" || dateRange?.from != null || overridesOnly;

  const tableContainerRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useWindowVirtualizer({
    count: visibleLogs?.length ?? 0,
    estimateSize: () => 53,
    overscan: 12,
    scrollMargin: tableContainerRef.current?.offsetTop ?? 0,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows.length
    ? Math.max(0, virtualRows[0].start - rowVirtualizer.options.scrollMargin)
    : 0;
  const paddingBottom = virtualRows.length
    ? Math.max(
        0,
        rowVirtualizer.getTotalSize() -
          (virtualRows[virtualRows.length - 1].end - rowVirtualizer.options.scrollMargin),
      )
    : 0;

  const dateLabel = dateRange?.from
    ? dateRange.to
      ? `${format(dateRange.from, "MMM d, yyyy")} – ${format(dateRange.to, "MMM d, yyyy")}`
      : format(dateRange.from, "MMM d, yyyy")
    : "Date range";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight text-[#333333]">Audit Log</h1>
          {overrideCount > 0 ? (
            <Badge variant="outline" className="border-red-300 bg-red-50 text-red-700">
              <AlertTriangle className="mr-1 h-3 w-3" />
              {overrideCount} budget override{overrideCount > 1 ? "s" : ""}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="overrides-only"
            checked={overridesOnly}
            onCheckedChange={setOverridesOnly}
          />
          <Label htmlFor="overrides-only" className="cursor-pointer text-sm text-[#5F5F5F]">
            Budget overrides only
          </Label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by user, action, entity, or description"
            className="pl-9"
            data-testid="input-audit-search"
          />
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={cn(
                "justify-start text-left font-normal",
                !dateRange?.from && "text-muted-foreground"
              )}
              data-testid="button-date-range"
            >
              <CalendarIcon className="mr-2 h-4 w-4" />
              {dateLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="range"
              selected={dateRange}
              onSelect={setDateRange}
              numberOfMonths={2}
              defaultMonth={dateRange?.from}
            />
          </PopoverContent>
        </Popover>
        {dateRange?.from ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDateRange(undefined)}
            className="text-muted-foreground"
            data-testid="button-clear-dates"
          >
            <X className="mr-1 h-3.5 w-3.5" />
            Clear dates
          </Button>
        ) : null}
        {!isLoading && visibleLogs && logs ? (
          <span className="text-sm text-muted-foreground" data-testid="text-audit-count">
            {hasFilters
              ? `Showing ${visibleLogs.length} of ${logs.length} loaded entries`
              : totalCount != null
                ? `Showing ${logs.length.toLocaleString()} of ${totalCount.toLocaleString()} entries`
                : null}
          </span>
        ) : null}
      </div>

      <div ref={tableContainerRef} className="rounded-md border bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Timestamp</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-48" /></TableCell>
                </TableRow>
              ))
            ) : visibleLogs?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  {hasFilters ? "No entries match the current filters." : "No audit logs found."}
                </TableCell>
              </TableRow>
            ) : (
              <>
              {paddingTop > 0 ? (
                <tr aria-hidden="true" style={{ height: paddingTop }} />
              ) : null}
              {virtualRows.map((virtualRow) => {
                const log = visibleLogs![virtualRow.index];
                const override = isOverride(log.action);
                const href = entityLink(log.entityType, log.entityId);
                return (
                  <TableRow
                    key={log.id}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    className={cn(override && "bg-red-50 hover:bg-red-100")}
                  >
                    <TableCell className="whitespace-nowrap">{format(new Date(log.createdAt), "MMM d, yyyy HH:mm:ss")}</TableCell>
                    <TableCell>{log.userName}</TableCell>
                    <TableCell className={cn("font-medium", override && "text-red-700")}>
                      {override ? (
                        <span className="inline-flex items-center gap-1">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {log.action}
                        </span>
                      ) : (
                        log.action
                      )}
                    </TableCell>
                    <TableCell>
                      {href ? (
                        <Link
                          href={href}
                          className="inline-flex items-center gap-1 font-medium text-[#CFAF42] hover:underline"
                        >
                          {log.entityType} #{log.entityId}
                          <ExternalLink className="h-3 w-3" />
                        </Link>
                      ) : (
                        <span>{log.entityType} {log.entityId ? `#${log.entityId}` : ""}</span>
                      )}
                    </TableCell>
                    <TableCell className={cn("text-muted-foreground", override && "text-red-700/90")}>
                      {log.description}
                    </TableCell>
                  </TableRow>
                );
              })}
              {paddingBottom > 0 ? (
                <tr aria-hidden="true" style={{ height: paddingBottom }} />
              ) : null}
              </>
            )}
          </TableBody>
        </Table>
      </div>

      {hasNextPage ? (
        <div ref={loadMoreRef} className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            data-testid="button-load-more-audit"
          >
            {isFetchingNextPage ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading…
              </>
            ) : (
              "Load older entries"
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
