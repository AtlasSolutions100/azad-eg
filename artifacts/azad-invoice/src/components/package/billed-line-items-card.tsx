import { useEffect, useState } from "react";
import {
  useListBilledLineItems,
  useReplaceBilledLineItems,
  getListBilledLineItemsQueryKey,
  type BilledLineItemInput,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { formatCurrency } from "@/lib/package-ui";

/** One editable row of the invoice cover's Billed Line Items table. */
interface RowDraft {
  workScopeNo: string;
  poNo: string;
  lineNo: string;
  bartProjectNo: string;
  poAmount: string;
  previousInvoiced: string;
  currentInvoiced: string;
}

const MAX_ITEMS = 10;

function toDraft(item: {
  workScopeNo: string;
  poNo?: string | null;
  lineNo?: number | null;
  bartProjectNo?: string | null;
  poAmount: number;
  previousInvoiced: number;
  currentInvoiced: number;
}): RowDraft {
  return {
    workScopeNo: item.workScopeNo,
    poNo: item.poNo ?? "",
    lineNo: item.lineNo != null ? String(item.lineNo) : "",
    bartProjectNo: item.bartProjectNo ?? "",
    poAmount: String(item.poAmount),
    previousInvoiced: String(item.previousInvoiced),
    currentInvoiced: String(item.currentInvoiced),
  };
}

const EMPTY_ROW: RowDraft = {
  workScopeNo: "",
  poNo: "",
  lineNo: "",
  bartProjectNo: "",
  poAmount: "",
  previousInvoiced: "",
  currentInvoiced: "",
};

const num = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

export default function BilledLineItemsCard({ packageId }: { packageId: number }) {
  const { data, isLoading } = useListBilledLineItems(packageId);
  const replaceItems = useReplaceBilledLineItems();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [rows, setRows] = useState<RowDraft[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty) setRows(data.items.map(toDraft));
  }, [data, dirty]);

  const edit = (i: number, patch: Partial<RowDraft>) => {
    setDirty(true);
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    setDirty(true);
    setRows((prev) => [...prev, { ...EMPTY_ROW }]);
  };

  const removeRow = (i: number) => {
    setDirty(true);
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  };

  const save = async () => {
    const items: BilledLineItemInput[] = rows
      .filter((r) => r.workScopeNo.trim())
      .map((r, i) => ({
        workScopeNo: r.workScopeNo.trim(),
        poNo: r.poNo.trim() || undefined,
        lineNo: r.lineNo.trim() ? num(r.lineNo) : undefined,
        bartProjectNo: r.bartProjectNo.trim() || undefined,
        poAmount: num(r.poAmount),
        previousInvoiced: num(r.previousInvoiced),
        currentInvoiced: num(r.currentInvoiced),
        sortOrder: i,
      }));
    try {
      await replaceItems.mutateAsync({ id: packageId, data: { items } });
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: getListBilledLineItemsQueryKey(packageId) });
      queryClient.invalidateQueries({ queryKey: [`/packages/${packageId}`] });
      toast({ title: "Billed line items saved" });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Failed to save billed line items",
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  const totals = rows.reduce(
    (acc, r) => {
      acc.po += num(r.poAmount);
      acc.prev += num(r.previousInvoiced);
      acc.cur += num(r.currentInvoiced);
      return acc;
    },
    { po: 0, prev: 0, cur: 0 },
  );
  const totalInvoiced = totals.prev + totals.cur;
  const remaining = totals.po - totalInvoiced;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Billed Line Items</CardTitle>
          <p className="mt-1 text-xs text-[#5F5F5F]">
            Printed on the invoice cover (rows 25–34). Amounts carry forward to the
            next month's package automatically.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={addRow}
            disabled={rows.length >= MAX_ITEMS}
            data-testid="button-add-line-item"
          >
            <Plus className="mr-1 h-4 w-4" /> Add Row
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={replaceItems.isPending || !dirty}
            className="bg-[#CFAF42] text-white hover:bg-[#bd9e36]"
            data-testid="button-save-line-items"
          >
            {replaceItems.isPending ? "Saving…" : "Save Items"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-[#5F5F5F]">
            No billed line items. Add rows to populate the invoice cover table.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[110px]">Work Scope</TableHead>
                  <TableHead className="min-w-[100px]">PO No.</TableHead>
                  <TableHead className="min-w-[68px]">Line</TableHead>
                  <TableHead className="min-w-[130px]">BART Project</TableHead>
                  <TableHead className="min-w-[132px] text-right">PO Amount</TableHead>
                  <TableHead className="min-w-[132px] text-right">Previous</TableHead>
                  <TableHead className="min-w-[132px] text-right">This Invoice</TableHead>
                  <TableHead className="min-w-[100px] text-right">Total</TableHead>
                  <TableHead className="min-w-[100px] text-right">Remaining</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => {
                  const rowTotal = num(r.previousInvoiced) + num(r.currentInvoiced);
                  const rowRemaining = num(r.poAmount) - rowTotal;
                  return (
                    <TableRow key={i} data-testid={`row-line-item-${i}`}>
                      <TableCell className="p-1.5">
                        <Input
                          className="h-8"
                          value={r.workScopeNo}
                          placeholder="B.50-03"
                          onChange={(e) => edit(i, { workScopeNo: e.target.value })}
                          data-testid={`input-work-scope-${i}`}
                        />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Input
                          className="h-8"
                          value={r.poNo}
                          onChange={(e) => edit(i, { poNo: e.target.value })}
                        />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Input
                          className="h-8 px-2 text-center"
                          type="number"
                          value={r.lineNo}
                          onChange={(e) => edit(i, { lineNo: e.target.value })}
                        />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Input
                          className="h-8"
                          value={r.bartProjectNo}
                          placeholder="15NL004/PJMGT"
                          onChange={(e) => edit(i, { bartProjectNo: e.target.value })}
                        />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Input
                          className="h-8 text-right"
                          type="number"
                          step="0.01"
                          value={r.poAmount}
                          onChange={(e) => edit(i, { poAmount: e.target.value })}
                        />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Input
                          className="h-8 text-right"
                          type="number"
                          step="0.01"
                          value={r.previousInvoiced}
                          onChange={(e) => edit(i, { previousInvoiced: e.target.value })}
                        />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Input
                          className="h-8 text-right"
                          type="number"
                          step="0.01"
                          value={r.currentInvoiced}
                          onChange={(e) => edit(i, { currentInvoiced: e.target.value })}
                          data-testid={`input-current-invoiced-${i}`}
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm">
                        {formatCurrency(rowTotal)}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums text-sm ${rowRemaining < -0.01 ? "font-semibold text-red-600" : ""}`}
                      >
                        {formatCurrency(rowRemaining)}
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => removeRow(i)}
                          data-testid={`button-remove-line-item-${i}`}
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="bg-[#CFAF42]/5 font-semibold">
                  <TableCell colSpan={4}>Total</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(totals.po)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(totals.prev)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(totals.cur)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(totalInvoiced)}
                  </TableCell>
                  <TableCell
                    className={`text-right tabular-nums ${remaining < -0.01 ? "text-red-600" : ""}`}
                  >
                    {formatCurrency(remaining)}
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
        {rows.length >= MAX_ITEMS && (
          <p className="mt-2 text-xs text-amber-600">
            The invoice cover supports a maximum of {MAX_ITEMS} line items.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
