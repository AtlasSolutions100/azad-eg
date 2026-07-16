import { useState } from "react";
import { useListSignatures, useUploadSignature, useDeleteSignature, useSetDefaultSignature } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";

export default function Signatures() {
  const { data: signatures, isLoading } = useListSignatures();
  const uploadSignature = useUploadSignature();
  const deleteSignature = useDeleteSignature();
  const setDefaultSignature = useSetDefaultSignature();
  const queryClient = useQueryClient();

  const handleSetDefault = async (id: number) => {
    try {
      await setDefaultSignature.mutateAsync({ id });
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [formData, setFormData] = useState({ name: "", title: "", email: "" });

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !formData.name) return;
    try {
      await uploadSignature.mutateAsync({
        data: {
          file,
          name: formData.name,
          title: formData.title || undefined,
          email: formData.email || undefined,
        }
      });
      setOpen(false);
      setFile(null);
      setFormData({ name: "", title: "", email: "" });
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Are you sure you want to delete this signature?")) return;
    try {
      await deleteSignature.mutateAsync({ id });
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight text-[#333333]">Signatures</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="bg-[#CFAF42] hover:bg-[#CFAF42]/90 text-white">
              <Upload className="mr-2 h-4 w-4" /> Upload Signature
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Upload Signature</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleUpload} className="space-y-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input required value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Title (Optional)</Label>
                <Input value={formData.title} onChange={e => setFormData({ ...formData, title: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Email (Optional)</Label>
                <Input type="email" value={formData.email} onChange={e => setFormData({ ...formData, email: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Signature Image</Label>
                <Input type="file" accept="image/*" required onChange={e => setFile(e.target.files?.[0] || null)} />
              </div>
              <Button type="submit" className="w-full bg-[#CFAF42] text-white" disabled={uploadSignature.isPending}>
                {uploadSignature.isPending ? "Uploading..." : "Upload"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-md border bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Preview</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Default</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-10 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-8 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : signatures?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No signatures found.
                </TableCell>
              </TableRow>
            ) : (
              signatures?.map((sig) => (
                <TableRow key={sig.id}>
                  <TableCell>
                    <div className="h-10 w-24 bg-gray-100 rounded flex items-center justify-center overflow-hidden">
                      <img src={sig.imageUrl} alt={sig.name} className="max-h-full max-w-full object-contain" />
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">{sig.name}</TableCell>
                  <TableCell>{sig.title || '-'}</TableCell>
                  <TableCell>{sig.email || '-'}</TableCell>
                  <TableCell>
                    {sig.isDefault ? (
                      <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-800">Default</span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleSetDefault(sig.id)}
                        disabled={setDefaultSignature.isPending}
                      >
                        Set as default
                      </Button>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{format(new Date(sig.createdAt), "MMM d, yyyy")}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(sig.id)} disabled={deleteSignature.isPending}>
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
  );
}
