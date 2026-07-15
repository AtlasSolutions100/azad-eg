import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useListInvoices, useCreateInvoice, useListWorkPlans, InvoiceInput } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Pin } from "lucide-react";
import { format } from "date-fns";

export default function Invoices() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [, setLocation] = useLocation();
  const { data: invoices, isLoading } = useListInvoices({ status: statusFilter !== "all" ? statusFilter : undefined });
  const { data: workPlans } = useListWorkPlans();
  const createInvoice = useCreateInvoice();

  const [open, setOpen] = useState(false);
  const [formData, setFormData] = useState<Partial<InvoiceInput>>({
    invoiceDate: new Date().toISOString().split('T')[0],
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.workPlanId || !formData.invoiceNumber || !formData.invoiceDate || !formData.periodStart || !formData.periodEnd) return;
    
    try {
      const res = await createInvoice.mutateAsync({
        data: formData as InvoiceInput
      });
      setOpen(false);
      setLocation(`/invoices/${res.id}`);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight text-[#333333]">Invoices</h1>
        <div className="flex items-center gap-4">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="in_review">In Review</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="exported">Exported</SelectItem>
            </SelectContent>
          </Select>

          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="bg-[#CFAF42] hover:bg-[#CFAF42]/90 text-white">New Invoice</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Invoice</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                <div className="space-y-2">
                  <Label>Work Plan</Label>
                  <Select onValueChange={(val) => setFormData({ ...formData, workPlanId: Number(val) })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a work plan" />
                    </SelectTrigger>
                    <SelectContent>
                      {workPlans?.map(wp => (
                        <SelectItem key={wp.id} value={wp.id.toString()}>{wp.code} - {wp.title}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Invoice Number</Label>
                  <Input required value={formData.invoiceNumber || ''} onChange={e => setFormData({ ...formData, invoiceNumber: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Invoice Date</Label>
                  <Input type="date" required value={formData.invoiceDate || ''} onChange={e => setFormData({ ...formData, invoiceDate: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Period Start</Label>
                    <Input type="date" required value={formData.periodStart || ''} onChange={e => setFormData({ ...formData, periodStart: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Period End</Label>
                    <Input type="date" required value={formData.periodEnd || ''} onChange={e => setFormData({ ...formData, periodEnd: e.target.value })} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Previously Billed (Optional)</Label>
                  <Input type="number" step="0.01" value={formData.previouslyBilled || ''} onChange={e => setFormData({ ...formData, previouslyBilled: Number(e.target.value) })} />
                </div>
                <Button type="submit" className="w-full bg-[#CFAF42] hover:bg-[#CFAF42]/90 text-white" disabled={createInvoice.isPending}>
                  {createInvoice.isPending ? "Creating..." : "Create Invoice"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="rounded-md border bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice #</TableHead>
              <TableHead>Work Plan</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                </TableRow>
              ))
            ) : invoices?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No invoices found.
                </TableCell>
              </TableRow>
            ) : (
              invoices?.map((invoice) => (
                <TableRow key={invoice.id} className="cursor-pointer hover:bg-gray-50 transition-colors" onClick={() => setLocation(`/invoices/${invoice.id}`)}>
                  <TableCell className="font-medium text-primary">
                    <span className="inline-flex items-center gap-1.5">
                      {invoice.invoiceNumber}
                      {invoice.carryOverManual && (
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                className="inline-flex text-amber-600"
                                onClick={(e) => e.stopPropagation()}
                                data-testid={`icon-carryover-pinned-${invoice.id}`}
                              >
                                <Pin className="h-3.5 w-3.5" aria-label="Previously billed set manually" />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              "Previously billed" was set manually
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>{invoice.workPlanCode}</TableCell>
                  <TableCell>{invoice.client}</TableCell>
                  <TableCell>{format(new Date(invoice.periodStart), "MMM d")} - {format(new Date(invoice.periodEnd), "MMM d, yyyy")}</TableCell>
                  <TableCell className="text-right">${invoice.totalThisPeriod.toLocaleString()}</TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      invoice.status === 'draft' ? 'bg-gray-100 text-gray-800' : 
                      invoice.status === 'in_review' ? 'bg-blue-100 text-blue-800' :
                      invoice.status === 'approved' ? 'bg-green-100 text-green-800' :
                      'bg-purple-100 text-purple-800'
                    }`}>
                      {invoice.status.replace('_', ' ')}
                    </span>
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
