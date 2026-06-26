import { useListAuditLogs } from "@workspace/api-client-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";

export default function BudgetOverrideHistory({
  entityType,
  entityId,
}: {
  entityType: "invoice" | "package";
  entityId: number;
}) {
  const { data: auditLogs } = useListAuditLogs();

  // Surface every "approved over budget" override recorded for this entity so
  // managers can see who bypassed the budget guard and why. Audit logs arrive
  // newest-first from the API, so the most recent override shows on top.
  const overrides = auditLogs?.filter(
    (log) =>
      log.entityType === entityType &&
      log.entityId === entityId &&
      log.action === "approved over budget",
  );

  if (!overrides || overrides.length === 0) return null;

  return (
    <Alert variant="destructive" className="border-red-300 bg-red-50">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>
        Budget override{overrides.length > 1 ? "s" : ""} on record
      </AlertTitle>
      <AlertDescription>
        <ul className="mt-1 space-y-2">
          {overrides.map((log) => (
            <li key={log.id} className="text-sm">
              <span className="font-medium">{log.userName}</span> approved over
              budget on {new Date(log.createdAt).toLocaleString()}.
              {log.description ? (
                <span className="block text-red-700/90">{log.description}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
