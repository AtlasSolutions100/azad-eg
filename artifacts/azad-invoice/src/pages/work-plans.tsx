import { useState } from "react";
import { useListWorkPlans, useCreateWorkPlan, useUpdateWorkPlan, useDeleteWorkPlan, WorkPlanInput, WorkPlanUpdate } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Edit } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

export default function WorkPlans() {
  const { data: plans, isLoading } = useListWorkPlans();
  const createPlan = useCreateWorkPlan();
  const updatePlan = useUpdateWorkPlan();
  const deletePlan = useDeleteWorkPlan();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [formData, setFormData] = useState<Partial<WorkPlanInput>>({ billingCycle: 'whole_month' });

  const handleOpenCreate = () => {
    setEditId(null);
    setFormData({ billingCycle: 'whole_month' });
    setOpen(true);
  };

  const handleOpenEdit = (plan: any) => {
    setEditId(plan.id);
    setFormData({
      code: plan.code,
      title: plan.title,
      client: plan.client,
      jobNumber: plan.jobNumber,
      totalBudget: plan.totalBudget,
      fringeRate: plan.fringeRate,
      overheadRate: plan.overheadRate,
      fixedFeeRate: plan.fixedFeeRate,
      fccmRate: plan.fccmRate,
      billingCycle: plan.billingCycle,
    });
    setOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editId) {
        await updatePlan.mutateAsync({ id: editId, data: formData as WorkPlanUpdate });
      } else {
        await createPlan.mutateAsync({ data: formData as WorkPlanInput });
      }
      setOpen(false);
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Are you sure you want to delete this work plan?")) return;
    try {
      await deletePlan.mutateAsync({ id });
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight text-[#333333]">Work Plans</h1>
        <Button onClick={handleOpenCreate} className="bg-[#CFAF42] hover:bg-[#CFAF42]/90 text-white">
          Add Work Plan
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit Work Plan" : "Create Work Plan"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Code</Label>
              <Input required value={formData.code || ''} onChange={e => setFormData({...formData, code: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Title</Label>
              <Input required value={formData.title || ''} onChange={e => setFormData({...formData, title: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Client</Label>
              <Input required value={formData.client || ''} onChange={e => setFormData({...formData, client: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Job Number</Label>
              <Input required value={formData.jobNumber || ''} onChange={e => setFormData({...formData, jobNumber: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Total Budget</Label>
              <Input required type="number" step="0.01" value={formData.totalBudget || ''} onChange={e => setFormData({...formData, totalBudget: Number(e.target.value)})} />
            </div>
            <div className="space-y-2">
              <Label>Billing Cycle</Label>
              <Select value={formData.billingCycle} onValueChange={(val: any) => setFormData({...formData, billingCycle: val})}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="whole_month">Whole Month</SelectItem>
                  <SelectItem value="last_friday">Last Friday</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 pt-4 flex justify-end">
              <Button type="submit" className="bg-[#CFAF42] text-white">
                {createPlan.isPending || updatePlan.isPending ? "Saving..." : "Save"}
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
              <TableHead>Title</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Job Number</TableHead>
              <TableHead className="text-right">Budget</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : plans?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No work plans found.
                </TableCell>
              </TableRow>
            ) : (
              plans?.map((plan) => (
                <TableRow key={plan.id}>
                  <TableCell className="font-medium">{plan.code}</TableCell>
                  <TableCell>{plan.title}</TableCell>
                  <TableCell>{plan.client}</TableCell>
                  <TableCell>{plan.jobNumber}</TableCell>
                  <TableCell className="text-right">${plan.totalBudget.toLocaleString()}</TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      plan.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                    }`}>
                      {plan.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => handleOpenEdit(plan)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(plan.id)}>
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
