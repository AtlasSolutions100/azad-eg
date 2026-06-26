import { useState } from "react";
import {
  useListBillingRuleSheets,
  useUploadBillingRuleSheet,
  useDeleteBillingRuleSheet,
} from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, Upload, FileText, Download, CalendarDays } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";

export default function BillingRules() {
  const { data: sheets, isLoading } = useListBillingRuleSheets();
  const uploadSheet = useUploadBillingRuleSheet();
  const deleteSheet = useDeleteBillingRuleSheet();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState({ title: "", notes: "" });
  const [error, setError] = useState<string | null>(null);

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!file || !form.title) return;
    try {
      await uploadSheet.mutateAsync({
        data: {
          file,
          title: form.title,
          notes: form.notes || undefined,
        },
      });
      setOpen(false);
      setFile(null);
      setForm({ title: "", notes: "" });
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
      setError("Upload failed. Make sure the file is a PDF, Excel, Word, or image.");
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Are you sure you want to delete this cheat sheet?")) return;
    try {
      await deleteSheet.mutateAsync({ id });
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-[#333333]">Billing Rules</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Billing-period rules and the cheat sheets that document them.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="bg-[#CFAF42] hover:bg-[#CFAF42]/90 text-white">
              <Upload className="mr-2 h-4 w-4" /> Upload Cheat Sheet
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Upload Billing Rule Cheat Sheet</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleUpload} className="space-y-4">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input
                  required
                  placeholder="e.g. BART Billing Period Rules"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Notes (Optional)</Label>
                <Textarea
                  placeholder="When to use whole-month vs last-Friday cutoffs, exceptions, etc."
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>File</Label>
                <Input
                  type="file"
                  accept=".pdf,.xlsx,.xls,.doc,.docx,.png,.jpg,.jpeg"
                  required
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
                <p className="text-xs text-muted-foreground">PDF, Excel, Word, or image.</p>
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" className="w-full bg-[#CFAF42] text-white" disabled={uploadSheet.isPending}>
                {uploadSheet.isPending ? "Uploading..." : "Upload"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-white p-5">
          <div className="flex items-center gap-2 text-[#333333]">
            <CalendarDays className="h-5 w-5 text-[#CFAF42]" />
            <h2 className="font-semibold">Whole Month</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            The billing period covers the entire calendar month, from the 1st through the last
            day of the month.
          </p>
        </div>
        <div className="rounded-lg border bg-white p-5">
          <div className="flex items-center gap-2 text-[#333333]">
            <CalendarDays className="h-5 w-5 text-[#CFAF42]" />
            <h2 className="font-semibold">Last Friday of the Month</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            The billing period ends on the last Friday of the month; hours after that roll into
            the next period. Upload the client cheat sheet below to keep the exact rules on hand.
          </p>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold text-[#333333]">Cheat Sheets</h2>
        <div className="rounded-md border bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead>File</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-[120px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-40" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-48" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-8 w-8 ml-auto" /></TableCell>
                  </TableRow>
                ))
              ) : sheets?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No cheat sheets uploaded yet.
                  </TableCell>
                </TableRow>
              ) : (
                sheets?.map((sheet) => (
                  <TableRow key={sheet.id}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        {sheet.title}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[280px] text-sm text-muted-foreground">
                      {sheet.notes || "-"}
                    </TableCell>
                    <TableCell>
                      <a
                        href={sheet.fileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-[#CFAF42] hover:underline"
                      >
                        <Download className="h-3.5 w-3.5" />
                        {sheet.fileName}
                      </a>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(sheet.createdAt), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(sheet.id)}
                        disabled={deleteSheet.isPending}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
