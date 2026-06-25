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
    </div>
  );
}
