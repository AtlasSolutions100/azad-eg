import { useState } from "react";
import {
  useCreatePackageWeek,
  useCreateTimesheetEntry,
  useUpdateTimesheetEntry,
  useDeleteTimesheetEntry,
  usePullPackageHoursFromProcas,
  useFillPackagePtoTo40,
  useListEmployees,
  type PackageDetail,
  type TimesheetEntry,
  type TimesheetEntryInput,
  type TimesheetCategory,
  type TimesheetEntryInputLocation,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { AlertTriangle, CalendarCheck, CalendarPlus, DownloadCloud, Edit, Loader2, Plus, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { formatCurrency, formatHours } from "@/lib/package-ui";

const DAYS: { key: keyof TimesheetEntryInput; short: string }[] = [
  { key: "hoursMon", short: "Mon" },
  { key: "hoursTue", short: "Tue" },
  { key: "hoursWed", short: "Wed" },
  { key: "hoursThu", short: "Thu" },
  { key: "hoursFri", short: "Fri" },
  { key: "hoursSat", short: "Sat" },
  { key: "hoursSun", short: "Sun" },
];

const CATEGORIES: TimesheetCategory[] = ["regular", "ot", "dt", "night", "holiday", "pto"];

function weekDateRange(start: string, end: string): string {
  try {
    return `${format(new Date(start), "MMM d")} – ${format(new Date(end), "MMM d, yyyy")}`;
  } catch {
    return `${start} – ${end}`;
  }
}

export default function TimesheetsTab({ detail }: { detail: PackageDetail }) {
  const { package: pkg, weeks, entries } = detail;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: employees } = useListEmployees();
  const createWeek = useCreatePackageWeek();
  const createEntry = useCreateTimesheetEntry();
  const updateEntry = useUpdateTimesheetEntry();
  const deleteEntry = useDeleteTimesheetEntry();
  const pullProcasHours = usePullPackageHoursFromProcas();

  const pullFromProcas = async () => {
    try {
      const result = await pullProcasHours.mutateAsync({ id: pkg.id });
      queryClient.invalidateQueries();
      const parts = [`${result.importedCount} entries imported`];
      if (result.weeksCreated > 0) parts.push(`${result.weeksCreated} weeks created`);
      toast({
        title: "Hours pulled from Procas",
        description:
          parts.join(", ") +
          (result.warnings.length > 0 ? `. ${result.warnings.join(" ")}` : ""),
      });
    } catch (err) {
      const message =
        err && typeof err === "object" && "error" in err && typeof err.error === "string"
          ? err.error
          : "Could not pull hours from Procas.";
      toast({ variant: "destructive", title: "Procas pull failed", description: message });
    }
  };

  // Tops each short weekday up to a full day with a single PTO/Sick row.
  // Always previewed first: a timesheet is a certified document, so the biller
  // confirms the hours before they land.
  const fillPto = useFillPackagePtoTo40();
  const runFillPto = async () => {
    try {
      const preview = await fillPto.mutateAsync({ id: pkg.id, data: { preview: true } });
      if (preview.hoursAdded === 0 && preview.rowsRemoved === 0) {
        toast({
          title: "Nothing to fill",
          description: preview.warnings.join(" ") || "Every weekday is already a full day.",
        });
        return;
      }
      const lines = preview.weeks
        .map((w) => `${w.weekLabel} — ${w.employeeName}: +${formatHours(w.hoursAdded)} hrs`)
        .join("\n");
      const staleNote =
        preview.rowsRemoved > 0
          ? `\n${preview.rowsRemoved} stale auto-fill row(s) will be removed.`
          : "";
      if (
        !confirm(
          `Add ${formatHours(preview.hoursAdded)} PTO/Sick hours so each weekday reaches a full day?\n\n${lines}${staleNote}\n\nPTO bills at $0, so the invoice total does not change.`,
        )
      )
        return;

      const result = await fillPto.mutateAsync({ id: pkg.id, data: {} });
      queryClient.invalidateQueries();
      toast({
        title: "Timesheet filled to a standard week",
        description: `${result.rowsCreated} row(s) added, ${result.rowsUpdated} updated${
          result.rowsRemoved > 0 ? `, ${result.rowsRemoved} removed` : ""
        } — ${formatHours(result.hoursAdded)} PTO/Sick hours.`,
      });
    } catch (err) {
      const message =
        err && typeof err === "object" && "error" in err && typeof err.error === "string"
          ? err.error
          : "Could not fill the timesheet.";
      toast({ variant: "destructive", title: "Fill to 40 hours failed", description: message });
    }
  };

  // Week dialog
  const [weekOpen, setWeekOpen] = useState(false);
  const [weekForm, setWeekForm] = useState({ label: "", weekStart: "", weekEnd: "" });

  // Entry dialog
  const [entryOpen, setEntryOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [entryForm, setEntryForm] = useState<Partial<TimesheetEntryInput>>({});

  const sortedWeeks = weeks.slice().sort((a, b) => a.sortOrder - b.sortOrder);

  const submitWeek = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!weekForm.label || !weekForm.weekStart || !weekForm.weekEnd) return;
    try {
      await createWeek.mutateAsync({
        id: pkg.id,
        data: {
          label: weekForm.label,
          weekStart: weekForm.weekStart,
          weekEnd: weekForm.weekEnd,
          sortOrder: weeks.length,
        },
      });
      queryClient.invalidateQueries();
      setWeekOpen(false);
      setWeekForm({ label: "", weekStart: "", weekEnd: "" });
    } catch {
      toast({ variant: "destructive", title: "Failed to add week" });
    }
  };

  const openCreateEntry = (weekId: number) => {
    setEditId(null);
    setEntryForm({
      weekId,
      category: "regular",
      location: "home",
      employeeName: "",
      classification: "",
    });
    setEntryOpen(true);
  };

  const openEditEntry = (entry: TimesheetEntry) => {
    setEditId(entry.id);
    setEntryForm({
      weekId: entry.weekId,
      employeeId: entry.employeeId ?? undefined,
      employeeName: entry.employeeName,
      classification: entry.classification,
      category: entry.category,
      location: entry.location,
      hoursMon: entry.hoursMon,
      hoursTue: entry.hoursTue,
      hoursWed: entry.hoursWed,
      hoursThu: entry.hoursThu,
      hoursFri: entry.hoursFri,
      hoursSat: entry.hoursSat,
      hoursSun: entry.hoursSun,
      rate: entry.rate,
      taskNo: entry.taskNo ?? undefined,
      notes: entry.notes ?? undefined,
    });
    setEntryOpen(true);
  };

  // Billing rate effective for the given date: the employee's base rates
  // apply before the earliest rate change; from a change's effective date
  // (inclusive) onward that change's rates apply. Mirrors the server logic so
  // a mid-period rate change auto-fills the right rate per week.
  const effectiveRateFor = (
    emp: NonNullable<typeof employees>[number],
    location: string | undefined,
    dateISO: string | undefined,
  ): number => {
    let homeRate = emp.homeRate;
    let fieldRate = emp.fieldRate ?? emp.homeRate;
    if (dateISO) {
      let best: { effectiveDate: string; homeRate: number; fieldRate?: number | null } | null = null;
      for (const rc of emp.rateChanges ?? []) {
        if (rc.effectiveDate > dateISO) continue;
        if (!best || rc.effectiveDate >= best.effectiveDate) best = rc;
      }
      if (best) {
        homeRate = best.homeRate;
        fieldRate = best.fieldRate ?? best.homeRate;
      }
    }
    return location === "field" ? fieldRate : homeRate;
  };

  const onEmployeeSelect = (idStr: string) => {
    const emp = employees?.find((e) => e.id === Number(idStr));
    if (emp) {
      setEntryForm((f) => {
        const week = weeks.find((w) => w.id === f.weekId);
        return {
          ...f,
          employeeId: emp.id,
          employeeName: emp.name,
          classification: emp.classification,
          rate: effectiveRateFor(emp, f.location, week?.weekStart),
          taskNo: emp.defaultTaskNo || f.taskNo,
        };
      });
    }
  };

  const submitEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!entryForm.weekId || !entryForm.employeeName || !entryForm.classification)
      return;
    try {
      if (editId) {
        await updateEntry.mutateAsync({
          id: pkg.id,
          entryId: editId,
          data: entryForm,
        });
      } else {
        await createEntry.mutateAsync({
          id: pkg.id,
          data: entryForm as TimesheetEntryInput,
        });
      }
      queryClient.invalidateQueries();
      setEntryOpen(false);
    } catch {
      toast({ variant: "destructive", title: "Failed to save entry" });
    }
  };

  const removeEntry = async (entryId: number) => {
    if (!confirm("Delete this timesheet entry?")) return;
    try {
      await deleteEntry.mutateAsync({ id: pkg.id, entryId });
      queryClient.invalidateQueries();
    } catch {
      toast({ variant: "destructive", title: "Failed to delete entry" });
    }
  };

  const unapprovedHours = pkg.unapprovedHours ?? 0;

  return (
    <div className="space-y-6">
      {unapprovedHours > 0 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
          <div>
            <p className="font-semibold">
              {formatHours(unapprovedHours)} hours are not yet approved in Procas
            </p>
            <p className="mt-0.5 text-red-700">
              Unapproved hours are shown in red below. Only approved hours should be
              exported — re-pull from Procas once the timesheets are approved, or
              confirm the override when generating the final invoice.
            </p>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <p className="text-sm text-[#5F5F5F]">
          Weekly timesheets backing the labor detail. Add weeks and per-employee
          entries.
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="bg-[#1B4D3E] text-white hover:bg-[#163f33]"
            onClick={pullFromProcas}
            disabled={pullProcasHours.isPending}
          >
            {pullProcasHours.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <DownloadCloud className="mr-2 h-4 w-4" />
            )}
            Pull Hours from Procas
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={runFillPto}
            disabled={fillPto.isPending || weeks.length === 0}
            title="Top each short weekday up to 8 hours with a combined PTO/Sick row. PTO bills at $0."
          >
            {fillPto.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CalendarCheck className="mr-2 h-4 w-4" />
            )}
            Fill to 40 Hours
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setWeekForm({ label: `Week ${weeks.length + 1}`, weekStart: "", weekEnd: "" });
              setWeekOpen(true);
            }}
          >
            <CalendarPlus className="mr-2 h-4 w-4" /> Add Week
          </Button>
        </div>
      </div>

      {sortedWeeks.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-white p-10 text-center text-sm text-[#5F5F5F]">
          No weeks yet. Add a week to start entering timesheets.
        </div>
      )}

      {sortedWeeks.map((week) => {
        const wkEntries = entries.filter((e) => e.weekId === week.id);
        return (
          <Card key={week.id}>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base">{week.label}</CardTitle>
                <p className="text-xs text-[#5F5F5F]">
                  {weekDateRange(week.weekStart, week.weekEnd)}
                </p>
              </div>
              <Button
                size="sm"
                className="bg-[#CFAF42] text-white hover:bg-[#bd9e36]"
                onClick={() => openCreateEntry(week.id)}
              >
                <Plus className="mr-1.5 h-4 w-4" /> Add Entry
              </Button>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Class</TableHead>
                    <TableHead>Cat</TableHead>
                    <TableHead>Loc</TableHead>
                    {DAYS.map((d) => (
                      <TableHead key={d.key} className="text-right">
                        {d.short}
                      </TableHead>
                    ))}
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-[72px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wkEntries.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={13}
                        className="h-16 text-center text-muted-foreground"
                      >
                        No entries for this week.
                      </TableCell>
                    </TableRow>
                  ) : (
                    wkEntries.map((entry) => (
                      <TableRow
                        key={entry.id}
                        className={
                          entry.approved === false ? "bg-red-50 text-red-700" : undefined
                        }
                        title={
                          entry.approved === false
                            ? "These hours are not yet approved in Procas and should not be exported."
                            : undefined
                        }
                      >
                        <TableCell className="font-medium">
                          {entry.approved === false && (
                            <AlertTriangle
                              className="mr-1 inline h-3.5 w-3.5 align-[-2px] text-red-600"
                              aria-label="Not approved in Procas"
                            />
                          )}
                          {entry.employeeName}
                        </TableCell>
                        <TableCell>{entry.classification}</TableCell>
                        <TableCell className="uppercase">{entry.category}</TableCell>
                        <TableCell className="capitalize">{entry.location}</TableCell>
                        {DAYS.map((d) => (
                          <TableCell key={d.key} className="text-right tabular-nums">
                            {(entry[d.key as keyof TimesheetEntry] as number) || ""}
                          </TableCell>
                        ))}
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatHours(entry.totalHours)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(entry.amount)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => openEditEntry(entry)}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => removeEntry(entry.id)}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })}

      {/* Week dialog */}
      <Dialog open={weekOpen} onOpenChange={setWeekOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Week</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitWeek} className="space-y-4">
            <div className="space-y-2">
              <Label>Label</Label>
              <Input
                required
                value={weekForm.label}
                onChange={(e) => setWeekForm({ ...weekForm, label: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Week Start</Label>
                <Input
                  type="date"
                  required
                  value={weekForm.weekStart}
                  onChange={(e) =>
                    setWeekForm({ ...weekForm, weekStart: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Week End</Label>
                <Input
                  type="date"
                  required
                  value={weekForm.weekEnd}
                  onChange={(e) =>
                    setWeekForm({ ...weekForm, weekEnd: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <Button
                type="submit"
                disabled={createWeek.isPending}
                className="bg-[#CFAF42] text-white hover:bg-[#bd9e36]"
              >
                {createWeek.isPending ? "Adding…" : "Add Week"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Entry dialog */}
      <Dialog open={entryOpen} onOpenChange={setEntryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit Entry" : "Add Entry"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitEntry} className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-2">
              <Label>Employee Profile (optional autofill)</Label>
              <Select
                value={entryForm.employeeId?.toString() ?? ""}
                onValueChange={onEmployeeSelect}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select to autofill…" />
                </SelectTrigger>
                <SelectContent>
                  {employees?.map((e) => (
                    <SelectItem key={e.id} value={e.id.toString()}>
                      {e.name} ({e.classification})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Employee Name</Label>
              <Input
                required
                value={entryForm.employeeName ?? ""}
                onChange={(e) =>
                  setEntryForm({ ...entryForm, employeeName: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Classification</Label>
              <Input
                required
                value={entryForm.classification ?? ""}
                onChange={(e) =>
                  setEntryForm({ ...entryForm, classification: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select
                value={entryForm.category}
                onValueChange={(v: TimesheetCategory) =>
                  setEntryForm({ ...entryForm, category: v })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c} className="uppercase">
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Location</Label>
              <Select
                value={entryForm.location}
                onValueChange={(v: TimesheetEntryInputLocation) =>
                  setEntryForm({ ...entryForm, location: v })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="home">Home</SelectItem>
                  <SelectItem value="field">Field</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 grid grid-cols-7 gap-2">
              {DAYS.map((d) => (
                <div key={d.key} className="space-y-1">
                  <Label className="text-xs">{d.short}</Label>
                  <Input
                    type="number"
                    step="0.25"
                    value={(entryForm[d.key] as number) ?? ""}
                    onChange={(e) =>
                      setEntryForm({
                        ...entryForm,
                        [d.key]: e.target.value === "" ? undefined : Number(e.target.value),
                      })
                    }
                  />
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <Label>Rate</Label>
              <Input
                type="number"
                step="0.01"
                value={entryForm.rate ?? ""}
                onChange={(e) =>
                  setEntryForm({ ...entryForm, rate: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Task No.</Label>
              <Input
                value={entryForm.taskNo ?? ""}
                onChange={(e) =>
                  setEntryForm({ ...entryForm, taskNo: e.target.value })
                }
              />
            </div>
            <div className="col-span-2 space-y-2">
              <Label>Notes</Label>
              <Input
                value={entryForm.notes ?? ""}
                onChange={(e) =>
                  setEntryForm({ ...entryForm, notes: e.target.value })
                }
              />
            </div>
            <div className="col-span-2 flex justify-end pt-2">
              <Button
                type="submit"
                disabled={createEntry.isPending || updateEntry.isPending}
                className="bg-[#CFAF42] text-white hover:bg-[#bd9e36]"
              >
                {createEntry.isPending || updateEntry.isPending ? "Saving…" : "Save Entry"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
