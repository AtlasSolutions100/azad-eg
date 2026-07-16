import { useEffect, useState } from "react";
import {
  useUpdatePackage,
  useListSignatures,
  useGetPackageValidations,
  type PackageDetail,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, AlertTriangle, Info } from "lucide-react";
import { formatCurrency } from "@/lib/package-ui";
import BudgetOverrideHistory from "@/components/budget-override-history";
import BilledLineItemsCard from "@/components/package/billed-line-items-card";

export default function InvoiceTab({ detail }: { detail: PackageDetail }) {
  const { package: pkg, rollup } = detail;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updatePackage = useUpdatePackage();
  const { data: signatures } = useListSignatures();
  const { data: validations } = useGetPackageValidations(pkg.id);

  const [form, setForm] = useState({
    invoiceNumber: pkg.invoiceNumber ?? "",
    invoiceDate: pkg.invoiceDate ?? "",
    previouslyBilled: pkg.previouslyBilled,
    otherDirectCosts: pkg.otherDirectCosts,
    signatureId: pkg.signatureId ?? undefined,
  });

  // Shared budget signal (same evaluateBudgetStatus thresholds as the
  // per-invoice workspace). Over-budget approval requires an audited override.
  const budgetStatus = rollup.budgetStatus;
  const overBudget = budgetStatus.overBudget;
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  useEffect(() => {
    setForm({
      invoiceNumber: pkg.invoiceNumber ?? "",
      invoiceDate: pkg.invoiceDate ?? "",
      previouslyBilled: pkg.previouslyBilled,
      otherDirectCosts: pkg.otherDirectCosts,
      signatureId: pkg.signatureId ?? undefined,
    });
  }, [pkg]);

  const saveDetails = async () => {
    try {
      await updatePackage.mutateAsync({
        id: pkg.id,
        data: {
          invoiceNumber: form.invoiceNumber || undefined,
          invoiceDate: form.invoiceDate || undefined,
          previouslyBilled: form.previouslyBilled,
          otherDirectCosts: form.otherDirectCosts,
          signatureId: form.signatureId,
        },
      });
      queryClient.invalidateQueries();
      toast({ title: "Invoice details saved" });
    } catch {
      toast({ variant: "destructive", title: "Failed to save invoice details" });
    }
  };

  const submitApproval = async (budgetOverride: boolean, reason?: string) => {
    const sig = signatures?.find((s) => s.id === form.signatureId);
    try {
      await updatePackage.mutateAsync({
        id: pkg.id,
        data: {
          status: "approved",
          approvedBy: sig?.name,
          ...(budgetOverride ? { budgetOverride: true, budgetOverrideReason: reason || undefined } : {}),
        },
      });
      queryClient.invalidateQueries();
      setOverrideOpen(false);
      setOverrideReason("");
      toast({ title: "Package approved" });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Failed to approve package",
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  const approve = () => {
    // An over-budget package cannot be approved without an explicit override
    // that gets recorded in the audit log — prompt for confirmation first.
    if (overBudget) {
      setOverrideOpen(true);
      return;
    }
    submitApproval(false);
  };

  const summary: { label: string; amount: number; emphasis?: boolean }[] = [
    { label: "Total This Period", amount: rollup.totalThisPeriod, emphasis: true },
    { label: "Previously Billed", amount: rollup.previouslyBilled },
    { label: "Total To Date", amount: rollup.totalToDate, emphasis: true },
    { label: "Remaining Balance", amount: rollup.remainingBalance },
  ];

  return (
    <div className="space-y-6">
      <BudgetOverrideHistory entityType="package" entityId={pkg.id} />

      {budgetStatus.level !== "ok" && (
        <Alert
          variant={budgetStatus.level === "over" ? "destructive" : "default"}
          className={
            budgetStatus.level === "over"
              ? "border-red-300 bg-red-50"
              : "border-yellow-200 bg-yellow-50"
          }
          data-testid="alert-package-budget"
        >
          {budgetStatus.level === "over" ? (
            <AlertTriangle className="h-4 w-4" />
          ) : (
            <Info className="h-4 w-4 text-yellow-600" />
          )}
          <AlertTitle className={budgetStatus.level === "over" ? "" : "text-yellow-800"}>
            {budgetStatus.level === "over" ? "Over budget" : "Approaching budget limit"}
          </AlertTitle>
          <AlertDescription className={budgetStatus.level === "over" ? "" : "text-yellow-700"}>
            {budgetStatus.message} Remaining balance:{" "}
            {formatCurrency(budgetStatus.remainingBalance)}.
            {budgetStatus.level === "over" &&
              " Approving this package will require a recorded budget override."}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Invoice Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Invoice Number</Label>
                <Input
                  value={form.invoiceNumber}
                  onChange={(e) =>
                    setForm({ ...form, invoiceNumber: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Invoice Date</Label>
                <Input
                  type="date"
                  value={form.invoiceDate ? form.invoiceDate.slice(0, 10) : ""}
                  onChange={(e) =>
                    setForm({ ...form, invoiceDate: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label>Previously Billed</Label>
                  {pkg.previouslyBilledSource === "procas" && (
                    <Badge variant="secondary" className="text-[10px]" data-testid="badge-prev-billed-procas">
                      from Procas
                    </Badge>
                  )}
                  {pkg.previouslyBilledSource === "manual" && (
                    <Badge variant="outline" className="text-[10px]" data-testid="badge-prev-billed-manual">
                      manual override
                    </Badge>
                  )}
                </div>
                <Input
                  type="number"
                  step="0.01"
                  value={form.previouslyBilled}
                  onChange={(e) =>
                    setForm({ ...form, previouslyBilled: Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Other Direct Costs</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.otherDirectCosts}
                  onChange={(e) =>
                    setForm({ ...form, otherDirectCosts: Number(e.target.value) })
                  }
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Signature</Label>
              <Select
                value={form.signatureId?.toString() ?? ""}
                onValueChange={(v) =>
                  setForm({ ...form, signatureId: Number(v) })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a signature…" />
                </SelectTrigger>
                <SelectContent>
                  {signatures?.map((s) => (
                    <SelectItem key={s.id} value={s.id.toString()}>
                      {s.name}
                      {s.title ? ` — ${s.title}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between pt-2">
              <Button
                onClick={saveDetails}
                disabled={updatePackage.isPending}
                className="bg-[#CFAF42] text-white hover:bg-[#bd9e36]"
              >
                {updatePackage.isPending ? "Saving…" : "Save Details"}
              </Button>
              {pkg.status === "draft" && (
                <Button
                  variant="outline"
                  onClick={approve}
                  disabled={
                    updatePackage.isPending ||
                    (validations && !validations.isValid)
                  }
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" /> Approve
                </Button>
              )}
            </div>
            {validations && !validations.isValid && pkg.status === "draft" && (
              <p className="text-xs text-amber-600">
                Resolve validation issues before approving.
              </p>
            )}
            {overBudget && pkg.status === "draft" && (
              <p className="flex items-center gap-1 text-xs text-red-600">
                <AlertTriangle className="h-3 w-3" /> Over budget — approval
                requires a recorded override.
              </p>
            )}
          </CardContent>
        </Card>

        <Dialog open={overrideOpen} onOpenChange={setOverrideOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-red-600">
                <AlertTriangle className="h-5 w-5" /> Approve over budget?
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Alert variant="destructive" className="border-red-300 bg-red-50">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Total billed to date exceeds the work plan budget. Remaining
                  balance: {formatCurrency(rollup.remainingBalance)}. Approving
                  will record a budget override in the audit log.
                </AlertDescription>
              </Alert>
              <div className="space-y-2">
                <Label>Reason for override (required)</Label>
                <Textarea
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="e.g. Client PO amendment pending, approved by PM."
                  rows={3}
                />
                {!overrideReason.trim() && (
                  <p className="text-xs text-muted-foreground">
                    A reason is required to approve over budget.
                  </p>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setOverrideOpen(false)}>
                  Cancel
                </Button>
                <Button
                  className="bg-red-600 text-white hover:bg-red-700"
                  onClick={() => submitApproval(true, overrideReason.trim())}
                  disabled={updatePackage.isPending || !overrideReason.trim()}
                >
                  {updatePackage.isPending ? "Approving…" : "Override & Approve"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Billing Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                {summary.map((row) => {
                  const highlight = row.label === "Remaining Balance" && overBudget;
                  return (
                    <TableRow
                      key={row.label}
                      className={row.emphasis ? "bg-[#CFAF42]/5 font-semibold" : ""}
                    >
                      <TableCell>{row.label}</TableCell>
                      <TableCell
                        className={`text-right tabular-nums ${highlight ? "font-semibold text-red-600" : ""}`}
                        data-testid={highlight ? "text-remaining-balance-over" : undefined}
                      >
                        {formatCurrency(row.amount)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <p className="mt-3 text-xs text-[#5F5F5F]">
              {rollup.percentExpended.toFixed(1)}% of budget expended to date.
            </p>
          </CardContent>
        </Card>
      </div>

      <BilledLineItemsCard packageId={pkg.id} />
    </div>
  );
}
