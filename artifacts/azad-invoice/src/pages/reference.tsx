import { useState } from "react";
import { useListReferenceData, useUpdateReferenceData } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Edit } from "lucide-react";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";

export default function Reference() {
  const { data: referenceData, isLoading } = useListReferenceData();
  const updateRef = useUpdateReferenceData();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [val, setVal] = useState("");

  const handleOpenEdit = (item: any) => {
    setEditItem(item);
    setVal(item.value);
    setOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editItem) return;
    try {
      await updateRef.mutateAsync({ id: editItem.id, data: { value: val } });
      setOpen(false);
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight text-[#333333]">Reference Data</h1>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Reference Value</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Key</Label>
              <Input disabled value={editItem?.key || ''} />
            </div>
            <div className="space-y-2">
              <Label>Value</Label>
              <Input required value={val} onChange={e => setVal(e.target.value)} />
            </div>
            <div className="pt-4 flex justify-end">
              <Button type="submit" className="bg-[#CFAF42] text-white">
                {updateRef.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <div className="rounded-md border bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Last Updated</TableHead>
              <TableHead className="w-[80px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-48" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-8 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : referenceData?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No reference data found.
                </TableCell>
              </TableRow>
            ) : (
              referenceData?.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.category}</TableCell>
                  <TableCell>{item.key}</TableCell>
                  <TableCell>{item.label}</TableCell>
                  <TableCell>{item.value}{item.unit ? ` ${item.unit}` : ''}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{item.description}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{item.updatedAt ? format(new Date(item.updatedAt), "MMM d, yyyy") : '-'}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => handleOpenEdit(item)}>
                      <Edit className="h-4 w-4" />
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
