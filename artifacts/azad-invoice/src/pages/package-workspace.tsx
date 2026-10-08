import { parseDay } from "@/lib/utils";
import { Link, useLocation, useParams } from "wouter";
import { useState } from "react";
import {
  useGetPackage,
  useDeletePackage,
  getListPackagesQueryKey,
} from "@workspace/api-client-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Building2, CalendarRange, Pencil, Trash2, User } from "lucide-react";
import { format } from "date-fns";
import {
  PACKAGE_STATUS_STYLES,
  formatCurrency,
  formatHours,
} from "@/lib/package-ui";
import ExportBar from "@/components/package/export-bar";
import BudgetDialog from "@/components/package/budget-dialog";
import OverviewTab from "@/components/package/overview-tab";
import TimesheetsTab from "@/components/package/timesheets-tab";
import LaborTab from "@/components/package/labor-tab";
import SubCalcTab from "@/components/package/subcalc-tab";
import InvoiceTab from "@/components/package/invoice-tab";
import ProgressTab from "@/components/package/progress-tab";

function payPeriod(start: string, end: string): string {
  try {
    return `${format(parseDay(start), "MMM d")} – ${format(parseDay(end), "MMM d, yyyy")}`;
  } catch {
    return `${start} – ${end}`;
  }
}

export default function PackageWorkspace() {
  const params = useParams();
  const id = Number(params.id);
  const { data: detail, isLoading, isError } = useGetPackage(id);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const deletePackage = useDeletePackage();

  const handleDelete = async () => {
    try {
      await deletePackage.mutateAsync({ id });
      await queryClient.invalidateQueries({ queryKey: getListPackagesQueryKey() });
      toast({ title: "Package deleted" });
      navigate("/");
    } catch (err) {
      toast({
        title: "Could not delete package",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    }
  };
  // The budget lives on the work plan and can change over time; the pencil
  // opens the dialog that enters it (see BudgetDialog).
  const [budgetOpen, setBudgetOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (isError || !detail) {
    return (
      <div className="p-6">
        <Link
          href="/"
          className="mb-4 inline-flex items-center gap-1 text-sm text-[#5F5F5F] hover:text-[#333333]"
        >
          <ArrowLeft className="h-4 w-4" /> Back to packages
        </Link>
        <Card>
          <CardContent className="py-12 text-center text-sm text-[#5F5F5F]">
            Package not found.
          </CardContent>
        </Card>
      </div>
    );
  }

  const { package: pkg, rollup } = detail;
  const statusStyle =
    PACKAGE_STATUS_STYLES[pkg.status] ?? PACKAGE_STATUS_STYLES.draft;

  const summaryCards = [
    { label: "Total Hours", value: formatHours(rollup.totalHours) },
    { label: "Labor Total", value: formatCurrency(rollup.laborTotal) },
    { label: "This Period", value: formatCurrency(rollup.totalThisPeriod) },
    { label: "Total To Date", value: formatCurrency(rollup.totalToDate) },
    {
      label: "Budget",
      value: rollup.budget > 0 ? formatCurrency(rollup.budget) : "Not set",
      editableBudget: true,
    },
    { label: "Previously Billed", value: formatCurrency(rollup.previouslyBilled) },
    { label: "Remaining", value: formatCurrency(rollup.remainingBalance) },
    {
      label: "% Expended",
      value: `${rollup.percentExpended.toFixed(2)}%`,
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-[#5F5F5F] hover:text-[#333333]"
      >
        <ArrowLeft className="h-4 w-4" /> Back to packages
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-[#333333]">
              {pkg.employeeName ?? `Job ${pkg.jobNumber}`}
            </h1>
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize ${statusStyle}`}
            >
              {pkg.status.replace("_", " ")}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-[#5F5F5F]">
            <span className="flex items-center gap-1.5">
              <Building2 className="h-4 w-4 text-[#CFAF42]" /> Job {pkg.jobNumber}
              <span className="text-[#9a9a9a]">· {pkg.client}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <CalendarRange className="h-4 w-4 text-[#CFAF42]" />
              {payPeriod(pkg.payPeriodStart, pkg.payPeriodEnd)}
            </span>
            <span className="flex items-center gap-1.5">
              <User className="h-4 w-4 text-[#CFAF42]" /> {pkg.workPlanCode}
            </span>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <ExportBar pkg={pkg} />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                data-testid="delete-package"
              >
                <Trash2 className="mr-1.5 h-4 w-4" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this package?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes the package, its timesheets, and any
                  attached documents. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-red-600 text-white hover:bg-red-700"
                  disabled={deletePackage.isPending}
                  onClick={() => void handleDelete()}
                  data-testid="confirm-delete-package"
                >
                  Delete package
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {summaryCards.map((card) => (
          <Card key={card.label}>
            <CardContent className="p-4">
              <p className="flex items-center justify-between text-[11px] uppercase tracking-wide text-[#9a9a9a]">
                {card.label}
                {"editableBudget" in card && card.editableBudget && (
                  <button
                    type="button"
                    aria-label="Edit budget"
                    className="text-[#9a9a9a] hover:text-[#333333]"
                    data-testid="edit-budget"
                    onClick={() => setBudgetOpen(true)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </p>
              <p className="mt-1 text-lg font-semibold text-[#333333]">
                {card.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <BudgetDialog packageId={id} open={budgetOpen} onOpenChange={setBudgetOpen} />

      {/* Tabs */}
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-gray-100/80 p-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="invoice">Invoice</TabsTrigger>
          <TabsTrigger value="subcalc">Sub Calc</TabsTrigger>
          <TabsTrigger value="labor">Labor Attachment</TabsTrigger>
          <TabsTrigger value="progress">Progress Report</TabsTrigger>
          <TabsTrigger value="timesheets">Timesheets</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewTab detail={detail} />
        </TabsContent>
        <TabsContent value="invoice" className="mt-6">
          <InvoiceTab detail={detail} />
        </TabsContent>
        <TabsContent value="subcalc" className="mt-6">
          <SubCalcTab detail={detail} />
        </TabsContent>
        <TabsContent value="progress" className="mt-6">
          <ProgressTab detail={detail} />
        </TabsContent>
        <TabsContent value="labor" className="mt-6">
          <LaborTab detail={detail} />
        </TabsContent>
        <TabsContent value="timesheets" className="mt-6">
          <TimesheetsTab detail={detail} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
