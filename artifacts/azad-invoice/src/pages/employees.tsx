import { useState } from "react";
import { useListEmployees, useCreateEmployee, useUpdateEmployee, useDeleteEmployee, EmployeeInput, EmployeeUpdate } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Trash2, Edit } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Checkbox } from "@/components/ui/checkbox";

export default function Employees() {
  const { data: employees, isLoading } = useListEmployees();
  const createEmp = useCreateEmployee();
  const updateEmp = useUpdateEmployee();
  const deleteEmp = useDeleteEmployee();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [formData, setFormData] = useState<Partial<EmployeeInput>>({ active: true });

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
