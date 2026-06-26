import { useState } from "react";
import {
  useGeneratePackageDocument,
  type DocStatus,
  type GenerateInputFormat,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import DocStatusBadge from "./doc-status-badge";
import type { DocKind } from "@/lib/package-ui";

export default function DocDownload({
  packageId,
  doc,
  label,
  description,
  status,
  formats = ["xlsx", "pdf"],
}: {
  packageId: number;
  doc: DocKind;
  label: string;
  description: string;
  status: DocStatus;
  formats?: GenerateInputFormat[];
}) {
  const generate = useGeneratePackageDocument();
  const { toast } = useToast();
  const [busyFormat, setBusyFormat] = useState<GenerateInputFormat | null>(null);

  const handle = async (format: GenerateInputFormat) => {
    setBusyFormat(format);
    toast({
      title: `Generating ${label} (${format.toUpperCase()})`,
      description: "This can take a few seconds.",
    });
    try {
      const res = await generate.mutateAsync({ id: packageId, doc, data: { format } });
      window.open(res.url, "_blank");
      toast({ title: `${label} ready`, description: res.filename });
    } catch {
      toast({
        variant: "destructive",
        title: `Failed to generate ${label}`,
        description: "Something went wrong while building the file.",
      });
    } finally {
      setBusyFormat(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-[#333333]">{label}</p>
          <DocStatusBadge status={status} />
        </div>
        <p className="mt-0.5 text-xs text-[#5F5F5F]">{description}</p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        {formats.includes("xlsx") && (
          <Button
            variant="outline"
            size="sm"
            disabled={!!busyFormat}
            onClick={() => handle("xlsx")}
          >
            {busyFormat === "xlsx" ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <FileSpreadsheet className="mr-1.5 h-4 w-4" />
            )}
            Excel
          </Button>
        )}
        {formats.includes("pdf") && (
          <Button
            variant="outline"
            size="sm"
            disabled={!!busyFormat}
            onClick={() => handle("pdf")}
          >
            {busyFormat === "pdf" ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <FileText className="mr-1.5 h-4 w-4" />
            )}
            PDF
          </Button>
        )}
      </div>
    </div>
  );
}
