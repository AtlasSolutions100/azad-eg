import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { 
  useGetInvoice, 
  useListLineItems, 
  useGetInvoicePreview, 
  useGetInvoiceValidations, 
  useGetProgressReport, 
  useListSignatures,
  useImportTimeData,
  useSyncTimesheetsFromProcas,
  useGetProcasStatus,
  useSaveProgressReport,
  useApproveInvoice,
  useUnpinInvoiceCarryOver,
  useDismissImportWarnings,
  useGenerateInvoiceFile,
  useCreateLineItem,
  useUpdateLineItem,
  useDeleteLineItem,
  useListEmployees,
  TimeImportUploadSource,
  GenerateInputFormat,
  ProgressReportInput,
  LineItemInput,
  ApiError
} from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, Trash2, Edit, AlertTriangle, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import BudgetOverrideHistory from "@/components/budget-override-history";
import { usePagedAuditLogs } from "@/hooks/use-paged-audit-logs";
import { Loader2 } from "lucide-react";

function sourceBadge(source?: string) {
  if (source === "manual" || !source) {
    return <Badge variant="outline" className="border-slate-300 text-slate-700" data-testid={`badge-source-manual`}>Manual</Badge>;
  }
  if (source.startsWith("procas")) {
    return <Badge variant="secondary" className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100" data-testid={`badge-source-procas`}>Procas</Badge>;
  }
  return <Badge variant="secondary" className="bg-blue-100 text-blue-800 hover:bg-blue-100" data-testid={`badge-source-timesheet`}>Timesheet</Badge>;
}

export default function InvoiceDetail() {
  const { id } = useParams();
  const invoiceId = Number(id);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [exportingFormat, setExportingFormat] = useState<GenerateInputFormat | null>(null);

  const { data: invoice, isLoading: invLoading } = useGetInvoice(invoiceId);
  const { data: lineItems } = useListLineItems(invoiceId);
  const { data: preview } = useGetInvoicePreview(invoiceId);
  const { data: validations } = useGetInvoiceValidations(invoiceId);
  const { data: progressReport } = useGetProgressReport(invoiceId);
  const { data: signatures } = useListSignatures();
  const { data: employees } = useListEmployees();
  const {
    logs: auditLogs,
    hasNextPage: hasMoreAuditLogs,
    isFetchingNextPage: isFetchingMoreAuditLogs,
    fetchNextPage: fetchMoreAuditLogs,
  } = usePagedAuditLogs({ entityType: "invoice", entityId: invoiceId });

  // Surface when this invoice's carry-over ("previously billed") was
  // automatically recalculated because an upstream invoice on the same work
  // plan changed. The most recent such audit entry is shown as a notice.
  const carryOverNotice = auditLogs?.find(
    (log) => log.action === "carry-over recalculated",
  );

  const importTime = useImportTimeData();
  const syncProcas = useSyncTimesheetsFromProcas();
  const { data: procasStatus } = useGetProcasStatus();
  const saveProgress = useSaveProgressReport();
  const approveInvoice = useApproveInvoice();
  const unpinCarryOver = useUnpinInvoiceCarryOver();
  const dismissWarnings = useDismissImportWarnings();
  const generateFile = useGenerateInvoiceFile();
  const createLineItem = useCreateLineItem();
  const updateLineItem = useUpdateLineItem();
  const deleteLineItem = useDeleteLineItem();

  const [importSource, setImportSource] = useState<TimeImportUploadSource>('procas');
  const [importFile, setImportFile] = useState<File | null>(null);

  const [reportData, setReportData] = useState<Partial<ProgressReportInput>>({});

  // Warnings from a rejected upload or Procas sync (HTTP 4xx/502) are only
  // known client-side, so they're kept in local state; successful imports
  // persist their warnings on the invoice server-side, where they survive
  // navigation and reloads until a new import replaces them or the biller
  // dismisses them.
  const [failedImportWarnings, setFailedImportWarnings] = useState<string[]>([]);
  const persistedImportWarnings = invoice?.importWarnings ?? [];
  const importWarnings =
    failedImportWarnings.length > 0 ? failedImportWarnings : persistedImportWarnings;

  // Over-budget approval requires an explicit, audited override.
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  // Line item modal state
  const [liOpen, setLiOpen] = useState(false);
  const [liEditId, setLiEditId] = useState<number | null>(null);
  const [liFormData, setLiFormData] = useState<Partial<LineItemInput>>({
    category: 'regular',
    location: 'home'
  });

  useEffect(() => {
    if (progressReport) {
      setReportData({
        percentComplete: progressReport.percentComplete,
        summary: progressReport.summary,
        workCompleted: progressReport.workCompleted || "",
        workPlanned: progressReport.workPlanned || "",
        issues: progressReport.issues || "",
        scheduleStatus: progressReport.scheduleStatus || "",
        budgetStatus: progressReport.budgetStatus || "",
        reportDate: progressReport.reportDate,
      });
    }
  }, [progressReport]);

  const handleImport = async () => {
    if (!importFile) return;
    try {
      const result = await importTime.mutateAsync({
        id: invoiceId,
        data: { source: importSource, file: importFile }
      });
      queryClient.invalidateQueries();
      // A successful import persists its warnings server-side; drop any local
      // warnings from a previously rejected upload so they don't mask them.
      setFailedImportWarnings([]);
      const replaced = result.replacedCount ?? 0;
      toast({
        title: "Time data imported",
        description:
          `${result.importedCount} line item(s) imported for this period.` +
          (replaced > 0 ? ` Replaced ${replaced} previously imported row(s).` : ""),
      });
    } catch (e) {
      console.error(e);
      // A rejected upload (HTTP 400) carries { error, warnings } in the body.
      // Surface both so the user knows exactly why every row was skipped,
      // rather than a generic failure message.
      let description =
        e instanceof Error ? e.message : "Could not import the uploaded file.";
      let warnings: string[] = [];
      if (e instanceof ApiError && e.data && typeof e.data === "object") {
        const body = e.data as { error?: unknown; warnings?: unknown };
        if (typeof body.error === "string" && body.error.trim()) {
          description = body.error;
        }
        if (Array.isArray(body.warnings)) {
          warnings = body.warnings.filter((w): w is string => typeof w === "string");
        }
      }
      setFailedImportWarnings(warnings);
      if (warnings.length > 0) {
        description += ` ${warnings.length} warning(s) — see details below the import form.`;
      }
      toast({
        title: "Import failed",
        description,
        variant: "destructive",
      });
    }
  };

  const handleDismissWarnings = async () => {
    // Warnings from a rejected upload only exist client-side; nothing was
    // persisted, so just clear the local state without an API call.
    if (persistedImportWarnings.length === 0) {
      setFailedImportWarnings([]);
      return;
    }
    try {
      await dismissWarnings.mutateAsync({ id: invoiceId });
      setFailedImportWarnings([]);
      queryClient.invalidateQueries();
      toast({
        title: "Warnings dismissed",
        description: "The import warnings were cleared and the dismissal was recorded in the activity log.",
      });
    } catch (e) {
      console.error(e);
      toast({
        title: "Could not dismiss warnings",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleProcasSync = async () => {
    try {
      const result = await syncProcas.mutateAsync({ id: invoiceId });
      queryClient.invalidateQueries();
      // A successful sync persists its warnings server-side; drop any local
      // warnings from a previously rejected import/sync so they don't mask them.
      setFailedImportWarnings([]);
      const replaced = result.replacedCount ?? 0;
      toast({
        title: "Synced from Procas",
        description:
          `${result.importedCount} line item(s) pulled for this period.` +
          (replaced > 0 ? ` Replaced ${replaced} previously imported row(s).` : ""),
      });
    } catch (e) {
      console.error(e);
      // A rejected sync (HTTP 400/409/502) carries { error, warnings? } in the
      // body. Surface the API's reason (and any row-level warnings) so the
      // user knows exactly why the sync failed, not just a generic failure.
      let description =
        e instanceof Error ? e.message : "Could not pull timesheets from Procas.";
      let warnings: string[] = [];
      if (e instanceof ApiError && e.data && typeof e.data === "object") {
        const body = e.data as { error?: unknown; warnings?: unknown };
        if (typeof body.error === "string" && body.error.trim()) {
          description = body.error;
        }
        if (Array.isArray(body.warnings)) {
          warnings = body.warnings.filter((w): w is string => typeof w === "string");
        }
      }
      setFailedImportWarnings(warnings);
      if (warnings.length > 0) {
        description += ` ${warnings.length} warning(s) — see details below the import form.`;
      }
      toast({
        title: "Procas sync failed",
        description,
        variant: "destructive",
      });
    }
  };

  const handleSaveProgress = async () => {
    try {
      await saveProgress.mutateAsync({
        id: invoiceId,
        data: {
          percentComplete: reportData.percentComplete || 0,
          summary: reportData.summary || "",
          workCompleted: reportData.workCompleted,
          workPlanned: reportData.workPlanned,
          issues: reportData.issues,
          scheduleStatus: reportData.scheduleStatus,
          budgetStatus: reportData.budgetStatus,
          reportDate: reportData.reportDate || new Date().toISOString().split('T')[0],
        }
      });
      queryClient.invalidateQueries();
    } catch (e) {
      console.error(e);
    }
  };

  const submitApproval = async (budgetOverride: boolean, reason?: string) => {
    const signature = signatures?.find(s => s.isDefault);
    if (!signature) {
      alert("No default signature found. Please add one in Signatures.");
      return;
    }
    try {
      await approveInvoice.mutateAsync({
        id: invoiceId,
        data: {
          approvedBy: signature.name,
          signatureId: signature.id,
          ...(budgetOverride ? { budgetOverride: true, budgetOverrideReason: reason || undefined } : {}),
        },
      });
      queryClient.invalidateQueries();
      setOverrideOpen(false);
      setOverrideReason("");
      toast({ title: "Invoice approved" });
    } catch (e) {
      console.error(e);
      toast({
        variant: "destructive",
        title: "Approval failed",
        description: e instanceof Error ? e.message : "Could not approve this invoice.",
      });
    }
  };

  const handleApprove = () => {
    // An over-budget invoice cannot be approved without an explicit override
    // that gets recorded in the audit log — prompt for confirmation first.
    if (preview?.budgetStatus?.overBudget) {
      setOverrideOpen(true);
      return;
    }
    submitApproval(false);
  };

  const handleExport = async (format: GenerateInputFormat) => {
    setExportingFormat(format);
    toast({
      title: `Generating ${format.toUpperCase()}`,
      description: "Building the invoice file. This can take a few seconds.",
    });
    try {
      const res = await generateFile.mutateAsync({
        id: invoiceId,
        data: { format }
      });
      window.open(res.url, '_blank');
      toast({
        title: `${format.toUpperCase()} ready`,
        description: "Your invoice file has been generated.",
      });
    } catch (e) {
      console.error(e);
      toast({
        variant: "destructive",
        title: `Failed to generate ${format.toUpperCase()}`,
        description: "Something went wrong while building the file.",
      });
    } finally {
      setExportingFormat(null);
    }
  };

  const handleLiOpenCreate = () => {
    setLiEditId(null);
    setLiFormData({ category: 'regular', location: 'home' });
    setLiOpen(true);
  };

  const handleLiOpenEdit = (item: any) => {
    setLiEditId(item.id);
    setLiFormData({
      employeeId: item.employeeId,
      employeeName: item.employeeName,
      classification: item.classification,
      category: item.category,
      location: item.location,
      hours: item.hours,
      rate: item.rate,
      taskNo: item.taskNo,
      notes: item.notes,
    });
    setLiOpen(true);
  };

  const handleLiSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (liEditId) {
        await updateLineItem.mutateAsync({ 
          id: liEditId, 
          data: liFormData 
        });
      } else {
        await createLineItem.mutateAsync({ 
          id: invoiceId, 
          data: liFormData as LineItemInput 
        });
      }
      setLiOpen(false);
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  // Removes a manually-set "previously billed" pin so the amount re-derives
  // from the preceding billed invoice and cascades to later invoices.
  const handleUnpinCarryOver = async () => {
    if (!confirm("Remove the manually-set previously-billed amount? It will be recalculated from the prior billed invoice, and later invoices will update too.")) return;
    try {
      await unpinCarryOver.mutateAsync({ id: invoiceId });
      queryClient.invalidateQueries();
      toast({ title: "Carry-over unpinned", description: "Previously billed now follows the invoice chain again." });
    } catch (err) {
      console.error(err);
      toast({ title: "Could not unpin carry-over", description: err instanceof Error ? err.message : "Something went wrong.", variant: "destructive" });
    }
  };

  const handleLiDelete = async (id: number) => {
    if (!confirm("Are you sure you want to delete this line item?")) return;
    try {
      await deleteLineItem.mutateAsync({ id });
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  const handleEmployeeSelect = (empIdStr: string) => {
    const empId = Number(empIdStr);
    const emp = employees?.find(e => e.id === empId);
    if (emp) {
      setLiFormData({
        ...liFormData,
        employeeId: emp.id,
        employeeName: emp.name,
        classification: emp.classification,
        rate: liFormData.location === 'field' && emp.fieldRate ? emp.fieldRate : emp.homeRate,
        taskNo: emp.defaultTaskNo || undefined
      });
    }
  };

  if (invLoading) {
    return <div className="p-8"><Skeleton className="h-10 w-1/3 mb-4" /><Skeleton className="h-[500px] w-full" /></div>;
  }

  if (!invoice) return <div>Invoice not found.</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-[#333333]">
            Invoice {invoice.invoiceNumber}
          </h1>
          <p className="text-[#5F5F5F]">
            {invoice.client} - {invoice.workPlanCode} | {invoice.status.replace('_', ' ').toUpperCase()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {invoice.status === 'draft' && (
            <Button variant="outline" onClick={handleApprove} disabled={approveInvoice.isPending || (validations && !validations.isValid)}>
              Approve
            </Button>
          )}
          <Button variant="outline" onClick={() => handleExport('pdf')} disabled={generateFile.isPending}>
            <Download className="mr-2 h-4 w-4" /> {exportingFormat === 'pdf' ? 'Generating...' : 'PDF'}
          </Button>
          <Button variant="outline" onClick={() => handleExport('xlsx')} disabled={generateFile.isPending}>
            <FileSpreadsheet className="mr-2 h-4 w-4" /> {exportingFormat === 'xlsx' ? 'Generating...' : 'Excel'}
          </Button>
        </div>
      </div>

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
                {preview?.budgetStatus?.message} Remaining balance: $
                {(preview?.budgetStatus?.remainingBalance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.
                {" "}Approving will record a budget override in the audit log.
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
                disabled={approveInvoice.isPending || !overrideReason.trim()}
              >
                {approveInvoice.isPending ? "Approving..." : "Override & Approve"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="grid gap-6 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-[#5F5F5F]">Total This Period</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">${invoice.totalThisPeriod.toLocaleString()}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[#5F5F5F] flex items-center gap-2">
              Previously Billed
              {invoice.carryOverManual && (
                <Badge variant="secondary" className="bg-amber-100 text-amber-800 hover:bg-amber-100" data-testid="badge-carryover-pinned">
                  Manually set
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-previously-billed">${invoice.previouslyBilled.toLocaleString()}</div>
            {invoice.carryOverManual && (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 mt-1 text-xs text-blue-600"
                onClick={handleUnpinCarryOver}
                disabled={unpinCarryOver.isPending}
                data-testid="button-unpin-carryover"
              >
                {unpinCarryOver.isPending ? "Unpinning..." : "Unpin & recalculate from prior invoices"}
              </Button>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-[#5F5F5F]">Total to Date</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">${invoice.totalToDate.toLocaleString()}</div></CardContent>
        </Card>
        <Card className={preview?.budgetStatus.overBudget ? "border-red-300" : ""}>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-[#5F5F5F]">Remaining Balance</CardTitle></CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${preview?.budgetStatus.overBudget ? "text-red-600" : ""}`}>${invoice.remainingBalance.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">{invoice.percentExpended.toFixed(1)}% expended</p>
          </CardContent>
        </Card>
      </div>

      {carryOverNotice && (
        <Alert className="border-blue-200 bg-blue-50">
          <Info className="h-4 w-4 text-blue-600" />
          <AlertTitle className="text-blue-800">Carry-over auto-updated</AlertTitle>
          <AlertDescription className="text-blue-700">
            {carryOverNotice.description} Updated by {carryOverNotice.userName} on{" "}
            {new Date(carryOverNotice.createdAt).toLocaleString()}.
          </AlertDescription>
        </Alert>
      )}

      <BudgetOverrideHistory entityType="invoice" entityId={invoiceId} />

      {preview?.budgetStatus && preview.budgetStatus.level !== "ok" && (
        <Alert
          variant={preview.budgetStatus.level === "over" ? "destructive" : "default"}
          className={preview.budgetStatus.level === "over" ? "border-red-300 bg-red-50" : "border-yellow-200 bg-yellow-50"}
        >
          {preview.budgetStatus.level === "over" ? (
            <AlertTriangle className="h-4 w-4" />
          ) : (
            <Info className="h-4 w-4 text-yellow-600" />
          )}
          <AlertTitle className={preview.budgetStatus.level === "over" ? "" : "text-yellow-800"}>
            {preview.budgetStatus.level === "over" ? "Over budget" : "Approaching budget limit"}
          </AlertTitle>
          <AlertDescription className={preview.budgetStatus.level === "over" ? "" : "text-yellow-700"}>
            {preview.budgetStatus.message} Remaining balance: $
            {preview.budgetStatus.remainingBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.
            {preview.budgetStatus.level === "over" && " Review line items before approving this invoice."}
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="preview" className="w-full">
        <TabsList>
          <TabsTrigger value="preview">Preview & Financials</TabsTrigger>
          <TabsTrigger value="line-items">Line Items</TabsTrigger>
          <TabsTrigger value="import">Time Import</TabsTrigger>
          <TabsTrigger value="progress">Progress Report</TabsTrigger>
          <TabsTrigger value="validations">Validations</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        
        <TabsContent value="preview" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Financial Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableBody>
                  {preview?.financials.map((line, i) => (
                    <TableRow key={i} className={line.emphasis ? "font-bold bg-gray-50" : ""}>
                      <TableCell>{line.label}</TableCell>
                      <TableCell className="text-right">${line.amount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">{line.note || ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="line-items" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Line Items</CardTitle>
                <CardDescription>Labor and expenses billed this period.</CardDescription>
              </div>
              <Button size="sm" className="bg-[#CFAF42] hover:bg-[#CFAF42]/90 text-white" onClick={handleLiOpenCreate}>Add Item</Button>
            </CardHeader>
            <CardContent>
              <Dialog open={liOpen} onOpenChange={setLiOpen}>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>{liEditId ? "Edit Line Item" : "Create Line Item"}</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={handleLiSubmit} className="grid grid-cols-2 gap-4">
                    <div className="space-y-2 col-span-2">
                      <Label>Employee Profile (Optional)</Label>
                      <Select value={liFormData.employeeId?.toString() || ""} onValueChange={handleEmployeeSelect}>
                        <SelectTrigger><SelectValue placeholder="Select to autofill..." /></SelectTrigger>
                        <SelectContent>
                          {employees?.map(e => (
                            <SelectItem key={e.id} value={e.id.toString()}>{e.name} ({e.classification})</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Employee Name</Label>
                      <Input required value={liFormData.employeeName || ''} onChange={e => setLiFormData({...liFormData, employeeName: e.target.value})} />
                    </div>
                    <div className="space-y-2">
                      <Label>Classification</Label>
                      <Input required value={liFormData.classification || ''} onChange={e => setLiFormData({...liFormData, classification: e.target.value})} />
                    </div>
                    <div className="space-y-2">
                      <Label>Category</Label>
                      <Select value={liFormData.category} onValueChange={(val: any) => setLiFormData({...liFormData, category: val})}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="regular">Regular</SelectItem>
                          <SelectItem value="ot">Overtime</SelectItem>
                          <SelectItem value="dt">Double Time</SelectItem>
                          <SelectItem value="holiday">Holiday</SelectItem>
                          <SelectItem value="pto">PTO</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Location</Label>
                      <Select value={liFormData.location} onValueChange={(val: any) => {
                        setLiFormData({...liFormData, location: val});
                        // optionally auto update rate if employee is selected
                      }}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="home">Home</SelectItem>
                          <SelectItem value="field">Field</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Hours</Label>
                      <Input required type="number" step="0.25" value={liFormData.hours || ''} onChange={e => setLiFormData({...liFormData, hours: Number(e.target.value)})} />
                    </div>
                    <div className="space-y-2">
                      <Label>Rate</Label>
                      <Input required type="number" step="0.01" value={liFormData.rate || ''} onChange={e => setLiFormData({...liFormData, rate: Number(e.target.value)})} />
                    </div>
                    <div className="space-y-2 col-span-2">
                      <Label>Task No.</Label>
                      <Input value={liFormData.taskNo || ''} onChange={e => setLiFormData({...liFormData, taskNo: e.target.value})} />
                    </div>
                    <div className="space-y-2 col-span-2">
                      <Label>Notes</Label>
                      <Input value={liFormData.notes || ''} onChange={e => setLiFormData({...liFormData, notes: e.target.value})} />
                    </div>
                    <div className="col-span-2 pt-4 flex justify-end">
                      <Button type="submit" className="bg-[#CFAF42] text-white">
                        {createLineItem.isPending || updateLineItem.isPending ? "Saving..." : "Save"}
                      </Button>
                    </div>
                  </form>
                </DialogContent>
              </Dialog>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Class</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Hours</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lineItems?.map(item => (
                    <TableRow key={item.id}>
                      <TableCell>
                        {item.employeeName}
                        {item.taskNo && <span className="block text-xs text-muted-foreground">{item.taskNo}</span>}
                      </TableCell>
                      <TableCell>{item.classification}</TableCell>
                      <TableCell className="capitalize">{item.category} ({item.location})</TableCell>
                      <TableCell>{sourceBadge(item.source)}</TableCell>
                      <TableCell className="text-right">{item.hours}</TableCell>
                      <TableCell className="text-right">${item.rate.toFixed(2)}</TableCell>
                      <TableCell className="text-right font-medium">${item.amount.toLocaleString(undefined, {minimumFractionDigits: 2})}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" onClick={() => handleLiOpenEdit(item)}>
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleLiDelete(item.id)}>
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {(!lineItems || lineItems.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center h-24 text-muted-foreground">No line items.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="import" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Import Time Data</CardTitle>
              <CardDescription>
                Pull live from Procas, or upload Procas/Timesheet files to generate line items.
                Re-importing replaces rows marked Procas or Timesheet; rows marked Manual are kept.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {procasStatus?.connected && (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4">
                  <p className="text-sm font-semibold text-emerald-800">Live Procas Connection</p>
                  <p className="mt-1 text-xs text-emerald-700">
                    Pull timesheets directly from Procas for this invoice's billing period
                    {invoice ? ` (${invoice.periodStart} → ${invoice.periodEnd})` : ""}.
                  </p>
                  <Button
                    onClick={handleProcasSync}
                    disabled={syncProcas.isPending}
                    className="mt-3 bg-emerald-600 text-white hover:bg-emerald-700"
                  >
                    {syncProcas.isPending ? "Syncing..." : "Sync from Procas"}
                  </Button>
                </div>
              )}
              <div className="space-y-2">
                <Label>Source</Label>
                <Select value={importSource} onValueChange={(val: any) => setImportSource(val)}>
                  <SelectTrigger className="w-[200px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="procas">Procas</SelectItem>
                    <SelectItem value="timesheet">Timesheet</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>File</Label>
                <Input type="file" accept=".xlsx,.xls,.csv" onChange={e => setImportFile(e.target.files?.[0] || null)} />
              </div>
              <Button onClick={handleImport} disabled={!importFile || importTime.isPending} className="bg-[#CFAF42] text-white">
                {importTime.isPending ? "Importing..." : "Upload & Import"}
              </Button>
              {importWarnings.length > 0 && (
                <Alert className="border-yellow-200 bg-yellow-50" data-testid="import-warnings">
                  <AlertTriangle className="h-4 w-4 text-yellow-600" />
                  <AlertTitle className="text-yellow-800">
                    Import warnings
                    {invoice?.lastImportAt && (
                      <span className="ml-1 font-normal" data-testid="import-warnings-context">
                        — from{" "}
                        {invoice.lastImportSource === "procas"
                          ? "Procas sync"
                          : invoice.lastImportSource === "procas-scheduled"
                            ? "scheduled Procas sync"
                            : "file upload"}{" "}
                        on {new Date(invoice.lastImportAt).toLocaleString()}
                      </span>
                    )}
                  </AlertTitle>
                  <AlertDescription className="text-yellow-700">
                    <ul className="list-disc pl-4">
                      {importWarnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 border-yellow-300 bg-white text-yellow-800 hover:bg-yellow-100"
                      onClick={handleDismissWarnings}
                      disabled={dismissWarnings.isPending}
                      data-testid="dismiss-import-warnings"
                    >
                      {dismissWarnings.isPending ? "Dismissing..." : "Dismiss"}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="progress" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Progress Report</CardTitle>
              <CardDescription>Required narrative for the billing period.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Percent Complete (%)</Label>
                  <Input type="number" min="0" max="100" value={reportData.percentComplete || 0} onChange={e => setReportData({...reportData, percentComplete: Number(e.target.value)})} />
                </div>
                <div className="space-y-2">
                  <Label>Report Date</Label>
                  <Input type="date" value={reportData.reportDate || ''} onChange={e => setReportData({...reportData, reportDate: e.target.value})} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Summary of Work</Label>
                <Textarea rows={3} value={reportData.summary || ''} onChange={e => setReportData({...reportData, summary: e.target.value})} />
              </div>
              <div className="space-y-2">
                <Label>Work Completed This Period</Label>
                <Textarea rows={3} value={reportData.workCompleted || ''} onChange={e => setReportData({...reportData, workCompleted: e.target.value})} />
              </div>
              <div className="space-y-2">
                <Label>Work Planned Next Period</Label>
                <Textarea rows={3} value={reportData.workPlanned || ''} onChange={e => setReportData({...reportData, workPlanned: e.target.value})} />
              </div>
              <Button onClick={handleSaveProgress} disabled={saveProgress.isPending} className="bg-[#CFAF42] text-white">
                {saveProgress.isPending ? "Saving..." : "Save Progress Report"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="validations" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Invoice Validations</CardTitle>
              <CardDescription>System checks and potential issues.</CardDescription>
            </CardHeader>
            <CardContent>
              {validations?.isValid ? (
                <Alert className="bg-green-50 border-green-200">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <AlertTitle className="text-green-800">All checks passed</AlertTitle>
                  <AlertDescription className="text-green-700">Invoice is ready for approval.</AlertDescription>
                </Alert>
              ) : (
                <div className="space-y-3">
                  {validations?.flags.map((flag, i) => (
                    <Alert key={i} variant={flag.severity === 'error' ? 'destructive' : 'default'} className={
                      flag.severity === 'warning' ? 'bg-yellow-50 border-yellow-200' : 
                      flag.severity === 'info' ? 'bg-blue-50 border-blue-200' : ''
                    }>
                      {flag.severity === 'error' && <AlertCircle className="h-4 w-4" />}
                      {flag.severity === 'warning' && <AlertTriangle className="h-4 w-4 text-yellow-600" />}
                      {flag.severity === 'info' && <Info className="h-4 w-4 text-blue-600" />}
                      <AlertTitle className={`capitalize ${
                        flag.severity === 'warning' ? 'text-yellow-800' : 
                        flag.severity === 'info' ? 'text-blue-800' : ''
                      }`}>{flag.severity}</AlertTitle>
                      <AlertDescription className={
                        flag.severity === 'warning' ? 'text-yellow-700' : 
                        flag.severity === 'info' ? 'text-blue-700' : ''
                      }>
                        {flag.field ? <span className="font-semibold mr-1">{flag.field}:</span> : null}
                        {flag.message}
                      </AlertDescription>
                    </Alert>
                  ))}
                  {(!validations?.flags || validations.flags.length === 0) && (
                    <p className="text-muted-foreground">No validation data available.</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
              <CardDescription>Full audit history for this invoice, most recent first.</CardDescription>
            </CardHeader>
            <CardContent>
              {auditLogs && auditLogs.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">When</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>User</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {auditLogs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {new Date(log.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="font-medium capitalize">{log.action}</TableCell>
                        <TableCell className="text-muted-foreground">{log.description}</TableCell>
                        <TableCell>{log.userName}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-muted-foreground">No activity recorded for this invoice yet.</p>
              )}
              {hasMoreAuditLogs ? (
                <div className="mt-4 flex justify-center">
                  <Button
                    variant="outline"
                    onClick={() => fetchMoreAuditLogs()}
                    disabled={isFetchingMoreAuditLogs}
                    data-testid="button-load-more-activity"
                  >
                    {isFetchingMoreAuditLogs ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading…
                      </>
                    ) : (
                      "Load older entries"
                    )}
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
