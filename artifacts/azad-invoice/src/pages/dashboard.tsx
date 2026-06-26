import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useListPackagesGrouped,
  type PackageSummary,
  type PackageEmployeeGroup,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
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
  Users,
  Briefcase,
  CalendarRange,
  Clock,
  FileStack,
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
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${
            PACKAGE_STATUS_STYLES[pkg.status] ?? PACKAGE_STATUS_STYLES.draft
          }`}
        >
          {pkg.status.replace("_", " ")}
        </span>
      </div>

      {pkg.invoiceNumber && (
        <p className="mt-1 text-xs text-[#5F5F5F]">Invoice {pkg.invoiceNumber}</p>
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
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const filtered = useMemo<PackageEmployeeGroup[]>(() => {
    if (!groups) return [];
    const q = search.trim().toLowerCase();

    const matchPkg = (pkg: PackageSummary, employeeName: string) => {
      if (statusFilter !== "all" && pkg.status !== statusFilter) return false;
      if (!q) return true;
      const haystack = [
        employeeName,
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
            packages: j.packages.filter((p) => matchPkg(p, g.employeeName)),
          }))
          .filter((j) => j.packages.length > 0),
      }))
      .filter((g) => g.jobs.length > 0);
  }, [groups, search, statusFilter]);

  const totals = useMemo(() => {
    let employees = 0;
    let packages = 0;
    let billed = 0;
    for (const g of filtered) {
      employees += 1;
      for (const j of g.jobs) {
        for (const p of j.packages) {
          packages += 1;
          billed += p.totalThisPeriod;
        }
      }
    }
    return { employees, packages, billed };
  }, [filtered]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight text-[#333333]">
          Packages
        </h1>
        <p className="text-sm text-[#5F5F5F]">
          Billing packages organized by employee, job number, and pay period.
        </p>
      </div>

      {/* Summary strip */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="flex items-center gap-3 p-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#CFAF42]/10 text-[#CFAF42]">
            <Users className="h-5 w-5" />
          </span>
          <div>
            <p className="text-xs text-[#5F5F5F]">Employees</p>
            <p className="text-xl font-semibold text-[#333333]">{totals.employees}</p>
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
            placeholder="Search employee, job number (A.04-02), or pay period…"
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
              : "Packages will appear here once they are created."}
          </p>
        </div>
      ) : (
        <Accordion
          type="multiple"
          defaultValue={filtered.map((g) => `emp-${g.employeeId}`)}
          className="space-y-3"
        >
          {filtered.map((group) => {
            const groupPackages = group.jobs.reduce(
              (n, j) => n + j.packages.length,
              0,
            );
            return (
              <AccordionItem
                key={group.employeeId}
                value={`emp-${group.employeeId}`}
                className="overflow-hidden rounded-xl border border-border bg-white"
              >
                <AccordionTrigger className="px-5 py-4 hover:no-underline">
                  <div className="flex flex-1 items-center justify-between pr-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#CFAF42]/15 text-sm font-semibold text-[#CFAF42]">
                        {group.employeeName
                          .split(" ")
                          .map((n) => n[0])
                          .slice(0, 2)
                          .join("")}
                      </span>
                      <div className="text-left">
                        <p className="text-base font-semibold text-[#333333]">
                          {group.employeeName}
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
                      <div key={job.workPlanId}>
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
