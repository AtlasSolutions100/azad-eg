import { useState } from "react";
import { Link } from "wouter";
import { useListAuditLogs } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { format } from "date-fns";

const OVERRIDE_ACTION = "approved over budget";

function entityLink(entityType: string, entityId: number | null | undefined): string | null {
  if (entityId == null) return null;
  if (entityType === "invoice") return `/invoices/${entityId}`;
  if (entityType === "package") return `/packages/${entityId}`;
  return null;
}

export default function AuditLog() {
  const { data: logs, isLoading } = useListAuditLogs();
  const [overridesOnly, setOverridesOnly] = useState(false);

  const isOverride = (action: string) => action === OVERRIDE_ACTION;

  const overrideCount = logs?.filter((log) => isOverride(log.action)).length ?? 0;

  const visibleLogs = overridesOnly
    ? logs?.filter((log) => isOverride(log.action))
    : logs;

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

      <div className="rounded-md border bg-white">
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
                  {overridesOnly ? "No budget overrides found." : "No audit logs found."}
                </TableCell>
              </TableRow>
            ) : (
              visibleLogs?.map((log) => {
                const override = isOverride(log.action);
                const href = entityLink(log.entityType, log.entityId);
                return (
                  <TableRow
                    key={log.id}
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
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
