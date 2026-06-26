import { useEffect, useState } from "react";
import {
  useSavePackageProgressReport,
  useUploadProgressReportFile,
  type PackageDetail,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp, FileCheck2, X, Download, Loader2 } from "lucide-react";
import DocDownload from "./doc-download";

type FormState = {
  percentComplete: number;
  summary: string;
  workPerformed: string;
  concerns: string;
  correctiveAction: string;
  scheduleComment: string;
  costForecast: string;
  preparedBy: string;
  reportDate: string;
  uploadedFileName: string;
  uploadedFileUrl: string;
};

const NARRATIVE_FIELDS: { key: keyof FormState; label: string; placeholder: string }[] = [
  { key: "summary", label: "Summary", placeholder: "Brief overview of the period…" },
  { key: "workPerformed", label: "Work Performed", placeholder: "Detail the work completed this period…" },
  { key: "concerns", label: "Concerns", placeholder: "Risks, blockers or concerns…" },
  { key: "correctiveAction", label: "Corrective Action", placeholder: "Actions taken or planned to address concerns…" },
  { key: "scheduleComment", label: "Schedule", placeholder: "Schedule status and outlook…" },
  { key: "costForecast", label: "Cost Forecast", placeholder: "Budget / cost forecast commentary…" },
];

export default function ProgressTab({ detail }: { detail: PackageDetail }) {
  const { package: pkg, progressReport } = detail;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const save = useSavePackageProgressReport();
  const upload = useUploadProgressReportFile();

  const [form, setForm] = useState<FormState>({
    percentComplete: 0,
    summary: "",
    workPerformed: "",
    concerns: "",
    correctiveAction: "",
    scheduleComment: "",
    costForecast: "",
    preparedBy: "",
    reportDate: "",
    uploadedFileName: "",
    uploadedFileUrl: "",
  });

  useEffect(() => {
    setForm({
      percentComplete: progressReport?.percentComplete ?? 0,
      summary: progressReport?.summary ?? "",
      workPerformed: progressReport?.workPerformed ?? "",
      concerns: progressReport?.concerns ?? "",
      correctiveAction: progressReport?.correctiveAction ?? "",
      scheduleComment: progressReport?.scheduleComment ?? "",
      costForecast: progressReport?.costForecast ?? "",
      preparedBy: progressReport?.preparedBy ?? "",
      reportDate: progressReport?.reportDate ?? "",
      uploadedFileName: progressReport?.uploadedFileName ?? "",
      uploadedFileUrl: progressReport?.uploadedFileUrl ?? "",
    });
  }, [progressReport]);

  const handleFile = async (file: File | null) => {
    if (!file) {
      setForm((f) => ({ ...f, uploadedFileName: "", uploadedFileUrl: "" }));
      return;
    }
    try {
      const res = await upload.mutateAsync({ id: pkg.id, data: { file } });
      setForm((f) => ({
        ...f,
        uploadedFileName: res.uploadedFileName,
        uploadedFileUrl: res.uploadedFileUrl,
      }));
      toast({
        title: "File uploaded",
        description: `${res.uploadedFileName} is attached. Save the report to keep it.`,
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: "Could not upload the file. Use an Excel, Word, or PDF document.",
      });
    }
  };

  const handleSave = async () => {
    try {
      await save.mutateAsync({
        id: pkg.id,
        data: {
          percentComplete: form.percentComplete,
          summary: form.summary,
          workPerformed: form.workPerformed || undefined,
          concerns: form.concerns || undefined,
          correctiveAction: form.correctiveAction || undefined,
          scheduleComment: form.scheduleComment || undefined,
          costForecast: form.costForecast || undefined,
          preparedBy: form.preparedBy || undefined,
          reportDate: form.reportDate || undefined,
          uploadedFileName: form.uploadedFileName || undefined,
          uploadedFileUrl: form.uploadedFileUrl || undefined,
        },
      });
      queryClient.invalidateQueries();
      toast({ title: "Progress report saved" });
    } catch {
      toast({ variant: "destructive", title: "Failed to save progress report" });
    }
  };

  return (
    <div className="space-y-6">
      <DocDownload
        packageId={pkg.id}
        doc="progress"
        label="Progress Report"
        description="Narrative report of work performed this period."
        status={pkg.progressReportDocStatus}
      />

      {/* Method 1: Upload */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload a Report</CardTitle>
          <CardDescription>
            Attach an existing Excel, Word, or PDF report. The file is stored and
            can be downloaded later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {form.uploadedFileName ? (
            <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2 text-sm text-emerald-700">
                <FileCheck2 className="h-4 w-4 flex-shrink-0" />
                {form.uploadedFileUrl ? (
                  <a
                    href={form.uploadedFileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate font-medium underline-offset-2 hover:underline"
                  >
                    {form.uploadedFileName}
                  </a>
                ) : (
                  <span className="truncate font-medium">{form.uploadedFileName}</span>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                {form.uploadedFileUrl && (
                  <Button variant="ghost" size="icon" asChild aria-label="Download attached file">
                    <a href={form.uploadedFileUrl} target="_blank" rel="noreferrer">
                      <Download className="h-4 w-4" />
                    </a>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleFile(null)}
                  aria-label="Remove attached file"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-gray-50/60 px-4 py-8 text-center transition-colors hover:border-[#CFAF42]/50">
              {upload.isPending ? (
                <Loader2 className="h-6 w-6 animate-spin text-[#CFAF42]" />
              ) : (
                <FileUp className="h-6 w-6 text-[#CFAF42]" />
              )}
              <span className="text-sm font-medium text-[#333333]">
                {upload.isPending ? "Uploading…" : "Click to upload a report"}
              </span>
              <span className="text-xs text-[#5F5F5F]">
                Excel, Word, or PDF
              </span>
              <input
                type="file"
                className="hidden"
                accept=".xlsx,.xls,.doc,.docx,.pdf"
                disabled={upload.isPending}
                onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              />
            </label>
          )}
        </CardContent>
      </Card>

      {/* Method 2: Rich form fields */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Or Write the Narrative</CardTitle>
          <CardDescription>
            Fill in the structured sections of the progress report.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Percent Complete (%)</Label>
              <Input
                type="number"
                min="0"
                max="100"
                value={form.percentComplete}
                onChange={(e) =>
                  setForm({ ...form, percentComplete: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Report Date</Label>
              <Input
                type="date"
                value={form.reportDate ? form.reportDate.slice(0, 10) : ""}
                onChange={(e) => setForm({ ...form, reportDate: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Prepared By</Label>
              <Input
                value={form.preparedBy}
                onChange={(e) => setForm({ ...form, preparedBy: e.target.value })}
              />
            </div>
          </div>
          {NARRATIVE_FIELDS.map((field) => (
            <div key={field.key} className="space-y-2">
              <Label>{field.label}</Label>
              <Textarea
                rows={field.key === "summary" ? 2 : 3}
                placeholder={field.placeholder}
                value={form[field.key] as string}
                onChange={(e) =>
                  setForm({ ...form, [field.key]: e.target.value })
                }
              />
            </div>
          ))}
          <Button
            onClick={handleSave}
            disabled={save.isPending}
            className="bg-[#CFAF42] text-white hover:bg-[#bd9e36]"
          >
            {save.isPending ? "Saving…" : "Save Progress Report"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
