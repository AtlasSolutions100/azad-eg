import { useGetDashboardSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";

export default function Dashboard() {
  const { data: summary, isLoading, error } = useGetDashboardSummary();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (error || !summary) {
    return <div className="text-red-500">Failed to load dashboard summary.</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight text-[#333333]">Dashboard</h1>
      
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#5F5F5F]">Total Invoices</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.totalInvoices}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#5F5F5F]">Draft Invoices</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.draftCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#5F5F5F]">Approved Invoices</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.approvedCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#5F5F5F]">Active Work Plans</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.activeWorkPlans}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {summary.recentActivity?.slice(0, 5).map(log => (
                <div key={log.id} className="flex items-start justify-between border-b pb-2 last:border-0">
                  <div>
                    <p className="text-sm font-medium">{log.action}</p>
                    <p className="text-xs text-[#5F5F5F]">{log.entityType} #{log.entityId}</p>
                  </div>
                  <div className="text-xs text-[#5F5F5F]">
                    {format(new Date(log.createdAt), "MMM d, yyyy HH:mm")}
                  </div>
                </div>
              ))}
              {(!summary.recentActivity || summary.recentActivity.length === 0) && (
                <div className="text-sm text-gray-500">No recent activity.</div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Billing by Work Plan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {summary.billingByWorkPlan?.map(plan => (
                <div key={plan.workPlanCode} className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{plan.workPlanCode}</span>
                    <span className="text-[#5F5F5F]">
                      ${plan.billed.toLocaleString()} / ${plan.budget.toLocaleString()}
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-gray-100">
                    <div 
                      className="h-full rounded-full bg-primary" 
                      style={{ width: `${Math.min(100, (plan.billed / plan.budget) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
              {(!summary.billingByWorkPlan || summary.billingByWorkPlan.length === 0) && (
                <div className="text-sm text-gray-500">No work plans.</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
