import type { PackageDetail } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarRange, Clock } from "lucide-react";
import { format } from "date-fns";
import { formatCurrency, formatHours } from "@/lib/package-ui";

function periodRange(start: string, end: string): string {
  try {
    return `${format(new Date(start), "MMM d")} – ${format(new Date(end), "MMM d, yyyy")}`;
  } catch {
    return `${start} – ${end}`;
  }
}

export default function OverviewTab({ detail }: { detail: PackageDetail }) {
  const { package: pkg, weeks, rollup } = detail;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Pay period summary */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarRange className="h-4 w-4 text-[#CFAF42]" /> Pay period
            </CardTitle>
          </CardHeader>
          <CardContent>
            {weeks.length === 0 ? (
              <p className="text-sm text-[#5F5F5F]">
                No weeks added yet. Add weeks in the Timesheets tab.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-[#9a9a9a]">
                    Weeks in this pay period
                  </p>
                  <p className="mt-1 text-lg font-semibold text-[#333333]">
                    {weeks.length} {weeks.length === 1 ? "Week" : "Weeks"}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-[#9a9a9a]">
                    Period
                  </p>
                  <p className="mt-1 text-lg font-semibold text-[#333333]">
                    {periodRange(pkg.payPeriodStart, pkg.payPeriodEnd)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-[#9a9a9a]">
                    Total hours
                  </p>
                  <p className="mt-1 text-lg font-semibold text-[#333333]">
                    {formatHours(rollup.totalHours)}
                  </p>
                </div>
              </div>
            )}
            <p className="mt-4 text-xs text-[#9a9a9a]">
              Weekly timesheet detail lives in the Timesheets tab.
            </p>
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
              <span className="text-[#5F5F5F]">Weeks</span>
              <span className="font-semibold text-[#333333]">{weeks.length}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
