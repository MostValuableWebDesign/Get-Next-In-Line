import { useGetOperationsOverview, getGetOperationsOverviewQueryKey } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Zap, ShieldAlert, CheckCircle2 } from "lucide-react";
import type { WorkforceCapability } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";

export function CapabilityStateView({ capability, title, description }: { capability: WorkforceCapability, title: string, description: string }) {
  const { data, isLoading, isError, refetch } = useGetOperationsOverview({
    query: { queryKey: getGetOperationsOverviewQueryKey() }
  });

  if (isLoading) {
    return <Skeleton className="h-64 rounded-xl" />;
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 border border-dashed rounded-xl bg-muted/20">
        <AlertCircle className="w-10 h-10 text-destructive mb-4" />
        <h3 className="text-lg font-medium">Failed to load capability state</h3>
        <Button onClick={() => refetch()} variant="outline" className="mt-4">Retry</Button>
      </div>
    );
  }

  const assignment = data.capabilityAssignments.find(a => a.capability === capability);
  
  if (!assignment || assignment.state !== 'connected' || !assignment.providerId) {
    return (
      <div className="flex flex-col items-center justify-center p-12 border border-dashed rounded-xl bg-muted/5 animate-in fade-in">
        <div className="size-16 rounded-full bg-muted flex items-center justify-center mb-4">
          <Zap className="w-8 h-8 text-muted-foreground opacity-50" />
        </div>
        <h3 className="text-xl font-semibold mb-2 text-foreground">No Provider Connected</h3>
        <p className="text-muted-foreground text-center max-w-md mb-6">
          No provider currently manages this capability.
        </p>
        <Button asChild>
          <Link href="/operations/integrations">Browse Integrations</Link>
        </Button>
      </div>
    );
  }

  const provider = data.providers.find(p => p.providerId === assignment.providerId);
  const statusColor = provider?.status === 'error' || provider?.status === 'degraded' || provider?.status === 'reauthorization_required' ? 'text-amber-500' : 'text-emerald-500';

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 rounded-xl border border-border/60 bg-card shadow-sm">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            {title} State
          </h2>
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        </div>
        <div className="flex flex-col md:items-end gap-1">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Managed by</span>
            <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20">
              {assignment.providerName}
            </Badge>
          </div>
          <div className="flex items-center gap-1.5 text-xs font-medium mt-1">
            <span className={`flex size-2 rounded-full ${provider?.status === 'error' ? 'bg-destructive' : 'bg-emerald-500'}`} />
            <span className="text-muted-foreground">Sync State:</span>
            <span className="capitalize">{provider?.status.replace(/_/g, ' ')}</span>
          </div>
        </div>
      </div>
      
      {provider?.status === 'error' && (
        <div className="p-4 border border-destructive/30 bg-destructive/10 rounded-xl flex items-start gap-3 text-destructive text-sm">
          <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold block mb-1">Provider Sync Error</span>
            {provider.lastError || "The connected provider is experiencing issues syncing data."}
          </div>
        </div>
      )}

      <div className="p-8 text-center border rounded-xl bg-card shadow-sm">
        <CheckCircle2 className="w-12 h-12 text-emerald-500/50 mx-auto mb-3" />
        <h3 className="font-medium text-foreground">Provider connected</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {assignment.providerName} owns this capability. Detailed normalized records will appear
          after the provider&apos;s read-only sync is enabled.
        </p>
      </div>
    </div>
  );
}
