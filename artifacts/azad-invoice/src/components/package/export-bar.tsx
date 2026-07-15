import { useState } from "react";
import {
  useExportPackage,
  useGetPackageValidations,
  type PackageSummary,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, Download, Loader2, Package } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function ExportBar({ pkg }: { pkg: PackageSummary }) {
  const exportPackage = useExportPackage();
  const { data: validations } = useGetPackageValidations(pkg.id);
  const { toast } = useToast();
  const [progress, setProgress] = useState<string | null>(null);

  const errorCount =
    validations?.flags.filter((f) => f.severity === "error").length ?? 0;
  const ready = validations ? validations.isValid : null;

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
    } catch {
      toast({
        variant: "destructive",
        title: "Export failed",
        description: "Something went wrong while building the export package.",
      });
    } finally {
      setProgress(null);
    }
  };

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
        <Button
          onClick={handleExport}
          disabled={exportPackage.isPending}
          className="bg-[#CFAF42] text-white hover:bg-[#bd9e36]"
        >
          {exportPackage.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Package className="mr-2 h-4 w-4" />
          )}
          {exportPackage.isPending ? "Exporting…" : "Export Package (Excel + PDF)"}
        </Button>
      </div>
      {progress && (
        <span className="flex items-center gap-1.5 text-xs text-[#5F5F5F]">
          <Download className="h-3 w-3" /> {progress}
        </span>
      )}
    </div>
  );
}
