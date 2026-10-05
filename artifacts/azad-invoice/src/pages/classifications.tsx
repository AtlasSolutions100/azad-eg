import { parseDay } from "@/lib/utils";
import { useState } from "react";
import { useListClassifications, useCreateClassification, useUpdateClassification, useDeleteClassification, ClassificationInput, ClassificationUpdate } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Edit } from "lucide-react";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";

export default function Classifications() {
  const { data: classifications, isLoading } = useListClassifications();
  const createClass = useCreateClassification();
  const updateClass = useUpdateClassification();
  const deleteClass = useDeleteClassification();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [formData, setFormData] = useState<Partial<ClassificationInput>>({ location: 'home' });

  const handleOpenCreate = () => {
    setEditId(null);
    setFormData({ location: 'home' });
    setOpen(true);
  };

  const handleOpenEdit = (cls: any) => {
    setEditId(cls.id);
    setFormData({
      code: cls.code,
      description: cls.description,
      regularRate: cls.regularRate,
      otRate: cls.otRate || undefined,
      dtRate: cls.dtRate || undefined,
      location: cls.location,
      effectiveDate: cls.effectiveDate || undefined,
    });
    setOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editId) {
        await updateClass.mutateAsync({ id: editId, data: formData as ClassificationUpdate });
      } else {
        await createClass.mutateAsync({ data: formData as ClassificationInput });
      }
      setOpen(false);
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Are you sure you want to delete this classification?")) return;
    try {
      await deleteClass.mutateAsync({ id });
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight text-[#333333]">Classifications</h1>
        <Button onClick={handleOpenCreate} className="bg-[#CFAF42] hover:bg-[#CFAF42]/90 text-white">
          Add Classification
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit Classification" : "Create Classification"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Code</Label>
              <Input required value={formData.code || ''} onChange={e => setFormData({...formData, code: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input required value={formData.description || ''} onChange={e => setFormData({...formData, description: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Regular Rate</Label>
              <Input required type="number" step="0.01" value={formData.regularRate || ''} onChange={e => setFormData({...formData, regularRate: Number(e.target.value)})} />
            </div>
            <div className="space-y-2">
              <Label>Location</Label>
              <Select value={formData.location} onValueChange={(val: any) => setFormData({...formData, location: val})}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="home">Home</SelectItem>
                  <SelectItem value="field">Field</SelectItem>
                  <SelectItem value="both">Both</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>OT Rate</Label>
              <Input type="number" step="0.01" value={formData.otRate || ''} onChange={e => setFormData({...formData, otRate: Number(e.target.value)})} />
            </div>
            <div className="space-y-2">
              <Label>DT Rate</Label>
              <Input type="number" step="0.01" value={formData.dtRate || ''} onChange={e => setFormData({...formData, dtRate: Number(e.target.value)})} />
            </div>
            <div className="space-y-2 col-span-2">
              <Label>Effective Date</Label>
              <Input type="date" value={formData.effectiveDate || ''} onChange={e => setFormData({...formData, effectiveDate: e.target.value})} />
            </div>
            <div className="col-span-2 pt-4 flex justify-end">
              <Button type="submit" className="bg-[#CFAF42] text-white">
                {createClass.isPending || updateClass.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <div className="rounded-md border bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Regular Rate</TableHead>
              <TableHead className="text-right">OT Rate</TableHead>
              <TableHead className="text-right">DT Rate</TableHead>
              <TableHead>Effective Date</TableHead>
              <TableHead className="w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : classifications?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                  No classifications found.
                </TableCell>
              </TableRow>
            ) : (
              classifications?.map((classification) => (
                <TableRow key={classification.id}>
                  <TableCell className="font-medium">{classification.code}</TableCell>
                  <TableCell>{classification.description}</TableCell>
                  <TableCell className="capitalize">{classification.location}</TableCell>
                  <TableCell className="text-right">${classification.regularRate.toFixed(2)}</TableCell>
                  <TableCell className="text-right">{classification.otRate ? `$${classification.otRate.toFixed(2)}` : '-'}</TableCell>
                  <TableCell className="text-right">{classification.dtRate ? `$${classification.dtRate.toFixed(2)}` : '-'}</TableCell>
                  <TableCell>{classification.effectiveDate ? format(parseDay(classification.effectiveDate), "MMM d, yyyy") : '-'}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => handleOpenEdit(classification)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(classification.id)}>
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
