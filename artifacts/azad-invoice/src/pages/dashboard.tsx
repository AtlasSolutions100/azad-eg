import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  useListPackagesGrouped,
  useCreatePackage,
  useListWorkPlans,
  useListProcasProjects,
  getProcasBillingRates,
  listProcasWorkPlanEmployees,
  type ProcasWorkPlanEmployee,
  type PackageSummary,
  type PackageClientGroup,
  type PackageInput,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Search,
  Briefcase,
  CalendarRange,
  Clock,
  FileStack,
  Plus,
  AlertTriangle,
  Users,
  ChevronLeft,
  Loader2,
} from "lucide-react";
import { format } from "date-fns";
import {
  DOC_METAS,
  DOC_STATUS_STYLES,
  PACKAGE_STATUS_STYLES,
  formatCurrency,
  formatHours,
} from "@/lib/package-ui";

function periodLabel(start: string, end: string): string {
  try {
    const s = new Date(start);
    const e = new Date(end);
    const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
    return sameMonth
      ? `${format(s, "MMM d")} – ${format(e, "d, yyyy")}`
      : `${format(s, "MMM d")} – ${format(e, "MMM d, yyyy")}`;
  } catch {
    return `${start} – ${end}`;
  }
}

function DocStatusStrip({ pkg }: { pkg: PackageSummary }) {
  return (
    <div className="flex items-center gap-1.5">
      {DOC_METAS.map((doc) => {
        const status = pkg[doc.statusField];
        const style = DOC_STATUS_STYLES[status];
        return (
          <span
            key={doc.kind}
            title={`${doc.label}: ${style.label}`}
            className={`h-2 w-2 rounded-full ${style.dot}`}
          />
        );
      })}
    </div>
  );
}

function BudgetBadge({ pkg }: { pkg: PackageSummary }) {
  const status = pkg.budgetStatus;
  if (!status || status.level === "ok") return null;
  const over = status.level === "over";
  return (
    <span
      title={status.message}
      data-testid={`badge-budget-${pkg.id}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
        over
          ? "border-red-200 bg-red-50 text-red-700"
          : "border-yellow-200 bg-yellow-50 text-yellow-800"
      }`}
    >
      <AlertTriangle className="h-3 w-3" />
      {over ? "Over budget" : "Approaching budget"}
    </span>
  );
}

const BUDGET_LEVEL_STYLES: Record<
  string,
  { bar: string; text: string }
> = {
  ok: { bar: "bg-emerald-500", text: "text-[#5F5F5F]" },
  approaching: { bar: "bg-yellow-500", text: "text-yellow-800" },
  over: { bar: "bg-red-500", text: "text-red-700" },
};

function BudgetMeter({ pkg }: { pkg: PackageSummary }) {
  const status = pkg.budgetStatus;
  if (!status) return null;
  const style = BUDGET_LEVEL_STYLES[status.level] ?? BUDGET_LEVEL_STYLES.ok;
  const width = Math.max(0, Math.min(100, status.percentExpended));
  return (
    <div className="mt-3" data-testid={`budget-meter-${pkg.id}`} title={status.message}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-full rounded-full ${style.bar}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <div className={`mt-1 flex items-center justify-between text-[11px] font-medium ${style.text}`}>
        <span>{status.percentExpended}% of budget expended</span>
        <span>
          {status.remainingBalance < 0
            ? `${formatCurrency(Math.abs(status.remainingBalance))} over`
            : `${formatCurrency(status.remainingBalance)} left`}
        </span>
      </div>
    </div>
  );
}

function PackageTile({
  pkg,
  onOpen,
}: {
  pkg: PackageSummary;
  onOpen: () => void;
}) {
  const readyCount = DOC_METAS.filter(
    (d) => pkg[d.statusField] === "ready",
  ).length;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col rounded-xl border border-border bg-white p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#CFAF42]/50 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#333333]">
          <CalendarRange className="h-4 w-4 text-[#CFAF42]" />
          {periodLabel(pkg.payPeriodStart, pkg.payPeriodEnd)}
        </div>
        <span className="flex flex-wrap items-center justify-end gap-1">
          <BudgetBadge pkg={pkg} />
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${
              PACKAGE_STATUS_STYLES[pkg.status] ?? PACKAGE_STATUS_STYLES.draft
            }`}
          >
            {pkg.status.replace("_", " ")}
          </span>
        </span>
      </div>

      {pkg.invoiceNumber && (
        <p className="mt-1 text-xs text-[#5F5F5F]">Invoice {pkg.invoiceNumber}</p>
      )}

      {(pkg.owner || pkg.prime) && (
        <p
          className="mt-1 text-xs text-[#5F5F5F]"
          data-testid={`text-owner-prime-${pkg.id}`}
        >
          {pkg.owner && (
            <span>
              <span className="text-[#9a9a9a]">Owner</span>{" "}
              <span className="font-medium text-[#333333]">{pkg.owner}</span>
            </span>
          )}
          {pkg.owner && pkg.prime && <span className="mx-1.5 text-[#d0d0d0]">·</span>}
          {pkg.prime && (
            <span>
              <span className="text-[#9a9a9a]">Prime</span>{" "}
              <span className="font-medium text-[#333333]">{pkg.prime}</span>
            </span>
          )}
        </p>
      )}

      {(pkg.employees.length > 0 || pkg.employeeName) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {(pkg.employees.length > 0
            ? pkg.employees.map((e) => e.employeeName)
            : [pkg.employeeName as string]
          ).map((name) => (
            <span
              key={name}
              className="inline-flex items-center rounded-full bg-[#CFAF42]/10 px-2 py-0.5 text-[11px] font-medium text-[#8a7326]"
            >
              {name}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-[#9a9a9a]">Weeks</p>
          <p className="text-sm font-semibold text-[#333333]">{pkg.weekCount}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-[#9a9a9a]">Hours</p>
          <p className="text-sm font-semibold text-[#333333]">
            {formatHours(pkg.totalHours)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-[#9a9a9a]">This Period</p>
          <p className="text-sm font-semibold text-[#333333]">
            {formatCurrency(pkg.totalThisPeriod)}
          </p>
        </div>
      </div>

      <BudgetMeter pkg={pkg} />

      <div className="mt-4 flex items-center justify-between border-t border-dashed border-border pt-3">
        <DocStatusStrip pkg={pkg} />
        <span className="text-[11px] font-medium text-[#5F5F5F]">
          {readyCount}/5 docs ready
        </span>
      </div>
    </button>
  );
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { data: groups, isLoading, error } = useListPackagesGrouped();
  const { data: workPlans } = useListWorkPlans();
  const createPackage = useCreatePackage();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<Partial<PackageInput>>({
    invoiceDate: new Date().toISOString().split("T")[0],
  });
  // Wizard: 0 = Owner & Prime (one screen), 1 = Work Plan, 2 = Period & details.
  const [step, setStep] = useState(0);
  // Employees auto-detected from Procas for the selected work plan / job.
  const [detected, setDetected] = useState<ProcasWorkPlanEmployee[] | null>(null);
  const [detectLoading, setDetectLoading] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  // Multi-employee work plans need an explicit "continue" acknowledgement.
  const [multiConfirmed, setMultiConfirmed] = useState(false);
  // Manual fallback when the work plan / job is not in Procas yet.
  const [manualEntry, setManualEntry] = useState(false);
  // The full Procas library can be long — the wizard filters it client-side.
  const [wpSearch, setWpSearch] = useState("");

  // Procas projects power the "no work plan yet" path; the list only loads
  // when the create dialog is open (and quietly stays empty if Procas is
  // not connected — the user can still type a job number by hand).
  const { data: procasProjects } = useListProcasProjects({
    query: {
      enabled: createOpen,
      retry: false,
      queryKey: ["procas-projects"],
    },
  });
  const [ratesLoading, setRatesLoading] = useState(false);

  // Dropdown suggestions for Owner (government agencies) and Prime
  // (contractors Azad bills through). Known common values are merged with
  // anything already used on existing packages, and free typing still works.
  const OWNER_SUGGESTIONS = ["BART", "CalTrans"];
  const PRIME_SUGGESTIONS = ["AECOM", "WSP", "Parsons", "T.Y. Lin", "Azad (we are the prime)"];
  const { ownerOptions, primeOptions } = useMemo(() => {
    const owners = new Set(OWNER_SUGGESTIONS);
    const primes = new Set(PRIME_SUGGESTIONS);
    for (const g of groups ?? []) {
      for (const j of g.jobs) {
        for (const p of j.packages) {
          if (p.owner?.trim()) owners.add(p.owner.trim());
          if (p.prime?.trim()) primes.add(p.prime.trim());
        }
      }
    }
    return { ownerOptions: [...owners], primeOptions: [...primes] };
  }, [groups]);

  const filteredWizardPlans = useMemo(() => {
    if (!workPlans) return workPlans;
    const q = wpSearch.trim().toLowerCase();
    if (!q) return workPlans;
    return workPlans.filter(
      (wp) =>
        // Keep the currently selected plan visible so its label still renders.
        wp.id === form.workPlanId ||
        [wp.code, wp.title, wp.client, wp.jobNumber].some((v) =>
          v.toLowerCase().includes(q),
        ),
    );
  }, [workPlans, wpSearch, form.workPlanId]);

  // Guards against out-of-order responses when the user switches work plans
  // quickly: only the latest detection request may update state.
  const detectSeq = useRef(0);

  // The work plan drives everything downstream: picking one auto-detects the
  // employees who charged time to its Procas charge code — no manual
  // employee selection.
  const detectEmployees = async (project: string | null | undefined) => {
    const seq = ++detectSeq.current;
    setDetected(null);
    setDetectError(null);
    setMultiConfirmed(false);
    const p = project?.trim();
    if (!p) {
      setDetectError(
        "This work plan is not linked to a Procas charge code yet, so employees can't be auto-detected. They'll be added from timesheets instead.",
      );
      return;
    }
    setDetectLoading(true);
    try {
      const rows = await listProcasWorkPlanEmployees({ project: p });
      if (seq !== detectSeq.current) return;
      setDetected(rows);
    } catch (err) {
      if (seq !== detectSeq.current) return;
      setDetectError(
        err instanceof Error
          ? err.message
          : "Could not reach Procas to detect employees — they'll be added from timesheets instead.",
      );
    } finally {
      if (seq === detectSeq.current) setDetectLoading(false);
    }
  };

  const handleSelectWorkPlan = (val: string) => {
    if (val === "none") {
      setForm((f) => ({ ...f, workPlanId: undefined }));
      setDetected(null);
      setDetectError(null);
      setMultiConfirmed(false);
      return;
    }
    const wpId = Number(val);
    // Owner/Prime rarely change for a work plan: suggest the values from the
    // most recent package on this work plan, but never overwrite anything the
    // biller already typed.
    const latest = (groups ?? [])
      .flatMap((g) => g.jobs)
      .filter((j) => j.workPlanId === wpId)
      .flatMap((j) => j.packages)
      .reduce<PackageSummary | null>(
        (best, p) => (!best || p.createdAt > best.createdAt ? p : best),
        null,
      );
    setForm((f) => ({
      // Picking a real work plan clears the Procas-only fields, otherwise
      // stale hidden overrides would silently beat the work plan's rates.
      ...f,
      workPlanId: wpId,
      owner: f.owner?.trim() ? f.owner : latest?.owner ?? f.owner,
      prime: f.prime?.trim() ? f.prime : latest?.prime ?? f.prime,
      procasProject: undefined,
      clientName: undefined,
      fringeRate: undefined,
      overheadRate: undefined,
      fixedFeeRate: undefined,
      fccmRate: undefined,
      totalBudget: undefined,
    }));
    setManualEntry(false);
    const wp = workPlans?.find((w) => w.id === wpId);
    void detectEmployees(wp?.procasProject);
  };

  // When a Procas job is picked, pre-fill rates + client from Billing Setup.
  // Values land in the form fields so the user can override any of them.
  const handlePickProcasJob = async (project: string) => {
    setForm((f) => ({ ...f, procasProject: project }));
    setRatesLoading(true);
    try {
      const rates = await getProcasBillingRates({ project });
      setForm((f) => ({
        ...f,
        procasProject: project,
        fringeRate: rates.fringeRate ?? undefined,
        overheadRate: rates.overheadRate ?? undefined,
        fixedFeeRate: rates.fixedFeeRate ?? undefined,
        fccmRate: rates.fccmRate ?? undefined,
        clientName: rates.client ?? f.clientName,
      }));
    } catch {
      // No billing setup / Procas unreachable — the user enters rates by hand.
    } finally {
      setRatesLoading(false);
    }
    void detectEmployees(project);
  };

  const resetWizard = () => {
    setForm({ invoiceDate: new Date().toISOString().split("T")[0] });
    setStep(0);
    setDetected(null);
    setDetectError(null);
    setDetectLoading(false);
    setMultiConfirmed(false);
    setManualEntry(false);
    setWpSearch("");
  };

  // When the last step appears, the "Create Package" button lands exactly
  // where "Next" was — a double-click would create the package instantly with
  // the pre-filled dates and slam the dialog shut. Ignore submits that arrive
  // within a beat of entering step 3.
  const step3EnteredAt = useRef(0);

  const handleCreatePackage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (Date.now() - step3EnteredAt.current < 700) return;
    if (!form.workPlanId && !form.procasProject) return;
    if (!form.payPeriodStart || !form.payPeriodEnd) return;
    try {
      const res = await createPackage.mutateAsync({ data: form as PackageInput });
      setCreateOpen(false);
      resetWizard();
      setLocation(`/packages/${res.id}`);
    } catch (err) {
      console.error(err);
      toast({
        title: "Could not create package",
        description:
          err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleCreateOpenChange = (next: boolean) => {
    setCreateOpen(next);
    if (!next) resetWizard();
  };

  const filtered = useMemo<PackageClientGroup[]>(() => {
    if (!groups) return [];
    const q = search.trim().toLowerCase();

    const matchPkg = (pkg: PackageSummary) => {
      if (statusFilter !== "all" && pkg.status !== statusFilter) return false;
      if (!q) return true;
      const haystack = [
        pkg.employeeName ?? "",
        ...pkg.employees.map((e) => e.employeeName),
        pkg.jobNumber,
        pkg.workPlanCode,
        pkg.client,
        pkg.invoiceNumber ?? "",
        periodLabel(pkg.payPeriodStart, pkg.payPeriodEnd),
        pkg.payPeriodStart,
        pkg.payPeriodEnd,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    };

    return groups
      .map((g) => ({
        ...g,
        jobs: g.jobs
          .map((j) => ({
            ...j,
            packages: j.packages.filter((p) => matchPkg(p)),
          }))
          .filter((j) => j.packages.length > 0),
      }))
      .filter((g) => g.jobs.length > 0);
  }, [groups, search, statusFilter]);

  const totals = useMemo(() => {
    let jobs = 0;
    let packages = 0;
    let billed = 0;
    for (const g of filtered) {
      for (const j of g.jobs) {
        jobs += 1;
        for (const p of j.packages) {
          packages += 1;
          billed += p.totalThisPeriod;
        }
      }
    }
    return { clients: filtered.length, jobs, packages, billed };
  }, [filtered]);

  const createDialog = (
    <Dialog open={createOpen} onOpenChange={handleCreateOpenChange}>
      <DialogTrigger asChild>
        <Button className="bg-[#CFAF42] hover:bg-[#CFAF42]/90 text-white">
          <Plus className="mr-2 h-4 w-4" />
          New Package
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Package</DialogTitle>
          <p className="text-xs text-[#9a9a9a]">
            Step {step + 1} of 3 —{" "}
            {["Owner & Prime", "Work Plan", "Pay Period & Details"][step]}
          </p>
        </DialogHeader>
        <form onSubmit={handleCreatePackage} className="space-y-4">
          {step === 0 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Owner</Label>
                <Input
                  autoFocus
                  list="owner-suggestions"
                  placeholder="Pick or type the owner / agency, e.g. BART"
                  value={form.owner || ""}
                  onChange={(e) => setForm({ ...form, owner: e.target.value })}
                />
                <datalist id="owner-suggestions">
                  {ownerOptions.map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
                <p className="text-xs text-[#5F5F5F]">
                  The government agency the work ultimately belongs to (e.g.
                  BART, CalTrans). Leave blank if not known yet.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Prime</Label>
                <Input
                  list="prime-suggestions"
                  placeholder="Pick or type the prime, e.g. T.Y. Lin"
                  value={form.prime || ""}
                  onChange={(e) => setForm({ ...form, prime: e.target.value })}
                />
                <datalist id="prime-suggestions">
                  {primeOptions.map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
                <p className="text-xs text-[#5F5F5F]">
                  The prime contractor this package bills through (AECOM, WSP,
                  Parsons, T.Y. Lin…). Azad is usually the sub; if Azad is the
                  prime on this contract, choose “Azad (we are the prime)”.
                </p>
              </div>
            </div>
          )}
          {step === 1 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Work Plan</Label>
                <Input
                  placeholder="Type to filter the work plan list…"
                  value={wpSearch}
                  onChange={(e) => setWpSearch(e.target.value)}
                />
                <Select
                  value={form.workPlanId ? String(form.workPlanId) : undefined}
                  onValueChange={handleSelectWorkPlan}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick the work plan that drives this package" />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredWizardPlans?.length === 0 && (
                      <div className="px-3 py-2 text-sm text-[#9a9a9a]">
                        No work plans match “{wpSearch}”.
                      </div>
                    )}
                    {filteredWizardPlans?.map((wp) => (
                      <SelectItem key={wp.id} value={String(wp.id)}>
                        {wp.code} - {wp.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-[#5F5F5F]">
                  The work plan number pulls from Procas and drives rates
                  automatically from Billing Setup.
                </p>
              </div>
              {!form.workPlanId && (
                <button
                  type="button"
                  className="text-xs font-medium text-[#8a7326] underline underline-offset-2"
                  onClick={() => setManualEntry((m) => !m)}
                >
                  {manualEntry
                    ? "Hide manual entry"
                    : "Work plan not in Procas yet? Enter it manually"}
                </button>
              )}
              {!form.workPlanId && manualEntry && (
                <div className="space-y-4 rounded-md border border-dashed border-border bg-gray-50/60 p-3">
                  <div className="space-y-2">
                    <Label>Procas Job Number</Label>
                    {procasProjects && procasProjects.length > 0 ? (
                      <Select
                        value={form.procasProject || undefined}
                        onValueChange={handlePickProcasJob}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Pick the Procas job to bill against" />
                        </SelectTrigger>
                        <SelectContent>
                          {procasProjects.map((p) => (
                            <SelectItem key={p.project} value={p.project}>
                              {p.project}
                              {p.description ? ` — ${p.description}` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        placeholder="e.g. 22-1234"
                        value={form.procasProject || ""}
                        onChange={(e) =>
                          setForm({ ...form, procasProject: e.target.value })
                        }
                        onBlur={(e) => {
                          // Manual entry must run the same employee
                          // detection (and multi-employee gate) as the
                          // select path.
                          const v = e.target.value.trim();
                          if (v) void detectEmployees(v);
                        }}
                      />
                    )}
                    <p className="text-xs text-[#5F5F5F]">
                      {ratesLoading
                        ? "Pulling billing rates from Procas…"
                        : "Rates below pull from Procas Billing Setup — edit any of them if needed."}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Client (optional)</Label>
                    <Input
                      value={form.clientName || ""}
                      onChange={(e) =>
                        setForm({ ...form, clientName: e.target.value })
                      }
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    {(
                      [
                        ["Overhead %", "overheadRate"],
                        ["Fixed Fee %", "fixedFeeRate"],
                        ["FCCM %", "fccmRate"],
                        ["Fringe %", "fringeRate"],
                      ] as const
                    ).map(([label, field]) => (
                      <div key={field} className="space-y-2">
                        <Label>{label}</Label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={form[field] ?? ""}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              [field]:
                                e.target.value === ""
                                  ? undefined
                                  : Number(e.target.value),
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {(form.workPlanId || form.procasProject) && (
                <div className="space-y-2 rounded-md border border-border bg-gray-50/60 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-[#5F5F5F]">
                    <Users className="h-3.5 w-3.5" />
                    Employees charged to this work plan (from Procas)
                  </p>
                  {detectLoading ? (
                    <p className="flex items-center gap-1.5 text-xs text-[#9a9a9a]">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Detecting employees from Procas…
                    </p>
                  ) : detectError ? (
                    <p className="text-xs text-[#8a7326]">{detectError}</p>
                  ) : detected && detected.length === 0 ? (
                    <p className="text-xs text-[#9a9a9a]">
                      No time has been charged to this work plan in the last 12
                      months. Employees will be added when hours are pulled.
                    </p>
                  ) : detected ? (
                    <ul className="space-y-1">
                      {detected.map((d) => (
                        <li
                          key={d.name}
                          className="flex items-center justify-between text-sm text-[#333333]"
                        >
                          <span>{d.name}</span>
                          <span className="text-xs text-[#9a9a9a]">
                            {formatHours(d.hours)} hrs
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )}
              {detected && detected.length > 1 && (
                <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
                  <p className="flex items-start gap-1.5 text-sm text-amber-800">
                    <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                    {detected.length} employees are associated with this work
                    plan — continue?
                  </p>
                  {!multiConfirmed ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="border-amber-400 text-amber-800 hover:bg-amber-100"
                      onClick={() => setMultiConfirmed(true)}
                    >
                      Yes, continue with {detected.length} employees
                    </Button>
                  ) : (
                    <p className="text-xs text-amber-700">
                      Confirmed — all {detected.length} employees will be
                      included when hours are pulled.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          {step === 2 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Pay Period Start</Label>
                  <Input
                    type="date"
                    required
                    value={form.payPeriodStart || ""}
                    onChange={(e) =>
                      setForm({ ...form, payPeriodStart: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Pay Period End</Label>
                  <Input
                    type="date"
                    required
                    value={form.payPeriodEnd || ""}
                    onChange={(e) =>
                      setForm({ ...form, payPeriodEnd: e.target.value })
                    }
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Invoice Number (optional)</Label>
                  <Input
                    value={form.invoiceNumber || ""}
                    onChange={(e) =>
                      setForm({ ...form, invoiceNumber: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Invoice Date (optional)</Label>
                  <Input
                    type="date"
                    value={form.invoiceDate || ""}
                    onChange={(e) =>
                      setForm({ ...form, invoiceDate: e.target.value })
                    }
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Prepared By (optional)</Label>
                <Input
                  value={form.preparedBy || ""}
                  onChange={(e) =>
                    setForm({ ...form, preparedBy: e.target.value })
                  }
                />
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            {step > 0 ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep((s) => s - 1)}
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Back
              </Button>
            ) : (
              <span />
            )}
            {step < 2 ? (
              <Button
                type="button"
                className="bg-[#CFAF42] hover:bg-[#CFAF42]/90 text-white"
                disabled={
                  step === 1 &&
                  ((!form.workPlanId && !form.procasProject) ||
                    detectLoading ||
                    (!!detected && detected.length > 1 && !multiConfirmed))
                }
                onClick={() => {
                  // BART bills whole months: entering the final step
                  // pre-fills the pay period with the current full month.
                  // Both dates stay editable for overrides.
                  if (step === 1) {
                    if (!form.payPeriodStart && !form.payPeriodEnd) {
                      const now = new Date();
                      const first = new Date(now.getFullYear(), now.getMonth(), 1);
                      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                      const iso = (d: Date) =>
                        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
                      setForm((f) => ({ ...f, payPeriodStart: iso(first), payPeriodEnd: iso(last) }));
                    }
                    step3EnteredAt.current = Date.now();
                  }
                  setStep((s) => s + 1);
                }}
              >
                Next
              </Button>
            ) : (
              <Button
                type="submit"
                className="bg-[#CFAF42] hover:bg-[#CFAF42]/90 text-white"
                disabled={
                  createPackage.isPending ||
                  (!form.workPlanId && !form.procasProject) ||
                  !form.payPeriodStart ||
                  !form.payPeriodEnd
                }
              >
                {createPackage.isPending ? "Creating…" : "Create Package"}
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight text-[#333333]">
            Packages
          </h1>
          <p className="text-sm text-[#5F5F5F]">
            Billing packages organized by client, job number, and pay period.
          </p>
        </div>
        {createDialog}
      </div>

      {/* Summary strip */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="flex items-center gap-3 p-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#CFAF42]/10 text-[#CFAF42]">
            <Briefcase className="h-5 w-5" />
          </span>
          <div>
            <p className="text-xs text-[#5F5F5F]">Jobs</p>
            <p className="text-xl font-semibold text-[#333333]">{totals.jobs}</p>
          </div>
        </Card>
        <Card className="flex items-center gap-3 p-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#CFAF42]/10 text-[#CFAF42]">
            <FileStack className="h-5 w-5" />
          </span>
          <div>
            <p className="text-xs text-[#5F5F5F]">Packages</p>
            <p className="text-xl font-semibold text-[#333333]">{totals.packages}</p>
          </div>
        </Card>
        <Card className="flex items-center gap-3 p-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#CFAF42]/10 text-[#CFAF42]">
            <Clock className="h-5 w-5" />
          </span>
          <div>
            <p className="text-xs text-[#5F5F5F]">Billed this view</p>
            <p className="text-xl font-semibold text-[#333333]">
              {formatCurrency(totals.billed)}
            </p>
          </div>
        </Card>
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search client, employee, job number (A.04-02), or pay period…"
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="in_review">In Review</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="exported">Exported</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-600">
          Failed to load packages.
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-white p-12 text-center">
          <FileStack className="mx-auto h-10 w-10 text-gray-300" />
          <p className="mt-3 text-sm font-medium text-[#333333]">No packages found</p>
          <p className="text-xs text-[#5F5F5F]">
            {search || statusFilter !== "all"
              ? "Try adjusting your search or filters."
              : "Create a package to generate invoices and export the document bundle."}
          </p>
          {!search && statusFilter === "all" && (
            <div className="mt-4 flex justify-center">
              <Button
                onClick={() => setCreateOpen(true)}
                className="bg-[#CFAF42] hover:bg-[#CFAF42]/90 text-white"
              >
                <Plus className="mr-2 h-4 w-4" />
                New Package
              </Button>
            </div>
          )}
        </div>
      ) : (
        <Accordion
          type="multiple"
          defaultValue={filtered.map((g) => `client-${g.client}`)}
          className="space-y-3"
        >
          {filtered.map((group) => {
            const groupPackages = group.jobs.reduce(
              (n, j) => n + j.packages.length,
              0,
            );
            return (
              <AccordionItem
                key={group.client}
                value={`client-${group.client}`}
                className="overflow-hidden rounded-xl border border-border bg-white"
              >
                <AccordionTrigger className="px-5 py-4 hover:no-underline">
                  <div className="flex flex-1 items-center justify-between pr-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#CFAF42]/15 text-sm font-semibold text-[#CFAF42]">
                        {group.client
                          .split(" ")
                          .map((n) => n[0])
                          .slice(0, 2)
                          .join("")}
                      </span>
                      <div className="text-left">
                        <p className="text-base font-semibold text-[#333333]">
                          {group.client}
                        </p>
                        <p className="text-xs text-[#5F5F5F]">
                          {group.jobs.length} job
                          {group.jobs.length === 1 ? "" : "s"} · {groupPackages}{" "}
                          package{groupPackages === 1 ? "" : "s"}
                        </p>
                      </div>
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="border-t border-border bg-gray-50/60 px-5 py-4">
                  <div className="space-y-5">
                    {group.jobs.map((job) => (
                      <div key={job.workPlanId ? `wp-${job.workPlanId}` : `job-${job.jobNumber}`}>
                        <div className="mb-3 flex items-center gap-2">
                          <Briefcase className="h-4 w-4 text-[#5F5F5F]" />
                          <span className="font-mono text-sm font-semibold text-[#333333]">
                            {job.jobNumber}
                          </span>
                          <span className="text-xs text-[#5F5F5F]">
                            {job.workPlanCode} · {job.client}
                          </span>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                          {job.packages.map((pkg) => (
                            <PackageTile
                              key={pkg.id}
                              pkg={pkg}
                              onOpen={() => setLocation(`/packages/${pkg.id}`)}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      )}
    </div>
  );
}
