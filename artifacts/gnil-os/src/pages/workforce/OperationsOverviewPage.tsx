import { useGetOperationsOverview, getGetOperationsOverviewQueryKey } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, CheckCircle2, CloudCog, ArrowRight, Zap, RefreshCw, Layers, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";

export function OperationsOverviewPage() {
  const { data, isLoading, isError, refetch } = useGetOperationsOverview({
    query: { queryKey: getGetOperationsOverviewQueryKey() }
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 border border-dashed rounded-xl bg-muted/20">
        <AlertCircle className="w-10 h-10 text-destructive mb-4" />
        <h3 className="text-lg font-medium">Failed to load overview</h3>
        <p className="text-muted-foreground text-sm max-w-md text-center mb-4">
          Could not fetch the operations overview. Please check your connection and try again.
        </p>
        <Button onClick={() => refetch()} variant="outline">Retry</Button>
      </div>
    );
  }

  const formatCapability = (cap: string) => {
    return cap.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-300 slide-in-from-bottom-2">
      {/* Top Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
        <div className="flex flex-col p-6 rounded-xl border border-border/60 bg-card shadow-sm relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
            <Users className="w-16 h-16 text-primary" />
          </div>
          <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Workforce Staff</p>
          <div className="flex items-baseline gap-3">
            <h2 className="text-4xl font-bold">{data.workforceCount}</h2>
            {data.unlinkedWorkforceCount > 0 && (
              <span className="text-sm text-amber-600 dark:text-amber-500 font-medium flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" />
                {data.unlinkedWorkforceCount} unlinked
              </span>
            )}
          </div>
          <div className="mt-auto pt-6">
            <Button variant="link" className="p-0 h-auto text-primary text-sm gap-1" asChild>
              <Link href="/operations/workforce">
                Manage Workforce <ArrowRight className="w-3 h-3" />
              </Link>
            </Button>
          </div>
        </div>

        <div className="flex flex-col p-6 rounded-xl border border-border/60 bg-card shadow-sm relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
            <Zap className="w-16 h-16 text-primary" />
          </div>
          <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Connected Providers</p>
          <div className="flex items-baseline gap-3">
            <h2 className="text-4xl font-bold">{data.connectedProviderCount}</h2>
            <span className="text-sm text-emerald-600 dark:text-emerald-500 font-medium flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Active
            </span>
          </div>
          <div className="mt-auto pt-6">
            <Button variant="link" className="p-0 h-auto text-primary text-sm gap-1" asChild>
              <Link href="/operations/integrations">
                Manage Integrations <ArrowRight className="w-3 h-3" />
              </Link>
            </Button>
          </div>
        </div>

        <div className="flex flex-col p-6 rounded-xl border border-border/60 bg-card shadow-sm relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
            <RefreshCw className="w-16 h-16 text-primary" />
          </div>
          <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Last System Sync</p>
          <h2 className="text-2xl font-bold tracking-tight mb-1">
            {data.lastSuccessfulSyncAt ? new Date(data.lastSuccessfulSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "Never"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {data.lastSuccessfulSyncAt ? new Date(data.lastSuccessfulSyncAt).toLocaleDateString() : "No successful sync recorded"}
          </p>
          <div className="mt-auto pt-6 flex items-center justify-between">
            <span className="text-xs font-mono bg-muted px-2 py-1 rounded">SYS_SYNC_OK</span>
            <CloudCog className="w-4 h-4 text-muted-foreground" />
          </div>
        </div>

        <div className={`flex flex-col p-6 rounded-xl border shadow-sm relative overflow-hidden group ${data.attentionRequiredCount > 0 ? 'border-amber-500/30 bg-amber-500/5' : 'border-border/60 bg-card'}`}>
          <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
            <AlertCircle className={`w-16 h-16 ${data.attentionRequiredCount > 0 ? 'text-amber-500' : 'text-primary'}`} />
          </div>
          <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Attention Required</p>
          <div className="flex items-baseline gap-3">
            <h2 className={`text-4xl font-bold ${data.attentionRequiredCount > 0 ? 'text-amber-600 dark:text-amber-500' : 'text-foreground'}`}>{data.attentionRequiredCount}</h2>
            {data.attentionRequiredCount > 0 && (
              <span className="text-sm text-amber-600 dark:text-amber-500 font-medium flex items-center gap-1">
                Needs Review
              </span>
            )}
          </div>
          <div className="mt-auto pt-6">
            <Button variant="link" className={`p-0 h-auto text-sm gap-1 ${data.attentionRequiredCount > 0 ? 'text-amber-600 dark:text-amber-500 hover:text-amber-700' : 'text-primary'}`} asChild>
              <Link href="/operations/integrations">
                View Issues <ArrowRight className="w-3 h-3" />
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {/* Capabilities Matrix */}
      <div className="rounded-xl border border-border/60 bg-card shadow-sm overflow-hidden">
        <div className="px-6 py-5 border-b border-border/50 bg-muted/10 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Layers className="w-5 h-5 text-primary" />
              Workforce Capability Mapping
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              Authoritative providers managing specific domains.
            </p>
          </div>
        </div>
        <div className="divide-y divide-border/40">
          {data.capabilityAssignments.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              No capability assignments found.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-0 divide-y sm:divide-y-0 sm:divide-x divide-border/40">
              {data.capabilityAssignments.map((assignment) => {
                const isAssigned = !!assignment.providerId;
                const state = assignment.state;
                let badgeVariant: "default" | "secondary" | "destructive" | "outline" = "secondary";
                let badgeLabel = "Unavailable";
                let badgeClass = "";
                let providerDetails = null;

                if (!isAssigned) {
                  badgeLabel = "Not Assigned";
                  providerDetails = (
                    <div className="flex flex-col text-sm border border-dashed border-border rounded-lg p-3 bg-muted/20">
                      <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Provider</span>
                      <span className="text-muted-foreground italic">No provider connected</span>
                    </div>
                  );
                } else {
                  // We have an assigned provider
                  if (state === "connected") {
                    badgeVariant = "default";
                    badgeLabel = "Connected";
                    badgeClass = "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary border-none";
                    providerDetails = (
                      <div className="flex flex-col text-sm border border-border/50 rounded-lg p-3 bg-background">
                        <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Provider</span>
                        <span className="font-semibold text-foreground">{assignment.providerName}</span>
                        {assignment.syncStatus === "syncing" && (
                          <span className="text-[10px] flex items-center gap-1 mt-1.5 text-muted-foreground font-medium uppercase tracking-wider"><RefreshCw className="w-3 h-3 animate-spin" /> Syncing</span>
                        )}
                      </div>
                    );
                  } else if (state === "missing_scope") {
                    badgeVariant = "outline";
                    badgeLabel = "Needs Auth";
                    badgeClass = "bg-amber-500/10 text-amber-600 border-amber-500/20";
                    providerDetails = (
                      <div className="flex flex-col text-sm border border-amber-500/30 rounded-lg p-3 bg-amber-500/5">
                        <span className="text-xs text-amber-600/80 uppercase tracking-wider mb-1">Provider</span>
                        <span className="font-semibold text-amber-700">{assignment.providerName}</span>
                        <span className="text-xs text-amber-600 mt-1 line-clamp-1" title={assignment.missingScopes?.join(", ")}>
                          Missing: {assignment.missingScopes?.join(", ") || "scopes"}
                        </span>
                      </div>
                    );
                  } else if (state === "failed") {
                    badgeVariant = "destructive";
                    badgeLabel = "Sync Failed";
                    badgeClass = "bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/20";
                    providerDetails = (
                      <div className="flex flex-col text-sm border border-destructive/30 rounded-lg p-3 bg-destructive/5">
                        <span className="text-xs text-destructive/80 uppercase tracking-wider mb-1">Provider</span>
                        <span className="font-semibold text-destructive">{assignment.providerName}</span>
                        <span className="text-[10px] font-mono text-destructive/80 mt-1 line-clamp-1" title={assignment.syncLastError || "Unknown error"}>
                          {assignment.syncLastError || "Unknown error"}
                        </span>
                      </div>
                    );
                  } else {
                    // unavailable but assigned
                    badgeVariant = "secondary";
                    badgeLabel = "Unavailable";
                    providerDetails = (
                      <div className="flex flex-col text-sm border border-dashed border-border rounded-lg p-3 bg-muted/20">
                        <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Provider</span>
                        <span className="font-semibold text-muted-foreground line-through opacity-70">{assignment.providerName}</span>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">{assignment.providerStatus?.replace(/_/g, ' ') || "disconnected"}</span>
                      </div>
                    );
                  }
                }

                return (
                  <div key={assignment.capability} className="p-5 flex flex-col justify-between hover:bg-muted/10 transition-colors">
                    <div className="mb-4 flex items-center justify-between">
                      <span className="font-medium text-foreground">{formatCapability(assignment.capability)}</span>
                      <Badge variant={badgeVariant} className={badgeClass}>
                        {badgeLabel}
                      </Badge>
                    </div>
                    {providerDetails}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
