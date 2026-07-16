import { useState } from "react";
import {
  useListEmployees,
  useCreateEmployee,
  useUpdateEmployee,
  useDeleteEmployee,
  useCreateEmployeeRateChange,
  useDeleteEmployeeRateChange,
  EmployeeInput,
  EmployeeUpdate,
  type Employee,
} from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Trash2, Edit, CalendarClock } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";

export default function Employees() {
  const { data: employees, isLoading } = useListEmployees();
  const createEmp = useCreateEmployee();
  const updateEmp = useUpdateEmployee();
  const deleteEmp = useDeleteEmployee();
  const createRateChange = useCreateEmployeeRateChange();
  const deleteRateChange = useDeleteEmployeeRateChange();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [formData, setFormData] = useState<Partial<EmployeeInput>>({ active: true });

  // Rate-history dialog: effective-dated rate changes for one employee.
  const [ratesEmpId, setRatesEmpId] = useState<number | null>(null);
  const [rateForm, setRateForm] = useState({ effectiveDate: "", homeRate: "", fieldRate: "" });
  const ratesEmp: Employee | undefined = employees?.find((e) => e.id === ratesEmpId);

  const submitRateChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ratesEmpId || !rateForm.effectiveDate || !rateForm.homeRate) return;
    try {
      await createRateChange.mutateAsync({
        id: ratesEmpId,
        data: {
          effectiveDate: rateForm.effectiveDate,
          homeRate: Number(rateForm.homeRate),
          ...(rateForm.fieldRate ? { fieldRate: Number(rateForm.fieldRate) } : {}),
        },
      });
      setRateForm({ effectiveDate: "", homeRate: "", fieldRate: "" });
      queryClient.invalidateQueries();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Failed to add rate change",
        description: err?.response?.data?.error || err?.message,
      });
    }
  };

  const removeRateChange = async (rateChangeId: number) => {
    if (!ratesEmpId) return;
    try {
      await deleteRateChange.mutateAsync({ id: ratesEmpId, rateChangeId });
      queryClient.invalidateQueries();
    } catch {
      toast({ variant: "destructive", title: "Failed to delete rate change" });
    }
  };

  const handleOpenCreate = () => {
    setEditId(null);
    setFormData({ active: true });
    setOpen(true);
  };

  const handleOpenEdit = (emp: any) => {
    setEditId(emp.id);
    setFormData({
      name: emp.name,
      classification: emp.classification,
      homeRate: emp.homeRate,
      fieldRate: emp.fieldRate || undefined,
      defaultTaskNo: emp.defaultTaskNo || undefined,
      active: emp.active,
    });
    setOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editId) {
        await updateEmp.mutateAsync({ id: editId, data: formData as EmployeeUpdate });
      } else {
        await createEmp.mutateAsync({ data: formData as EmployeeInput });
      }
      setOpen(false);
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Are you sure you want to delete this employee?")) return;
    try {
      await deleteEmp.mutateAsync({ id });
      queryClient.invalidateQueries();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight text-[#333333]">Employees</h1>
        <Button onClick={handleOpenCreate} className="bg-[#CFAF42] hover:bg-[#CFAF42]/90 text-white">
          Add Employee
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editId ? "Edit Employee" : "Create Employee"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input required value={formData.name || ''} onChange={e => setFormData({...formData, name: e.target.value})} />
            </div>
            <div className="space-y-2">
              <Label>Classification Code</Label>
              <Input required value={formData.classification || ''} onChange={e => setFormData({...formData, classification: e.target.value})} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Home Rate</Label>
                <Input required type="number" step="0.01" value={formData.homeRate || ''} onChange={e => setFormData({...formData, homeRate: Number(e.target.value)})} />
              </div>
              <div className="space-y-2">
                <Label>Field Rate</Label>
                <Input type="number" step="0.01" value={formData.fieldRate || ''} onChange={e => setFormData({...formData, fieldRate: Number(e.target.value)})} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Default Task No.</Label>
              <Input value={formData.defaultTaskNo || ''} onChange={e => setFormData({...formData, defaultTaskNo: e.target.value})} />
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox id="active" checked={formData.active} onCheckedChange={(c) => setFormData({...formData, active: c === true})} />
              <Label htmlFor="active">Active</Label>
            </div>
            <div className="pt-4 flex justify-end">
              <Button type="submit" className="bg-[#CFAF42] text-white">
                {createEmp.isPending || updateEmp.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={ratesEmpId != null} onOpenChange={(o) => { if (!o) setRatesEmpId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rate History{ratesEmp ? ` — ${ratesEmp.name}` : ""}</DialogTitle>
          </DialogHeader>
          {ratesEmp && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Base rates apply until the first change; each change takes effect on its
                date. A rate change in the middle of a billing period shows as two labor
                lines on the exported invoice, like Julie's workbook.
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Effective</TableHead>
                    <TableHead className="text-right">Home Rate</TableHead>
                    <TableHead className="text-right">Field Rate</TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="text-muted-foreground">Base (start)</TableCell>
                    <TableCell className="text-right">${ratesEmp.homeRate.toFixed(2)}</TableCell>
                    <TableCell className="text-right">{ratesEmp.fieldRate ? `$${ratesEmp.fieldRate.toFixed(2)}` : '-'}</TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                  {(ratesEmp.rateChanges ?? []).map((rc) => (
                    <TableRow key={rc.id}>
                      <TableCell>{rc.effectiveDate}</TableCell>
                      <TableCell className="text-right">${rc.homeRate.toFixed(2)}</TableCell>
                      <TableCell className="text-right">{rc.fieldRate != null ? `$${rc.fieldRate.toFixed(2)}` : '-'}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" onClick={() => removeRateChange(rc.id)}>
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <form onSubmit={submitRateChange} className="space-y-3 border-t pt-4">
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label>Effective Date</Label>
                    <Input required type="date" value={rateForm.effectiveDate}
                      onChange={e => setRateForm({ ...rateForm, effectiveDate: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label>New Home Rate</Label>
                    <Input required type="number" step="0.01" min="0.01" value={rateForm.homeRate}
                      onChange={e => setRateForm({ ...rateForm, homeRate: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label>New Field Rate</Label>
                    <Input type="number" step="0.01" min="0.01" value={rateForm.fieldRate}
                      onChange={e => setRateForm({ ...rateForm, fieldRate: e.target.value })} />
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" className="bg-[#CFAF42] text-white" disabled={createRateChange.isPending}>
                    {createRateChange.isPending ? "Adding..." : "Add Rate Change"}
                  </Button>
                </div>
              </form>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <div className="rounded-md border bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Classification</TableHead>
              <TableHead className="text-right">Home Rate</TableHead>
              <TableHead className="text-right">Field Rate</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : employees?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No employees found.
                </TableCell>
              </TableRow>
            ) : (
              employees?.map((employee) => (
                <TableRow key={employee.id}>
                  <TableCell className="font-medium">{employee.name}</TableCell>
                  <TableCell>{employee.classification}</TableCell>
                  <TableCell className="text-right">${employee.homeRate.toFixed(2)}</TableCell>
                  <TableCell className="text-right">{employee.fieldRate ? `$${employee.fieldRate.toFixed(2)}` : '-'}</TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      employee.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                    }`}>
                      {employee.active ? 'Active' : 'Inactive'}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" title="Rate history" onClick={() => setRatesEmpId(employee.id)}>
                      <CalendarClock className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleOpenEdit(employee)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(employee.id)}>
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
