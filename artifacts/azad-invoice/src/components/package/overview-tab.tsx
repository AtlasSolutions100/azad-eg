import { parseDay } from "@/lib/utils";
import { useEffect, useState } from "react";
import {
  useUpdatePackage,
  type PackageDetail,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, CalendarRange, Clock, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { formatCurrency, formatHours } from "@/lib/package-ui";

function periodRange(start: string, end: string): string {
  try {
    return `${format(parseDay(start), "MMM d")} – ${format(parseDay(end), "MMM d, yyyy")}`;
  } catch {
    return `${start} – ${end}`;
  }
}

function OwnerPrimeCard({ detail }: { detail: PackageDetail }) {
  const { package: pkg } = detail;
  const updatePackage = useUpdatePackage();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [owner, setOwner] = useState(pkg.owner ?? "");
  const [prime, setPrime] = useState(pkg.prime ?? "");

  // Re-sync when the package data refreshes (e.g. after a save elsewhere).
  useEffect(() => {
    setOwner(pkg.owner ?? "");
    setPrime(pkg.prime ?? "");
  }, [pkg.id, pkg.owner, pkg.prime]);

  const dirty = owner !== (pkg.owner ?? "") || prime !== (pkg.prime ?? "");

  const save = async () => {
    try {
      await updatePackage.mutateAsync({
        id: pkg.id,
        data: { owner: owner.trim(), prime: prime.trim() },
      });
      queryClient.invalidateQueries();
      toast({ title: "Owner & Prime saved" });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Failed to save Owner & Prime",
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="h-4 w-4 text-[#CFAF42]" /> Owner &amp; Prime
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="pkg-owner" className="text-xs text-[#5F5F5F]">
            Owner
          </Label>
          <Input
            id="pkg-owner"
            data-testid="input-owner"
            placeholder="Project owner / agency, e.g. BART"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pkg-prime" className="text-xs text-[#5F5F5F]">
            Prime
          </Label>
          <Input
            id="pkg-prime"
            data-testid="input-prime"
            placeholder="Prime contractor, e.g. T.Y. Lin"
            value={prime}
            onChange={(e) => setPrime(e.target.value)}
          />
        </div>
        <div className="flex justify-end pt-1">
          <Button
            size="sm"
            data-testid="button-save-owner-prime"
            disabled={!dirty || updatePackage.isPending}
            onClick={save}
            className="bg-[#CFAF42] text-white hover:bg-[#CFAF42]/90"
          >
            {updatePackage.isPending && (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            )}
            Save
          </Button>
        </div>
        <p className="text-xs text-[#9a9a9a]">
          Who the work belongs to, and the prime this package bills through.
        </p>
      </CardContent>
    </Card>
  );
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

      <div className="grid gap-6 lg:grid-cols-3">
        <OwnerPrimeCard detail={detail} />
      </div>
    </div>
  );
}
