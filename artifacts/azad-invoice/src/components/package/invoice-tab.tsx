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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { formatCurrency } from "@/lib/package-ui";
import DocDownload from "./doc-download";

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

  const approve = async () => {
    const sig = signatures?.find((s) => s.id === form.signatureId);
    try {
      await updatePackage.mutateAsync({
        id: pkg.id,
        data: { status: "approved", approvedBy: sig?.name },
      });
      queryClient.invalidateQueries();
      toast({ title: "Package approved" });
    } catch {
      toast({ variant: "destructive", title: "Failed to approve package" });
    }
  };

  const summary: { label: string; amount: number; emphasis?: boolean }[] = [
    { label: "Total This Period", amount: rollup.totalThisPeriod, emphasis: true },
    { label: "Previously Billed", amount: rollup.previouslyBilled },
    { label: "Total To Date", amount: rollup.totalToDate, emphasis: true },
    { label: "Remaining Balance", amount: rollup.remainingBalance },
  ];

  return (
    <div className="space-y-6">
      <DocDownload
        packageId={pkg.id}
        doc="invoice"
        label="Invoice"
        description="Cover invoice with billing summary and signature."
        status={pkg.invoiceDocStatus}
      />

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
                <Label>Previously Billed</Label>
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Billing Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                {summary.map((row) => (
                  <TableRow
                    key={row.label}
                    className={row.emphasis ? "bg-[#CFAF42]/5 font-semibold" : ""}
                  >
                    <TableCell>{row.label}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(row.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-3 text-xs text-[#5F5F5F]">
              {rollup.percentExpended.toFixed(1)}% of budget expended to date.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
