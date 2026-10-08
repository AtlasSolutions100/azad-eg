import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  useGetPackageBudget,
  getGetPackageBudgetQueryKey,
  useSavePackageBudget,
  useDeletePackageBudgetVersion,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/package-ui";
import { parseDay } from "@/lib/utils";

// The budget by cost category, in the order the invoice detail page prints it.
const PARTS = [
  ["labor", "Labor"],
  ["overhead", "Overhead (fringe)"],
  ["fixedFee", "Fixed fee"],
  ["fccm", "FCCM"],
] as const;

type PartKey = (typeof PARTS)[number][0];
type Scope = "from" | "all";

function toInput(n: number | null | undefined): string {
  return n == null ? "" : String(n);
}

/** "" → null (left blank); anything else must be a number of dollars, 0 or more. */
function toAmount(text: string): number | null | undefined {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function day(value: string): string {
  try {
    return format(parseDay(value), "M/d/yyyy");
  } catch {
    return value;
  }
}

/**
 * The pencil beside a package's Budget. Takes the total and its split by cost
 * category, and the date the budget changed — so entering October's increase
 * does not restate the invoices already sent against the old one.
 */
export default function BudgetDialog({
  packageId,
  open,
  onOpenChange,
}: {
  packageId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: budget } = useGetPackageBudget(packageId, {
    query: { enabled: open, queryKey: getGetPackageBudgetQueryKey(packageId) },
  });
  const save = useSavePackageBudget();
  const remove = useDeletePackageBudgetVersion();

  const [total, setTotal] = useState("");
  const [parts, setParts] = useState<Record<PartKey, string>>({ labor: "", overhead: "", fixedFee: "", fccm: "" });
  const [scope, setScope] = useState<Scope>("from");
  const [from, setFrom] = useState("");

  // Fill the form with the budget this package is stated against each time
  // the dialog opens (and after a change is removed from its history).
  useEffect(() => {
    if (!open || !budget) return;
    setTotal(budget.total > 0 ? String(budget.total) : "");
    setParts({
      labor: toInput(budget.labor),
      overhead: toInput(budget.overhead),
      fixedFee: toInput(budget.fixedFee),
      fccm: toInput(budget.fccm),
    });
    setScope("from");
    setFrom(budget.effectiveFrom ?? budget.periodStart);
  }, [open, budget]);

  const amounts = PARTS.map(([key]) => toAmount(parts[key]));
  const entered = amounts.filter((a): a is number => typeof a === "number");
  const partsSum = Math.round(entered.reduce((s, a) => s + a, 0) * 100) / 100;
  const totalAmount = toAmount(total);
  const invalid = totalAmount == null || amounts.some((a) => a === undefined) || (scope === "from" && !from);
  const off = entered.length > 0 && typeof totalAmount === "number" && Math.abs(partsSum - totalAmount) >= 0.005;
  const noWorkPlan = budget != null && budget.workPlanId == null;

  const done = async (title: string, description: string) => {
    // The budget feeds every figure on the page (remaining, % expended, the
    // checks) and the dashboard, so everything is refetched.
    await queryClient.invalidateQueries();
    toast({ title, description });
  };

  const handleSave = async () => {
    if (invalid || typeof totalAmount !== "number") return;
    const [labor, overhead, fixedFee, fccm] = amounts as Array<number | null>;
    try {
      await save.mutateAsync({
        id: packageId,
        data: { total: totalAmount, labor, overhead, fixedFee, fccm, effectiveFrom: scope === "from" ? from : null },
      });
      await done(
        "Budget updated",
        scope === "from" && !noWorkPlan
          ? `Applies to invoices from ${day(from)}. Earlier invoices keep the budget they had.`
          : "Remaining and % expended recalculated.",
      );
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Could not update budget",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleRemove = async (version: string) => {
    try {
      await remove.mutateAsync({ id: packageId, from: version });
      await done("Budget change removed", `The change dated ${day(version)} no longer applies.`);
    } catch (err) {
      toast({
        title: "Could not remove that change",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden" data-testid="budget-dialog">
        <DialogHeader>
          <DialogTitle>Budget</DialogTitle>
          <DialogDescription>
            The work plan's budget, as it prints on the invoice and the invoice detail page.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <div className="grid grid-cols-2 gap-3">
            {PARTS.map(([key, label]) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`budget-${key}`}>Budget for {label} ($)</Label>
                <Input
                  id={`budget-${key}`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={parts[key]}
                  onChange={(e) => setParts({ ...parts, [key]: e.target.value })}
                  disabled={noWorkPlan}
                  data-testid={`budget-${key}`}
                />
              </div>
            ))}
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="budget-total">Total budget ($)</Label>
              <Input
                id="budget-total"
                type="number"
                min="0"
                step="0.01"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                data-testid="budget-input"
              />
              {entered.length > 0 && (
                <p className={`text-xs ${off ? "text-amber-700" : "text-[#5F5F5F]"}`}>
                  The parts above add up to {formatCurrency(partsSum)}
                  {off ? ", which is not the total. " : ". "}
                  {off && (
                    <button
                      type="button"
                      className="underline"
                      onClick={() => setTotal(String(partsSum))}
                      data-testid="budget-use-sum"
                    >
                      Use that as the total
                    </button>
                  )}
                </p>
              )}
              {entered.length === 0 && !noWorkPlan && (
                <p className="text-xs text-[#5F5F5F]">
                  Leave the parts blank and the invoice works them out from the total at this work plan's rates.
                </p>
              )}
              {budget?.procasBudget != null && (
                <p className="text-xs text-[#5F5F5F]">
                  Procas shows {formatCurrency(budget.procasBudget)} for this work plan.
                </p>
              )}
            </div>
          </div>

          {noWorkPlan ? (
            <p className="text-xs text-[#5F5F5F]">
              This package has no work plan yet, so only its total can be set here.
            </p>
          ) : (
            <div className="space-y-2 border-t pt-4">
              <p className="text-sm font-medium text-[#333333]">Which invoices does this apply to?</p>
              <label className="flex items-start gap-2 text-sm text-[#333333]">
                <input
                  type="radio"
                  name="budget-scope"
                  className="mt-1"
                  checked={scope === "from"}
                  onChange={() => setScope("from")}
                  data-testid="budget-scope-from"
                />
                <span className="flex-1 space-y-1.5">
                  <span className="block">Invoices from this date on</span>
                  <Input
                    type="date"
                    className="h-8 w-44 text-sm"
                    value={from}
                    onChange={(e) => {
                      setFrom(e.target.value);
                      setScope("from");
                    }}
                    aria-label="Date the budget changed"
                    data-testid="budget-from"
                  />
                  <span className="block text-xs text-[#5F5F5F]">
                    The day the budget changed. Invoices for periods that ended before it keep the budget they had.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-[#333333]">
                <input
                  type="radio"
                  name="budget-scope"
                  className="mt-1"
                  checked={scope === "all"}
                  onChange={() => setScope("all")}
                  data-testid="budget-scope-all"
                />
                <span>
                  Every invoice, back to the start
                  <span className="block text-xs text-[#5F5F5F]">
                    For correcting a budget that was entered wrong.
                  </span>
                </span>
              </label>
            </div>
          )}

          {budget != null && budget.history.length > 0 && (
            <div className="space-y-1.5 border-t pt-4" data-testid="budget-history">
              <p className="text-sm font-medium text-[#333333]">Budget over time</p>
              {budget.history.map((v) => (
                <div
                  key={v.from ?? "start"}
                  className="flex items-center justify-between gap-3 text-sm text-[#333333]"
                >
                  <span>
                    {v.from ? `From ${day(v.from)}` : "From the start"}
                    {v.from === budget.effectiveFrom && (
                      <span className="ml-2 text-xs text-[#9a9a9a]">this invoice</span>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-medium">{formatCurrency(v.total)}</span>
                    {v.from ? (
                      <button
                        type="button"
                        className="text-xs text-red-600 hover:underline disabled:opacity-50"
                        disabled={remove.isPending}
                        onClick={() => void handleRemove(v.from as string)}
                        data-testid={`budget-remove-${v.from}`}
                      >
                        Remove
                      </button>
                    ) : (
                      <span className="w-[46px]" />
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="bg-[#CFAF42] text-white hover:bg-[#CFAF42]/90"
            disabled={invalid || save.isPending}
            onClick={() => void handleSave()}
            data-testid="save-budget"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
