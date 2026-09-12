import { useListOperationsPayroll, useGetOperationsOverview, getListOperationsPayrollQueryKey, getGetOperationsOverviewQueryKey } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { DollarSign, CheckCircle2, Clock, AlertCircle, Zap } from "lucide-react";
import { formatMoneyExact } from "@/lib/formatMoneyExact";

function formatDate(isoString: string | null | undefined) {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleDateString();
}

export function PayrollStatePage() {
  const { data: overview, isLoading: overviewLoading, isError: overviewError } = useGetOperationsOverview({
    query: { queryKey: getGetOperationsOverviewQueryKey() }
  });

  const payrollAssignment = overview?.capabilityAssignments.find(a => a.capability === "payroll");
  const provider = overview?.providers.find(p => p.providerId === payrollAssignment?.providerId);
  
  // Explicit assignment state branching based on the generated enum values
  const state = payrollAssignment?.state;
  const isAssigned = !!payrollAssignment?.providerId;
  const isHealthy = provider && ["connected", "syncing", "degraded"].includes(provider.status);
  const isAvailable = state === "connected" && isHealthy;

  const { data: runs, isLoading: runsLoading, isError: runsError } = useListOperationsPayroll({
    query: { 
      enabled: !!isAvailable,
      queryKey: getListOperationsPayrollQueryKey() 
    }
  });

  if (overviewLoading || (isAvailable && runsLoading)) return <Skeleton className="h-72 rounded-xl" />;
  
  if (overviewError || (isAvailable && runsError)) {
    return (
      <div className="rounded-xl border border-destructive/30 p-6 text-destructive flex items-start gap-3 bg-destructive/5">
        <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
        <div>
          <h3 className="font-semibold mb-1">Unable to load payroll</h3>
          <p className="text-sm">There was a problem fetching payroll runs. Check your connection or provider state.</p>
        </div>
      </div>
    );
  }

  if (!isAvailable) {
    let title = "No Provider Connected";
    let description = "No provider currently manages this capability. Connect and configure a supported provider to enable payroll visibility.";
    let icon = <Zap className="w-8 h-8 text-muted-foreground opacity-50" />;
    
    if (isAssigned) {
      if (state === "missing_scope") {
        title = "Permissions Required";
        description = `The ${payrollAssignment.providerName || "assigned provider"} connection is active, but lacks required permissions. Please reconnect or manage the integration to grant: ${payrollAssignment.missingScopes?.join(", ") || "payroll access"}.`;
        icon = <AlertCircle className="w-8 h-8 text-amber-500 opacity-80" />;
      } else if (state === "failed") {
        title = "Sync Failed";
        description = `The ${payrollAssignment.providerName || "assigned provider"} sync failed: ${payrollAssignment.syncLastError || "Unknown error"}. Please check the integration.`;
        icon = <AlertCircle className="w-8 h-8 text-destructive opacity-80" />;
      } else if (state === "unavailable") {
        title = "Provider Unavailable";
        description = `The assigned provider (${payrollAssignment.providerName || "Unknown"}) is not currently available or connected properly.`;
        icon = <AlertCircle className="w-8 h-8 text-amber-500 opacity-80" />;
      } else {
        // Fallback for any other non-connected but assigned state
        title = "Provider Attention Required";
        description = `The ${payrollAssignment.providerName || "assigned provider"} connection requires attention. Please resolve the issue to restore payroll visibility.`;
        icon = <AlertCircle className="w-8 h-8 text-amber-500 opacity-80" />;
      }
    }

    return (
      <div className="space-y-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between p-5 rounded-xl border border-border/60 bg-card shadow-sm">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-primary" />
              Payroll Runs
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              W-2 and 1099 payroll runs, tax documentation, and compensation structures.
            </p>
          </div>
        </div>
        
        <div className="flex flex-col items-center justify-center p-12 border border-dashed rounded-xl bg-muted/5 animate-in fade-in">
          <div className="size-16 rounded-full bg-muted flex items-center justify-center mb-4">
            {icon}
          </div>
          <h3 className="text-xl font-semibold mb-2 text-foreground">{title}</h3>
          <p className="text-muted-foreground text-center max-w-md mb-6">
            {description}
          </p>
          <Button asChild>
            <Link href="/operations/integrations">
              {!isAssigned ? "Browse Integrations" : "Manage Integrations"}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between p-5 rounded-xl border border-border/60 bg-card shadow-sm">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-primary" />
            Payroll Runs
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Payroll is managed by {provider?.name}. GNIL provides operational visibility into recent runs, not payroll processing.
          </p>
        </div>
      </div>

      {!runs || runs.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground bg-muted/5">
          <DollarSign className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
          No payroll runs found.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-5 py-4 font-medium">Pay Period</th>
                <th className="px-5 py-4 font-medium">Payment Date</th>
                <th className="px-5 py-4 font-medium">Status</th>
                <th className="px-5 py-4 font-medium text-right">Gross Pay</th>
                <th className="px-5 py-4 font-medium text-right">Net Pay</th>
                <th className="px-5 py-4 font-medium">Last Synced</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {runs.map((run) => (
                <tr key={run.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-5 py-4">
                    <div className="font-medium text-foreground">
                      {formatDate(run.payPeriodStart)} – {formatDate(run.payPeriodEnd)}
                    </div>
                  </td>
                  <td className="px-5 py-4 text-muted-foreground">
                    {formatDate(run.paymentDate)}
                  </td>
                  <td className="px-5 py-4">
                    {run.status === "paid" || run.status === "processed" ? (
                      <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 border-emerald-500/20">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        {run.status.charAt(0).toUpperCase() + run.status.slice(1)}
                      </Badge>
                    ) : run.status === "cancelled" ? (
                      <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20">
                        Cancelled
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="bg-muted text-muted-foreground">
                        <Clock className="w-3 h-3 mr-1" />
                        {run.status.charAt(0).toUpperCase() + run.status.slice(1)}
                      </Badge>
                    )}
                  </td>
                  <td className="px-5 py-4 text-right font-medium">
                    {formatMoneyExact(run.grossPayCents, run.currency)}
                  </td>
                  <td className="px-5 py-4 text-right font-medium">
                    {formatMoneyExact(run.netPayCents, run.currency)}
                  </td>
                  <td className="px-5 py-4 text-muted-foreground text-xs whitespace-nowrap">
                    {new Date(run.lastSyncedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
