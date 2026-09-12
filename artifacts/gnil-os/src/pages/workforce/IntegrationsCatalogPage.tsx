import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useConnectGusto,
  useDisconnectGusto,
  useReconcileGusto,
  useGetOperationsOverview,
  useSyncGustoWorkforce,
  useSyncGustoPayrollReadOnly,
  useSyncGustoCompensationReadOnly,
  getGetOperationsOverviewQueryKey,
  getListOperationsWorkforceQueryKey,
  getListOperationsPayrollQueryKey,
  getListOperationsCompensationQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, CheckCircle2, ShieldAlert, PlugZap, Check, Settings2, RefreshCw, DollarSign, Briefcase } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getCurrentSosTenantId } from "@/lib/sos-tenant";

const STATUS_CONFIG = {
  not_connected: { label: "Not Connected", variant: "secondary" as const, icon: null },
  connecting: { label: "Connecting", variant: "outline" as const, icon: <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> },
  connected: { label: "Connected", variant: "default" as const, icon: <CheckCircle2 className="w-3 h-3 mr-1" /> },
  syncing: { label: "Syncing", variant: "default" as const, icon: <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> },
  degraded: { label: "Degraded", variant: "destructive" as const, icon: <AlertCircle className="w-3 h-3 mr-1" /> },
  reauthorization_required: { label: "Needs Auth", variant: "destructive" as const, icon: <ShieldAlert className="w-3 h-3 mr-1" /> },
  error: { label: "Error", variant: "destructive" as const, icon: <AlertCircle className="w-3 h-3 mr-1" /> },
};
const CAPABILITY_SETUP_ERROR =
  "Capability configuration failed. Retry integration setup.";

type CapabilityAssignment = {
  capability: string;
  providerId?: string | null;
  state?: string | null;
};

function syncActionState(
  assignments: CapabilityAssignment[],
  capability: "employees" | "payroll" | "compensation",
) {
  const assignment = assignments.find((candidate) => candidate.capability === capability);
  if (!assignment) {
    return { enabled: false, reason: "Capability setup required" };
  }
  if (assignment.providerId !== "gusto") {
    return { enabled: false, reason: "Managed by another provider" };
  }
  if (assignment.state === "missing_scope") {
    return { enabled: false, reason: "Additional Gusto permission required" };
  }
  if (assignment.state === "failed") {
    return { enabled: false, reason: "Capability sync needs attention" };
  }
  if (assignment.state !== "connected") {
    return { enabled: false, reason: "Capability setup required" };
  }
  return { enabled: true, reason: null };
}

export function IntegrationsCatalogPage() {
  const queryClient = useQueryClient();
  const hasSelectedBusiness = getCurrentSosTenantId() != null;
  const { data, isLoading, isError, refetch } = useGetOperationsOverview({
    query: { queryKey: getGetOperationsOverviewQueryKey() }
  });

  const [actionError, setActionError] = useState<string | null>(null);
  const gustoConnect = useConnectGusto({
    mutation: {
    onSuccess: ({ authorizationUrl }) => window.location.assign(authorizationUrl),
    onError: (error) => setActionError(error instanceof Error ? error.message : "Unable to connect Gusto"),
    },
  });
  const gustoDisconnect = useDisconnectGusto({
    mutation: {
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: getGetOperationsOverviewQueryKey() }),
      onError: (error) =>
        setActionError(error instanceof Error ? error.message : "Unable to disconnect Gusto"),
    },
  });
  const gustoReconcile = useReconcileGusto({
    mutation: {
      onSuccess: () => {
        setActionError(null);
        queryClient.invalidateQueries({ queryKey: getGetOperationsOverviewQueryKey() });
      },
      onError: () =>
        setActionError("Unable to complete Gusto setup. Please try again."),
    },
  });
  const gustoSync = useSyncGustoWorkforce({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetOperationsOverviewQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListOperationsWorkforceQueryKey() });
      },
      onError: (error) =>
        setActionError(error instanceof Error ? error.message : "Unable to synchronize Gusto"),
    },
  });

  const gustoSyncPayroll = useSyncGustoPayrollReadOnly({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetOperationsOverviewQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListOperationsPayrollQueryKey() });
      },
      onError: (error) =>
        setActionError(error instanceof Error ? error.message : "Unable to sync payroll"),
    },
  });

  const gustoSyncComp = useSyncGustoCompensationReadOnly({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetOperationsOverviewQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListOperationsCompensationQueryKey() });
      },
      onError: (error) =>
        setActionError(error instanceof Error ? error.message : "Unable to sync compensation"),
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1,2,3].map(i => <Skeleton key={i} className="h-32 rounded-xl" />)}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 border border-dashed rounded-xl bg-muted/20">
        <AlertCircle className="w-10 h-10 text-destructive mb-4" />
        <h3 className="text-lg font-medium">Failed to load integrations</h3>
        <Button onClick={() => refetch()} variant="outline" className="mt-4">Retry</Button>
      </div>
    );
  }

  const handleManage = (provider: { providerId: string; status: string }) => {
    setActionError(null);
    if (provider.providerId !== "gusto") return;
    if (!hasSelectedBusiness) {
      setActionError("Select a business before connecting a workforce provider.");
      return;
    }
    if (["connected", "syncing", "degraded"].includes(provider.status)) return;
    gustoConnect.mutate();
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex items-center justify-between mb-2">
        <p className="text-muted-foreground text-sm">
          Connect specialist workforce systems while GNIL remains authoritative for bookings, queues, services, chairs, and customer relationships.
        </p>
      </div>
      {actionError && (
        <div className="p-3 border border-destructive/20 bg-destructive/5 rounded-lg text-sm text-destructive">
          {actionError}
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        {data.providers.map((provider) => {
          const config = STATUS_CONFIG[provider.status] || STATUS_CONFIG.not_connected;
          const isActive = provider.status === 'connected' || provider.status === 'syncing' || provider.status === 'degraded';
          const canRetrySetup =
            provider.providerId === "gusto" &&
            provider.status === "degraded" &&
            provider.lastError === CAPABILITY_SETUP_ERROR;
          const staffSyncState = syncActionState(data.capabilityAssignments, "employees");
          const payrollSyncState = syncActionState(data.capabilityAssignments, "payroll");
          const compensationSyncState = syncActionState(
            data.capabilityAssignments,
            "compensation",
          );
          
          return (
            <div key={provider.providerId} className={`flex flex-col border rounded-xl overflow-hidden transition-all duration-300 hover:shadow-md ${isActive ? 'border-primary/30 shadow-sm bg-card' : 'border-border/60 bg-muted/5'}`}>
              <div className="p-5 flex-1">
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center gap-3">
                    <div className={`size-12 rounded-lg flex items-center justify-center text-xl font-bold shadow-sm transition-colors ${isActive ? 'bg-primary text-primary-foreground' : 'bg-background border text-muted-foreground'}`}>
                      {provider.name.charAt(0)}
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold tracking-tight leading-tight">{provider.name}</h3>
                      {provider.preferred && (
                        <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20 text-[9px] uppercase tracking-wider h-4 px-1.5 mt-1">Preferred Partner</Badge>
                      )}
                    </div>
                  </div>
                  <Badge variant={config.variant} className={isActive ? 'bg-emerald-500 hover:bg-emerald-600 text-white' : ''}>
                    {config.icon}
                    {config.label}
                  </Badge>
                </div>
                
                <p className="text-sm text-muted-foreground line-clamp-2 min-h-[2.5rem] mb-5">
                  {provider.description}
                </p>
                
                <div className="pt-4 border-t border-border/50">
                  <h4 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-1.5">
                    <PlugZap className="w-3.5 h-3.5" /> Capabilities
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {provider.capabilities.length > 0 ? (
                      provider.capabilities.map(cap => (
                        <span key={cap} className="px-2 py-1 bg-muted/50 border rounded-md text-xs text-foreground font-medium transition-colors hover:bg-muted">
                          {cap.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground italic">None listed</span>
                    )}
                  </div>
                </div>
                
                {provider.lastError && (
                  <div className="mt-4 p-3 border border-destructive/20 bg-destructive/5 rounded-lg text-xs text-destructive flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{provider.lastError}</span>
                  </div>
                )}
              </div>
              
              <div className={`px-5 py-3 flex items-center justify-between transition-colors ${isActive ? 'bg-primary/5 border-t border-primary/10' : 'bg-muted/30 border-t border-border/50'}`}>
                <div className="text-xs text-muted-foreground font-medium">
                  {provider.lastSuccessfulSyncAt ? (
                    <span className="flex items-center gap-1.5">
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                      Synced {new Date(provider.lastSuccessfulSyncAt).toLocaleDateString()}
                    </span>
                  ) : (
                    <span>No sync history</span>
                  )}
                </div>
                {isActive ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" className="h-8 px-4">
                        <Settings2 className="w-3.5 h-3.5 mr-1.5" /> Manage
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {canRetrySetup && (
                        <DropdownMenuItem
                          disabled={gustoReconcile.isPending}
                          onClick={() => {
                            setActionError(null);
                            gustoReconcile.mutate();
                          }}
                        >
                          <RefreshCw
                            className={`mr-2 h-4 w-4 ${
                              gustoReconcile.isPending ? "animate-spin" : ""
                            }`}
                          />
                          Retry Setup
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        disabled={!staffSyncState.enabled || gustoSync.isPending}
                        onClick={() => staffSyncState.enabled && gustoSync.mutate()}
                      >
                        <RefreshCw className={`mr-2 h-4 w-4 ${gustoSync.isPending ? "animate-spin" : ""}`} />
                        <span className="flex flex-col">
                          <span>Sync staff</span>
                          {staffSyncState.reason && (
                            <span className="text-[10px] text-muted-foreground">
                              {staffSyncState.reason}
                            </span>
                          )}
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!payrollSyncState.enabled || gustoSyncPayroll.isPending}
                        onClick={() => payrollSyncState.enabled && gustoSyncPayroll.mutate()}
                      >
                        <DollarSign className={`mr-2 h-4 w-4 ${gustoSyncPayroll.isPending ? "animate-spin" : ""}`} />
                        <span className="flex flex-col">
                          <span>Sync payroll</span>
                          {payrollSyncState.reason && (
                            <span className="text-[10px] text-muted-foreground">
                              {payrollSyncState.reason}
                            </span>
                          )}
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!compensationSyncState.enabled || gustoSyncComp.isPending}
                        onClick={() => compensationSyncState.enabled && gustoSyncComp.mutate()}
                      >
                        <Briefcase className={`mr-2 h-4 w-4 ${gustoSyncComp.isPending ? "animate-spin" : ""}`} />
                        <span className="flex flex-col">
                          <span>Sync compensation</span>
                          {compensationSyncState.reason && (
                            <span className="text-[10px] text-muted-foreground">
                              {compensationSyncState.reason}
                            </span>
                          )}
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        disabled={gustoDisconnect.isPending}
                        onClick={() => gustoDisconnect.mutate()}
                      >
                        Disconnect Gusto
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                <Button size="sm" variant="default" disabled={gustoConnect.isPending} onClick={() => handleManage(provider)} className="h-8 px-4 transition-all">
                  {provider.status === "error" || provider.status === "reauthorization_required"
                    ? "Reconnect Gusto"
                    : "Connect Gusto"}
                </Button>
                )}
              </div>
            </div>
          );
        })}
        {data.providers.length === 0 && (
          <div className="col-span-full py-16 text-center text-muted-foreground border border-dashed rounded-xl flex flex-col items-center justify-center">
            <PlugZap className="w-12 h-12 text-muted-foreground/30 mb-4" />
            <p className="font-medium text-foreground">No integrations available</p>
            <p className="text-sm mt-1">There are no provider systems in the catalog yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
