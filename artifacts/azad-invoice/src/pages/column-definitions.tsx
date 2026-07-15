import { useListColumnDefinitions } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

export default function ColumnDefinitions() {
  const { data: columnDefs, isLoading } = useListColumnDefinitions();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight text-[#333333]">Column Definitions</h1>
      </div>

      <div className="rounded-md border bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sheet</TableHead>
              <TableHead>Column</TableHead>
              <TableHead>Field</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Formula</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-48" /></TableCell>
                </TableRow>
              ))
            ) : columnDefs?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No column definitions found.
                </TableCell>
              </TableRow>
            ) : (
              columnDefs?.map((def) => (
                <TableRow key={def.id}>
                  <TableCell className="font-medium">{def.sheet}</TableCell>
                  <TableCell>{def.column || '-'}</TableCell>
                  <TableCell className="font-mono text-xs">{def.field}</TableCell>
                  <TableCell>{def.source}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{def.formula || '-'}</TableCell>
                  <TableCell className="text-sm">{def.description}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="rounded-md border border-[#EDE6CF] bg-[#FBF8EF] p-4">
        <h2 className="text-sm font-semibold text-[#333333]">Procas Mapping Notes</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[#5F5F5F]">
          <li>
            Procas serves a copy of your data refreshed daily at 6 AM Eastern — hours entered today
            appear in pulls tomorrow morning.
          </li>
          <li>
            Hours come from the finalized Labor Journal (GLDetail). If payroll hasn't finalized a
            period yet, raw Timesheet hours are used and flagged with a warning.
          </li>
          <li>
            Billing rates come from the job's Billing Setup (BillingItem), the authoritative
            contract rate source; new employees fall back to the labor category default rate.
          </li>
          <li>
            Only approved data is pulled. Personnel is limited to name, labor category, job title,
            and active status — never addresses, SSNs, or other personal information.
          </li>
          <li>
            Previously Billed defaults from Procas billing history (non-voided invoices before the
            period start). Editing it by hand marks it manual, and Procas never overwrites it after
            that.
          </li>
          <li>
            FCCM rates are not mapped from Procas yet — the source field needs confirmation, so
            work plan FCCM values remain manually maintained.
          </li>
        </ul>
      </div>
    </div>
  );
}
