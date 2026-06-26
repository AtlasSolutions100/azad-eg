import type { PackageDetail } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarRange, Clock } from "lucide-react";
import { format } from "date-fns";
import { DOC_METAS, formatCurrency, formatHours } from "@/lib/package-ui";
import DocDownload from "./doc-download";

function weekDateRange(start: string, end: string): string {
  try {
    return `${format(new Date(start), "MMM d")} – ${format(new Date(end), "MMM d, yyyy")}`;
  } catch {
    return `${start} – ${end}`;
  }
}

export default function OverviewTab({ detail }: { detail: PackageDetail }) {
  const { package: pkg, weeks, entries, rollup } = detail;

  const readyCount = DOC_METAS.filter(
    (d) => pkg[d.statusField] === "ready",
  ).length;

  const entriesByWeek = (weekId: number) =>
    entries.filter((e) => e.weekId === weekId);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Weeks */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarRange className="h-4 w-4 text-[#CFAF42]" /> Weeks in this pay
              period
            </CardTitle>
          </CardHeader>
          <CardContent>
            {weeks.length === 0 ? (
              <p className="text-sm text-[#5F5F5F]">
                No weeks added yet. Add weeks in the Timesheets tab.
              </p>
            ) : (
              <div className="space-y-2">
                {weeks
                  .slice()
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((week) => {
                    const wkEntries = entriesByWeek(week.id);
                    const hours = wkEntries.reduce((n, e) => n + e.totalHours, 0);
                    return (
                      <div
                        key={week.id}
                        className="flex items-center justify-between rounded-lg border border-border bg-gray-50/60 px-4 py-3"
                      >
                        <div>
                          <p className="text-sm font-semibold text-[#333333]">
                            {week.label}
                          </p>
                          <p className="text-xs text-[#5F5F5F]">
                            {weekDateRange(week.weekStart, week.weekEnd)}
                          </p>
                        </div>
                        <div className="flex items-center gap-6 text-right">
                          <div>
                            <p className="text-[11px] uppercase tracking-wide text-[#9a9a9a]">
                              Entries
                            </p>
                            <p className="text-sm font-semibold text-[#333333]">
                              {wkEntries.length}
                            </p>
                          </div>
                          <div>
                            <p className="text-[11px] uppercase tracking-wide text-[#9a9a9a]">
                              Hours
                            </p>
                            <p className="text-sm font-semibold text-[#333333]">
                              {formatHours(hours)}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Snapshot */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4 text-[#CFAF42]" /> Snapshot
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-[#5F5F5F]">Total hours</span>
              <span className="font-semibold text-[#333333]">
                {formatHours(rollup.totalHours)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#5F5F5F]">Labor total</span>
              <span className="font-semibold text-[#333333]">
                {formatCurrency(rollup.laborTotal)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#5F5F5F]">This period</span>
              <span className="font-semibold text-[#333333]">
                {formatCurrency(rollup.totalThisPeriod)}
              </span>
            </div>
            <div className="flex justify-between border-t border-dashed border-border pt-3">
              <span className="text-[#5F5F5F]">Documents ready</span>
              <span className="font-semibold text-[#333333]">{readyCount} / 5</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Combined doc status + individual downloads */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-[#333333]">
          Documents — status &amp; individual downloads
        </h3>
        <div className="grid gap-3 lg:grid-cols-2">
          {DOC_METAS.map((doc) => (
            <DocDownload
              key={doc.kind}
              packageId={pkg.id}
              doc={doc.kind}
              label={doc.label}
              description={doc.description}
              status={pkg[doc.statusField]}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
