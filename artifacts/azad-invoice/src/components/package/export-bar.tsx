import { useState } from "react";
import {
  useExportPackage,
  useGetPackageValidations,
  ApiError,
  type PackageSummary,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertTriangle, CheckCircle2, Download, Loader2, Package } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function ExportBar({ pkg }: { pkg: PackageSummary }) {
  const exportPackage = useExportPackage();
  const { data: validations } = useGetPackageValidations(pkg.id);
  const { toast } = useToast();
  const [progress, setProgress] = useState<string | null>(null);

  const errorCount =
    validations?.flags.filter((f) => f.severity === "error").length ?? 0;
  // ready === null while validations are loading; false = blocking errors exist;
  // true = no errors (warnings are allowed through)
  const ready = validations ? validations.isValid : null;
  const isBlocked = ready === false && errorCount > 0;

  const handleExport = async () => {
    setProgress("Building the combined Excel workbook and merged PDF…");
    toast({
      title: "Building package export",
      description: "Assembling one Excel workbook and one PDF for the client.",
    });
    try {
      const res = await exportPackage.mutateAsync({ id: pkg.id });
      window.open(res.url, "_blank");
      toast({
        title: "Package ready",
        description: `Excel + PDF bundled into ${res.filename}.`,
      });
    } catch (err) {
      let description = "Something went wrong while building the export package.";
      if (err instanceof ApiError && err.status === 422) {
        const data = err.data as { error?: string; issues?: string[] } | null;
        description = data?.issues?.length
          ? `Fix these issues first: ${data.issues.join(" · ")}`
          : (data?.error ?? description);
      }
      toast({ variant: "destructive", title: "Export failed", description });
    } finally {
      setProgress(null);
    }
  };

  const errorLabels = validations?.flags
    .filter((f) => f.severity === "error")
    .map((f) => f.message) ?? [];

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        {ready === true && (
          <Badge className="gap-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
            <CheckCircle2 className="h-3 w-3" /> Ready to export
          </Badge>
        )}
        {ready === false && (
          <Badge className="gap-1 bg-amber-100 text-amber-800 hover:bg-amber-100">
            <AlertTriangle className="h-3 w-3" />
            {errorCount > 0
              ? `${errorCount} issue${errorCount === 1 ? "" : "s"} to fix`
              : "Review warnings"}
          </Badge>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            {/* span ensures tooltip fires even when the button is disabled */}
            <span>
              <Button
                onClick={handleExport}
                disabled={exportPackage.isPending || isBlocked}
                className="bg-[#CFAF42] text-white hover:bg-[#bd9e36] disabled:opacity-60"
              >
                {exportPackage.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Package className="mr-2 h-4 w-4" />
                )}
                {exportPackage.isPending ? "Exporting…" : "Export Package (Excel + PDF)"}
              </Button>
            </span>
          </TooltipTrigger>
          {isBlocked && (
            <TooltipContent side="left" className="max-w-xs">
              <p className="font-medium">Resolve these issues before exporting:</p>
              <ul className="mt-1 list-disc pl-4 text-xs">
                {errorLabels.map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
              </ul>
            </TooltipContent>
          )}
        </Tooltip>
      </div>
      {progress && (
        <span className="flex items-center gap-1.5 text-xs text-[#5F5F5F]">
          <Download className="h-3 w-3" /> {progress}
        </span>
      )}
    </div>
  );
}
