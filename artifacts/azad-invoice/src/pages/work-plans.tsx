import { useEffect, useMemo, useState } from "react";
import { useListWorkPlans, useCreateWorkPlan, useUpdateWorkPlan, useDeleteWorkPlan, useListPackages, useListProcasProjects, useSyncWorkPlansFromProcas, getListPackagesQueryKey, WorkPlanInput, WorkPlanUpdate } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Edit, RefreshCw, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function WorkPlans() {
  const { data: plans, isLoading } = useListWorkPlans();
  const { data: procasProjects } = useListProcasProjects();
  const createPlan = useCreateWorkPlan();
  const updatePlan = useUpdateWorkPlan();
  const deletePlan = useDeleteWorkPlan();
  const syncFromProcas = useSyncWorkPlansFromProcas();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");

  // The Procas library can be long — filter by any visible column so Julie
  // can find the right plan quickly.
  const filteredPlans = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return plans;
    return plans?.filter((p) =>
      [p.code, p.title, p.client, p.jobNumber, p.procasProject ?? ""].some((v) =>
        v.toLowerCase().includes(q),
      ),
    );
  }, [plans, search]);

  const handleSyncFromProcas = async () => {
    try {
      const result = await syncFromProcas.mutateAsync();
      queryClient.invalidateQueries();
      toast({
        title: "Work plans refreshed from Procas",
        description: `${result.created} new plan(s) added, ${result.updated} refreshed — ${result.total} projects in the Procas library.`,
      });
    } catch (err) {
      toast({
        title: "Couldn't refresh from Procas",
        description: err instanceof Error ? err.message : "Check the Procas connection and try again.",
        variant: "destructive",
      });
    }
  };

  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [formData, setFormData] = useState<Partial<WorkPlanInput>>({ billingCycle: 'whole_month' });
  const [prevBilledTotal, setPrevBilledTotal] = useState<number | undefined>(undefined);
  const [prevBilledEdited, setPrevBilledEdited] = useState(false);

  // Pre-fill the calculator's previously-billed total from the plan's latest
  // package (the same previouslyBilled the export uses). Billers can override.
  const { data: planPackages } = useListPackages(
    { workPlanId: editId ?? undefined },
    { query: { enabled: open && editId != null, queryKey: getListPackagesQueryKey({ workPlanId: editId ?? undefined }) } },
  );
  useEffect(() => {
    if (!open || editId == null || prevBilledEdited || !planPackages?.length) return;
    const latest = [...planPackages].sort((a, b) =>
      (a.payPeriodEnd ?? "").localeCompare(b.payPeriodEnd ?? "") || a.id - b.id,
    )[planPackages.length - 1];
    if (latest?.previouslyBilled != null) setPrevBilledTotal(latest.previouslyBilled);
  }, [open, editId, prevBilledEdited, planPackages]);

  const handleOpenCreate = () => {
    setEditId(null);
    setFormData({ billingCycle: 'whole_month' });
    setPrevBilledTotal(undefined);
    setPrevBilledEdited(false);
    setOpen(true);
  };

  // Mirrors the export's back-solve (masterWorkbook decompose): the total is
  // T = L·(1+OH)·(1+fee) + L·FCCM, with rounding residue folded into the fee
  // row so the four categories sum exactly to the total.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const decompose = (total: number) => {
    const oh = (formData.overheadRate ?? 0) / 100;
    const fee = (formData.fixedFeeRate ?? 0) / 100;
    const fccm = (formData.fccmRate ?? 0) / 100;
    const divisor = (1 + oh) * (1 + fee) + fccm;
    const labor = round2(divisor > 0 ? total / divisor : total);
    const overhead = round2(labor * oh);
    const fccmRow = round2(labor * fccm);
    const fixedFee = round2(total - labor - overhead - fccmRow);
    return { labor, overhead, fixedFee, fccm: fccmRow };
  };

  const handleCalculateSplit = () => {
    const breakdownFields = [
      formData.budgetLabor, formData.budgetOverhead, formData.budgetFixedFee, formData.budgetFccm,
      formData.prevBilledLabor, formData.prevBilledOverhead, formData.prevBilledFixedFee, formData.prevBilledFccm,
    ];
    const hasExistingValues = breakdownFields.some(v => v !== undefined && v !== null);
    if (hasExistingValues && !confirm("This will overwrite the breakdown values you've already entered. Replace them with calculated amounts?")) return;
    const budget = decompose(formData.totalBudget ?? 0);
    const prev = decompose(prevBilledTotal ?? 0);
    setFormData({
      ...formData,
      budgetLabor: budget.labor,
      budgetOverhead: budget.overhead,
      budgetFixedFee: budget.fixedFee,
      budgetFccm: budget.fccm,
      prevBilledLabor: prev.labor,
      prevBilledOverhead: prev.overhead,
      prevBilledFixedFee: prev.fixedFee,
      prevBilledFccm: prev.fccm,
    });
  };

  const handleOpenEdit = (plan: any) => {
    setEditId(plan.id);
    setFormData({
      code: plan.code,
      title: plan.title,
      client: plan.client,
      jobNumber: plan.jobNumber,
      agreementNo: plan.agreementNo ?? undefined,
      poNumber: plan.poNumber ?? undefined,
      wspProjectNo: plan.wspProjectNo ?? undefined,
      procasProject: plan.procasProject ?? undefined,
      totalBudget: plan.totalBudget,
      budgetLabor: plan.budgetLabor ?? undefined,
      budgetOverhead: plan.budgetOverhead ?? undefined,
      budgetFixedFee: plan.budgetFixedFee ?? undefined,
      budgetFccm: plan.budgetFccm ?? undefined,
      prevBilledLabor: plan.prevBilledLabor ?? undefined,
      prevBilledOverhead: plan.prevBilledOverhead ?? undefined,
      prevBilledFixedFee: plan.prevBilledFixedFee ?? undefined,
      prevBilledFccm: plan.prevBilledFccm ?? undefined,
      fringeRate: plan.fringeRate ?? undefined,
      overheadRate: plan.overheadRate ?? undefined,
      fixedFeeRate: plan.fixedFeeRate ?? undefined,
      fccmRate: plan.fccmRate ?? undefined,
      maxBillRate: plan.maxBillRate ?? undefined,
      billingCycle: plan.billingCycle,
      supplierId: plan.supplierId ?? undefined,
      clientProjectNo: plan.clientProjectNo ?? undefined,
      sendToCompany: plan.sendToCompany ?? undefined,
      sendToAddress1: plan.sendToAddress1 ?? undefined,
      sendToAddress2: plan.sendToAddress2 ?? undefined,
      contactPerson: plan.contactPerson ?? undefined,
      bartProjectNumbers: plan.bartProjectNumbers ?? undefined,
      terms: plan.terms ?? undefined,
    });
    setPrevBilledTotal(undefined);
    setPrevBilledEdited(false);
    setOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editId) {
        await updatePlan.mutateAsync({ id: editId, data: formData as WorkPlanUpdate });
      } else {
        await createPlan.mutateAsync({ data: formData as WorkPlanInput });
      }
      setOpen(false);
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Are you sure you want to delete this work plan?")) return;
    try {
      await deletePlan.mutateAsync({ id });
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight text-[#333333]">Work Plans</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={handleSyncFromProcas}
            disabled={syncFromProcas.isPending}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${syncFromProcas.isPending ? "animate-spin" : ""}`} />
            {syncFromProcas.isPending ? "Refreshing…" : "Refresh from Procas"}
          </Button>
          <Button onClick={handleOpenCreate} className="bg-[#CFAF42] hover:bg-[#CFAF42]/90 text-white">
            Add Work Plan
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9a9a9a]" />
          <Input
            className="pl-8"
            placeholder="Search by code, title, client, or job number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {!isLoading && plans && (
          <span className="whitespace-nowrap text-sm text-[#9a9a9a]">
            {filteredPlans?.length ?? 0} of {plans.length} work plans
          </span>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit Work Plan" : "Create Work Plan"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Code</Label>
              <Input required value={formData.code || ''} onChange={e => setFormData({...formData, code: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Title</Label>
              <Input required value={formData.title || ''} onChange={e => setFormData({...formData, title: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Client</Label>
              <Input required value={formData.client || ''} onChange={e => setFormData({...formData, client: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Job Number</Label>
              <Input required value={formData.jobNumber || ''} onChange={e => setFormData({...formData, jobNumber: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Total Budget</Label>
              <Input required type="number" step="0.01" value={formData.totalBudget || ''} onChange={e => setFormData({...formData, totalBudget: Number(e.target.value)})} />
            </div>
            <div className="space-y-2">
              <Label>Billing Cycle</Label>
              <Select value={formData.billingCycle} onValueChange={(val: any) => setFormData({...formData, billingCycle: val})}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="whole_month">Whole Month</SelectItem>
                  <SelectItem value="last_friday">Last Friday</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Agreement No</Label>
              <Input value={formData.agreementNo || ''} onChange={e => setFormData({...formData, agreementNo: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>PO Number</Label>
              <Input value={formData.poNumber || ''} onChange={e => setFormData({...formData, poNumber: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>WSP Project No</Label>
              <Input value={formData.wspProjectNo || ''} onChange={e => setFormData({...formData, wspProjectNo: e.target.value})} />
            </div>
            <div className="space-y-2 col-span-2">
              <Label>Procas Project (for pulling labor hours)</Label>
              <Input
                list="procas-projects"
                placeholder={procasProjects ? "Type to search Procas projects…" : "Connect Procas to load projects"}
                value={formData.procasProject || ''}
                onChange={e => setFormData({...formData, procasProject: e.target.value === '' ? null : e.target.value.split(' — ')[0].trim()})}
              />
              <datalist id="procas-projects">
                {(procasProjects ?? []).map(p => (
                  <option key={p.project} value={p.project}>{`${p.project} — ${p.description}`}</option>
                ))}
              </datalist>
              <p className="text-xs text-[#5F5F5F]">Timesheet hours booked under this Procas project (including its sub-tasks) can be pulled into billing packages.</p>
            </div>
            <div className="col-span-2 border-t pt-4">
              <p className="text-sm font-medium text-[#333333]">Burden rates (drive Fringe, Overhead, Fixed Fee &amp; FCCM in every document)</p>
              <p className="text-xs text-[#5F5F5F]">Enter as percentages, e.g. 120.58 for 120.58%.</p>
            </div>
            <div className="space-y-2">
              <Label>Fringe Rate (%)</Label>
              <Input type="number" step="0.01" placeholder="120.58" value={formData.fringeRate ?? ''} onChange={e => setFormData({...formData, fringeRate: e.target.value === '' ? undefined : Number(e.target.value)})} />
            </div>
            <div className="space-y-2">
              <Label>Overhead Rate (%)</Label>
              <Input type="number" step="0.01" value={formData.overheadRate ?? ''} onChange={e => setFormData({...formData, overheadRate: e.target.value === '' ? undefined : Number(e.target.value)})} />
            </div>
            <div className="space-y-2">
              <Label>Fixed Fee Rate (%)</Label>
              <Input type="number" step="0.01" placeholder="8" value={formData.fixedFeeRate ?? ''} onChange={e => setFormData({...formData, fixedFeeRate: e.target.value === '' ? undefined : Number(e.target.value)})} />
            </div>
            <div className="space-y-2">
              <Label>FCCM Rate (%)</Label>
              <Input type="number" step="0.01" value={formData.fccmRate ?? ''} onChange={e => setFormData({...formData, fccmRate: e.target.value === '' ? undefined : Number(e.target.value)})} />
            </div>
            <div className="space-y-2">
              <Label>Max Bill Rate ($/hr)</Label>
              <Input type="number" step="0.01" placeholder="e.g. 115 — leave blank for no cap" value={formData.maxBillRate ?? ''} onChange={e => setFormData({...formData, maxBillRate: e.target.value === '' ? undefined : Number(e.target.value)})} />
            </div>
            <div className="col-span-2 border-t pt-4">
              <p className="text-sm font-medium text-[#333333]">Budget breakdown by cost category (optional)</p>
              <p className="text-xs text-[#5F5F5F]">Splits the Sub Calc budget and previously-billed columns across labor, overhead, fixed fee, and FCCM rows exactly as entered. Leave blank to let the export calculate the split from the totals.</p>
            </div>
            <div className="col-span-2 flex items-end gap-3">
              <div className="space-y-2 flex-1">
                <Label>Previously Billed Total ($) — used only by the calculator</Label>
                <Input type="number" step="0.01" value={prevBilledTotal ?? ''} onChange={e => { setPrevBilledEdited(true); setPrevBilledTotal(e.target.value === '' ? undefined : Number(e.target.value)); }} />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={handleCalculateSplit}
                disabled={!formData.totalBudget}
              >
                Calculate from rates
              </Button>
            </div>
            {([
              ["budgetLabor", "Budget — Labor"],
              ["budgetOverhead", "Budget — Overhead"],
              ["budgetFixedFee", "Budget — Fixed Fee"],
              ["budgetFccm", "Budget — FCCM"],
              ["prevBilledLabor", "Prev. Billed — Labor"],
              ["prevBilledOverhead", "Prev. Billed — Overhead"],
              ["prevBilledFixedFee", "Prev. Billed — Fixed Fee"],
              ["prevBilledFccm", "Prev. Billed — FCCM"],
            ] as const).map(([field, label]) => (
              <div key={field} className="space-y-2">
                <Label>{label} ($)</Label>
                <Input type="number" step="0.01" value={formData[field] ?? ''} onChange={e => setFormData({...formData, [field]: e.target.value === '' ? undefined : Number(e.target.value)})} />
              </div>
            ))}
            <div className="col-span-2 border-t pt-4">
              <p className="text-sm font-medium text-[#333333]">Invoice cover header (printed on the client invoice)</p>
              <p className="text-xs text-[#5F5F5F]">Supplier, remit-to, and project references shown on the cover page.</p>
            </div>
            <div className="space-y-2">
              <Label>Supplier ID</Label>
              <Input value={formData.supplierId || ''} onChange={e => setFormData({...formData, supplierId: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Client Project No</Label>
              <Input value={formData.clientProjectNo || ''} onChange={e => setFormData({...formData, clientProjectNo: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Send To — Company</Label>
              <Input value={formData.sendToCompany || ''} onChange={e => setFormData({...formData, sendToCompany: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Contact Person</Label>
              <Input value={formData.contactPerson || ''} onChange={e => setFormData({...formData, contactPerson: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Send To — Address Line 1</Label>
              <Input value={formData.sendToAddress1 || ''} onChange={e => setFormData({...formData, sendToAddress1: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Send To — Address Line 2</Label>
              <Input value={formData.sendToAddress2 || ''} onChange={e => setFormData({...formData, sendToAddress2: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>BART Project Numbers</Label>
              <Input value={formData.bartProjectNumbers || ''} onChange={e => setFormData({...formData, bartProjectNumbers: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Payment Terms</Label>
              <Input placeholder="Net 30 Days" value={formData.terms || ''} onChange={e => setFormData({...formData, terms: e.target.value})} />
            </div>
            <div className="col-span-2 pt-4 flex justify-end">
              <Button type="submit" className="bg-[#CFAF42] text-white">
                {createPlan.isPending || updatePlan.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <div className="rounded-md border bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Job Number</TableHead>
              <TableHead className="text-right">Budget</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : filteredPlans?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  {search.trim()
                    ? "No work plans match your search."
                    : "No work plans yet — use “Refresh from Procas” to pull the full library."}
                </TableCell>
              </TableRow>
            ) : (
              filteredPlans?.map((plan) => (
                <TableRow key={plan.id}>
                  <TableCell className="font-medium">{plan.code}</TableCell>
                  <TableCell>{plan.title}</TableCell>
                  <TableCell>{plan.client}</TableCell>
                  <TableCell>{plan.jobNumber}</TableCell>
                  <TableCell className="text-right">${plan.totalBudget.toLocaleString()}</TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      plan.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                    }`}>
                      {plan.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => handleOpenEdit(plan)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(plan.id)}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
