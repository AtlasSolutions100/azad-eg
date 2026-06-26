import { useState } from "react";
import {
  useSaveLaborOverride,
  useDeleteLaborOverride,
  type PackageDetail,
  type PackageLaborLine,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Check, RotateCcw, X } from "lucide-react";
import {
  formatCurrency,
  formatHours,
  laborCellKey,
  LABOR_HOME_START,
  LABOR_HOME_END,
  LABOR_FIELD_START,
  LABOR_FIELD_END,
  type LaborColumn,
} from "@/lib/package-ui";
import DocDownload from "./doc-download";

type Block = "home" | "field";
const NUMERIC_COLUMNS: LaborColumn[] = ["hours", "rate", "amount", "billed"];
const HOME_CAPACITY = LABOR_HOME_END - LABOR_HOME_START + 1;
const FIELD_CAPACITY = LABOR_FIELD_END - LABOR_FIELD_START + 1;

function autoValue(line: PackageLaborLine, column: LaborColumn): number {
  switch (column) {
    case "hours":
      return line.hours;
    case "rate":
      return line.rate;
    case "amount":
      return line.amount;
    case "billed":
      return line.amount;
  }
}

export default function LaborTab({ detail }: { detail: PackageDetail }) {
  const { package: pkg, rollup, overrides } = detail;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const saveOverride = useSaveLaborOverride();
  const deleteOverride = useDeleteLaborOverride();

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const overrideMap = new Map(overrides.map((o) => [o.cellKey, o.value]));

  const homeLines = rollup.laborLines.filter((l) => l.location !== "field");
  const fieldLines = rollup.laborLines.filter((l) => l.location === "field");

  const startEdit = (cellKey: string, current: string) => {
    setEditingKey(cellKey);
    setDraft(current);
  };

  const commit = async (cellKey: string) => {
    try {
      await saveOverride.mutateAsync({
        id: pkg.id,
        data: { cellKey, value: draft },
      });
      queryClient.invalidateQueries();
      setEditingKey(null);
      toast({ title: "Override saved", description: `${cellKey} = ${draft}` });
    } catch {
      toast({ variant: "destructive", title: "Failed to save override" });
    }
  };

  const reset = async (cellKey: string) => {
    try {
      await deleteOverride.mutateAsync({ id: pkg.id, cellKey });
      queryClient.invalidateQueries();
      if (editingKey === cellKey) setEditingKey(null);
      toast({ title: "Reverted to auto value" });
    } catch {
      toast({ variant: "destructive", title: "Failed to reset cell" });
    }
  };

  const renderCell = (
    block: Block,
    rowIndex: number,
    column: LaborColumn,
    line: PackageLaborLine,
  ) => {
    const cellKey = laborCellKey(block, rowIndex, column);
    const overridden = overrideMap.has(cellKey);
    const auto = autoValue(line, column);
    const display = overridden ? overrideMap.get(cellKey)! : String(auto);
    const isEditing = editingKey === cellKey;

    if (isEditing) {
      return (
        <div className="flex items-center justify-end gap-1">
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit(cellKey);
              if (e.key === "Escape") setEditingKey(null);
            }}
            className="h-8 w-24 text-right"
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => commit(cellKey)}
            aria-label="Save"
          >
            <Check className="h-4 w-4 text-emerald-600" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => setEditingKey(null)}
            aria-label="Cancel"
          >
            <X className="h-4 w-4 text-gray-500" />
          </Button>
        </div>
      );
    }

    const numericDisplay = (() => {
      const n = Number(display);
      if (Number.isNaN(n)) return display;
      return column === "hours" ? formatHours(n) : formatCurrency(n);
    })();

    return (
      <div className="group/cell flex items-center justify-end gap-1.5">
        {overridden && (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 opacity-0 group-hover/cell:opacity-100"
            onClick={() => reset(cellKey)}
            aria-label="Reset to auto"
            title="Reset to auto value"
          >
            <RotateCcw className="h-3.5 w-3.5 text-gray-500" />
          </Button>
        )}
        <button
          type="button"
          onClick={() => startEdit(cellKey, display)}
          className={`rounded px-2 py-1 text-right tabular-nums transition-colors ${
            overridden
              ? "bg-amber-50 font-semibold text-amber-700 ring-1 ring-amber-200"
              : "text-[#333333] hover:bg-gray-100"
          }`}
          title={overridden ? `Manual override (auto: ${auto})` : "Auto-calculated — click to override"}
        >
          {numericDisplay}
        </button>
      </div>
    );
  };

  const readOnlyCell = (line: PackageLaborLine, column: LaborColumn) => {
    const n = autoValue(line, column);
    return (
      <span className="px-2 py-1 text-right tabular-nums text-[#9a9a9a]">
        {column === "hours" ? formatHours(n) : formatCurrency(n)}
      </span>
    );
  };

  const renderBlock = (
    label: string,
    block: Block,
    lines: PackageLaborLine[],
    capacity: number,
  ) => {
    const overflow = lines.length - capacity;
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{label} Labor</CardTitle>
        </CardHeader>
        <CardContent>
          {lines.length === 0 ? (
            <p className="text-sm text-[#5F5F5F]">
              No {label.toLowerCase()} labor lines.
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Classification</TableHead>
                    <TableHead>Employee</TableHead>
                    <TableHead className="text-right">Hours</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Billed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line, i) => {
                    const editable = i < capacity;
                    return (
                      <TableRow key={`${block}-${i}`} className={editable ? "" : "opacity-60"}>
                        <TableCell>{line.classification}</TableCell>
                        <TableCell>{line.employeeName}</TableCell>
                        {NUMERIC_COLUMNS.map((col) => (
                          <TableCell key={col} className="text-right">
                            {editable
                              ? renderCell(block, i, col, line)
                              : readOnlyCell(line, col)}
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {overflow > 0 && (
                <p className="mt-3 text-xs text-amber-600">
                  The {label.toLowerCase()} labor template holds {capacity} lines.
                  The last {overflow} line{overflow > 1 ? "s are" : " is"} shown for
                  reference only — they can&apos;t be overridden and won&apos;t
                  appear on the exported attachment.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      <DocDownload
        packageId={pkg.id}
        doc="labor"
        label="Labor Attachment"
        description="Per-employee labor detail with burden applied."
        status={pkg.laborAttachmentDocStatus}
      />

      <Card className="border-dashed">
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4 text-xs text-[#5F5F5F]">
          <CardDescription className="text-xs">
            Click any value to override it. Values shown:
          </CardDescription>
          <span className="flex items-center gap-2">
            <span className="rounded px-2 py-0.5 text-[#333333] ring-1 ring-gray-200">
              auto-calculated
            </span>
            from timesheets
          </span>
          <span className="flex items-center gap-2">
            <span className="rounded bg-amber-50 px-2 py-0.5 font-semibold text-amber-700 ring-1 ring-amber-200">
              manual override
            </span>
            wins at export
          </span>
        </CardContent>
      </Card>

      {renderBlock("Home", "home", homeLines, HOME_CAPACITY)}
      {renderBlock("Field", "field", fieldLines, FIELD_CAPACITY)}
    </div>
  );
}
