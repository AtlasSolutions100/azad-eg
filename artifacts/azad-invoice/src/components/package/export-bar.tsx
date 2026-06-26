import { useState } from "react";
import {
  useExportPackage,
  type PackageSummary,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Download, Loader2, Package } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function ExportBar({ pkg }: { pkg: PackageSummary }) {
  const exportPackage = useExportPackage();
  const { toast } = useToast();
  const [progress, setProgress] = useState<string | null>(null);

  const handleExport = async () => {
    setProgress("Generating 5 documents and bundling the ZIP…");
    toast({
      title: "Building package export",
      description: "Generating all 5 documents and zipping them up.",
    });
    try {
      const res = await exportPackage.mutateAsync({ id: pkg.id });
      window.open(res.url, "_blank");
      toast({
        title: "Package ready",
        description: `${res.documentCount} documents bundled into ${res.filename}.`,
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Export failed",
        description: "Something went wrong while building the package ZIP.",
      });
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
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
        {exportPackage.isPending ? "Exporting…" : "Export Package (ZIP)"}
      </Button>
      {progress && (
        <span className="flex items-center gap-1.5 text-xs text-[#5F5F5F]">
          <Download className="h-3 w-3" /> {progress}
        </span>
      )}
    </div>
  );
}
