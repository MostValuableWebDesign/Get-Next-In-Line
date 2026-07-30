import { useAllTenants } from '@/hooks/useAllTenants';
import React, { useState } from 'react';
import { 
  useListSosVisits, useListSosResources, useListSosWaitlist,
  useAdvanceSosVisit, useCheckInSosVisit, useClaimSosWaitlistSlot,
  useUpdateSosResource, useCreateSosResource, useDeleteSosResource,
  getListSosVisitsQueryKey, getListSosResourcesQueryKey, getListSosWaitlistQueryKey,
  useGetSosSettings, getGetSosSettingsQueryKey,
  useGetSosDashboard, getGetSosDashboardQueryKey,
  useListTenants,
  SosVisitStatus,
  type SosCustomer
} from '@workspace/api-client-react';
import { CustomerPicker } from '@/components/sos/customer-picker';
import { ServiceTypeInput } from '@/components/sos/service-type-input';
import { parseTenantParam } from '@/lib/sos-tenant';
import { Link, useLocation, useSearch } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Play, ArrowRight, CheckSquare, Bell, CreditCard, Check, LogOut, Clock, Plus, Settings2, Trash2, AlertTriangle } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function OperationsPage({ embedded = false }: { embedded?: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const searchString = useSearch();
  const [location, setLocation] = useLocation();

  // Selected business scope — same ?tenant=<id> URL contract as the other
  // SOS pages, so staff always see which business's live queue is on screen.
  const selectedTenant = parseTenantParam(searchString);
  const { data: tenants } = useAllTenants();
  const selectedTenantName = tenants?.find(t => t.id === selectedTenant)?.brandName ?? null;
  const changeTenant = (v: string) => {
    const tenant = v === 'all' ? null : Number(v);
    setLocation(tenant == null ? location : `${location}?tenant=${tenant}`, { replace: true });
  };
  
  // Live polling
  const { data: visits } = useListSosVisits(
    { active: true },
    { query: { queryKey: getListSosVisitsQueryKey({ active: true }), refetchInterval: 5000 } },
  );
  const { data: resources } = useListSosResources({
    query: { queryKey: getListSosResourcesQueryKey(), refetchInterval: 5000 },
  });
  const { data: waitlist } = useListSosWaitlist({
    query: { queryKey: getListSosWaitlistQueryKey(), refetchInterval: 5000 },
  });
  // Read-only: waitlist rules are edited only in Configuration.
  const { data: settings } = useGetSosSettings({
    query: { queryKey: getGetSosSettingsQueryKey() },
  });
  // Dashboard counters — used here to surface today's failed SMS attempts so
  // Twilio rejections (invalid number, carrier block, …) never go unnoticed.
  const { data: dashboard } = useGetSosDashboard({
    query: { queryKey: getGetSosDashboardQueryKey(), refetchInterval: 30000 },
  });
  const failedSmsToday = dashboard?.messagesFailedToday ?? 0;
  const messageLogHref = `/bookings?tab=ai-receptionist${selectedTenant != null ? `&tenant=${selectedTenant}` : ''}`;

  const advanceVisit = useAdvanceSosVisit();
  const updateResource = useUpdateSosResource();
  const claimSlot = useClaimSosWaitlistSlot();
  const deleteResource = useDeleteSosResource();
  const [resourceToDelete, setResourceToDelete] = useState<{ id: number; name: string } | null>(null);

  const handleDeleteResource = () => {
    if (!resourceToDelete) return;
    deleteResource.mutate(
      { id: resourceToDelete.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosResourcesQueryKey() });
          toast({ title: 'Resource removed', description: `${resourceToDelete.name} was deleted.` });
          setResourceToDelete(null);
        },
        onError: (err: any) => {
          toast({
            title: 'Could not delete resource',
            description: err?.response?.data?.message || err?.message || 'Deletion failed. Please try again.',
            variant: 'destructive',
          });
          setResourceToDelete(null);
        },
      },
    );
  };

  const handleAdvance = (id: number, action: any, extraData: any = {}) => {
    advanceVisit.mutate(
      { id, data: { action, ...extraData } },
      {
        onSuccess: (updated) => {
          queryClient.invalidateQueries({ queryKey: getListSosVisitsQueryKey({ active: true }) });
          queryClient.invalidateQueries({ queryKey: getListSosResourcesQueryKey() });
          // Surface a failed/skipped "you're next" text — the visit still
          // advanced, but staff must know the customer was NOT reached.
          const notification = (updated as any)?.notification;
          if (action === 'notify' && notification && notification.status !== 'sent' && notification.status !== 'simulated' && notification.status !== 'delivered') {
            toast({
              title: 'Customer was not notified',
              description: notification.error || `The notification SMS was ${notification.status ?? 'not sent'}. Reach out to the customer directly.`,
              variant: 'destructive',
            });
          } else {
            toast({ title: 'Visit advanced', description: `Action ${action} successful.` });
          }
        },
        onError: (err: any) => {
          toast({
            title: 'Could not advance visit',
            description: err?.response?.data?.message || err?.message || 'The action failed. Please try again.',
            variant: 'destructive',
          });
        },
      }
    );
  };

  const handleClaim = (id: number) => {
    claimSlot.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosWaitlistQueryKey() });
          toast({ title: 'Slot claimed', description: 'Waitlist entry converted to appointment.' });
        },
        onError: (err: any) => {
          toast({
            title: 'Could not claim slot',
            description: err?.response?.data?.message || err?.message || 'Claiming the slot failed. Please try again.',
            variant: 'destructive',
          });
        },
      }
    );
  };

  // Resource status changes: track the row being saved so the Select can
  // show a pending state, and pause the 5s poll from overwriting the
  // optimistic outcome (cancel in-flight fetches before mutating).
  const [savingResourceId, setSavingResourceId] = useState<number | null>(null);
  const handleResourceStatusChange = async (id: number, status: string) => {
    setSavingResourceId(id);
    await queryClient.cancelQueries({ queryKey: getListSosResourcesQueryKey() });
    updateResource.mutate(
      { id, data: { status: status as any } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosResourcesQueryKey() });
        },
        onError: (err: any) => {
          queryClient.invalidateQueries({ queryKey: getListSosResourcesQueryKey() });
          toast({
            title: 'Could not update resource',
            description: err?.response?.data?.message || err?.message || 'The status change failed. Please try again.',
            variant: 'destructive',
          });
        },
        onSettled: () => setSavingResourceId(null),
      }
    );
  };

  return (
    <div className={embedded ? "flex flex-col space-y-6" : "p-6 h-full flex flex-col space-y-6 max-w-[1600px] mx-auto"}>
      <div className="flex justify-between items-center shrink-0">
        <div>
          {embedded ? (
            <>
              <h2 className="text-xl font-semibold tracking-tight">Live Operations</h2>
              <p className="text-muted-foreground text-sm mt-1">
                {selectedTenant != null ? (
                  <>
                    Showing{' '}
                    <span className="font-medium" data-testid="text-operations-business-scope">
                      {selectedTenantName ?? `business #${selectedTenant}`}
                    </span>{' '}
                    only.
                  </>
                ) : (
                  'Active visits, resources, and the smart waitlist — all businesses (legacy).'
                )}
              </p>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-bold tracking-tight">Operations Center</h1>
              <p className="text-muted-foreground text-sm mt-1">
                {selectedTenant != null ? (
                  <>
                    Showing{' '}
                    <span className="font-medium" data-testid="text-operations-business-scope">
                      {selectedTenantName ?? `business #${selectedTenant}`}
                    </span>{' '}
                    only.
                  </>
                ) : (
                  'Live command center for active visits and resources — all businesses (legacy).'
                )}
              </p>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Select
            value={selectedTenant != null ? String(selectedTenant) : 'all'}
            onValueChange={changeTenant}
          >
            <SelectTrigger className="w-[220px]" data-testid="select-operations-business">
              <SelectValue placeholder="All businesses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All businesses (legacy)</SelectItem>
              {tenants?.map(t => (
                <SelectItem key={t.id} value={String(t.id)} data-testid={`option-operations-business-${t.id}`}>
                  {t.brandName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <CheckInDialog />
        </div>
      </div>

      {failedSmsToday > 0 && (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 shrink-0"
          data-testid="banner-failed-sms"
        >
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span data-testid="text-failed-sms-count">
              <span className="font-semibold">{failedSmsToday}</span>{' '}
              text message{failedSmsToday === 1 ? '' : 's'} failed to deliver today. Those customers were not reached.
            </span>
          </div>
          <Button asChild variant="outline" size="sm" className="h-7 text-xs shrink-0" data-testid="link-failed-sms-log">
            <Link href={messageLogHref}>Review message log</Link>
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1 min-h-0">
        
        {/* Zone 1: Live Queue (Middle/Left large zone) */}
        <div className="lg:col-span-6 flex flex-col min-h-0 bg-card border rounded-lg shadow-sm">
          <div className="p-4 border-b bg-muted/30 shrink-0">
            <h2 className="font-semibold flex items-center gap-2">
              <Play className="h-4 w-4 text-primary" /> Live Queue
            </h2>
          </div>
          <div className="p-4 overflow-y-auto space-y-3 flex-1">
            {visits?.map(visit => (
              <VisitCard key={visit.id} visit={visit} onAdvance={handleAdvance} resources={resources || []} />
            ))}
            {visits?.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">No active visits. Queue is empty.</div>
            )}
          </div>
        </div>

        {/* Right side split between Resources and Waitlist */}
        <div className="lg:col-span-6 flex flex-col gap-6 min-h-0">
          
          {/* Zone 2: Resource Board */}
          <div className="flex-1 flex flex-col min-h-0 bg-card border rounded-lg shadow-sm">
            <div className="p-4 border-b bg-muted/30 flex justify-between items-center shrink-0">
              <h2 className="font-semibold flex items-center gap-2">
                <CheckSquare className="h-4 w-4 text-primary" /> Resource Board
              </h2>
              <AddResourceDialog />
            </div>
            <div className="p-4 overflow-y-auto grid grid-cols-2 gap-3 flex-1">
              {resources?.map(res => (
                <div key={res.id} className="border rounded-md p-3 flex flex-col gap-2">
                  <div className="flex justify-between items-start">
                    <div className="font-medium text-sm">{res.name}</div>
                    <ResourceStatusBadge status={res.status} />
                  </div>
                  <div className="text-xs text-muted-foreground">{res.resourceType}</div>
                  {res.currentCustomerName && (
                    <div className="text-sm bg-primary/10 text-primary px-2 py-1 rounded mt-1">
                      {res.currentCustomerName}
                    </div>
                  )}
                  <div className="mt-auto pt-2 flex justify-between items-center border-t border-border/50">
                    <Select 
                      value={res.status} 
                      disabled={savingResourceId === res.id}
                      onValueChange={(val) => handleResourceStatusChange(res.id, val)}
                    >
                      <SelectTrigger
                        className="h-7 text-xs w-[110px]"
                        data-testid={`select-resource-status-${res.id}`}
                        aria-busy={savingResourceId === res.id}
                      >
                        <SelectValue>{savingResourceId === res.id ? 'Saving…' : undefined}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="available">Available</SelectItem>
                        <SelectItem value="occupied">Occupied</SelectItem>
                        <SelectItem value="cleaning">Cleaning</SelectItem>
                        <SelectItem value="offline">Offline</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                      aria-label={`Delete ${res.name}`}
                      data-testid={`btn-delete-resource-${res.id}`}
                      onClick={() => {
                        if (res.status === 'occupied' || res.currentCustomerName) {
                          toast({
                            title: 'Resource is in use',
                            description: `${res.name} is currently occupied. Finish or reassign the active visit before deleting it.`,
                            variant: 'destructive',
                          });
                          return;
                        }
                        setResourceToDelete({ id: res.id, name: res.name });
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Zone 3: Smart Waitlist */}
          <div className="flex-1 flex flex-col min-h-0 bg-card border rounded-lg shadow-sm">
            <div className="p-4 border-b bg-muted/30 shrink-0 flex justify-between items-center gap-2">
              <h2 className="font-semibold flex items-center gap-2">
                <Clock className="h-4 w-4 text-primary" /> Smart Waitlist
              </h2>
              <div className="flex items-center gap-2">
                {settings && (
                  <Badge
                    variant={settings.waitlistAutoFillEnabled ? 'default' : 'secondary'}
                    className="text-[10px]"
                    data-testid="badge-waitlist-autofill-status"
                  >
                    {settings.waitlistAutoFillEnabled ? 'Auto-fill On' : 'Auto-fill Off'}
                  </Badge>
                )}
                <Button
                  asChild
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground"
                  data-testid="link-manage-waitlist-settings"
                >
                  <Link href="/settings#sos-operations">Manage in Configuration</Link>
                </Button>
              </div>
            </div>
            <div className="p-4 overflow-y-auto space-y-3 flex-1">
              {waitlist?.map(entry => (
                <div key={entry.id} className="border rounded p-3 text-sm flex flex-col gap-2">
                  <div className="flex justify-between">
                    <span className="font-medium">{entry.customerName}</span>
                    <Badge variant="secondary" className="text-[10px]">{entry.status}</Badge>
                  </div>
                  <div className="text-muted-foreground text-xs">{entry.desiredService}</div>
                  {entry.status === 'notified' && entry.openSlotStartsAt && (
                    <div className="bg-blue-50 dark:bg-blue-900/20 p-2 rounded flex justify-between items-center mt-1">
                      <div className="text-xs text-blue-700 dark:text-blue-300">
                        Slot: {new Date(entry.openSlotStartsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      <Button size="sm" className="h-7 text-xs" onClick={() => handleClaim(entry.id)}>Claim Slot</Button>
                    </div>
                  )}
                </div>
              ))}
              {waitlist?.length === 0 && (
                <div className="text-center py-8 text-muted-foreground text-sm">Waitlist is empty.</div>
              )}
            </div>
          </div>

        </div>
      </div>

      <AlertDialog open={!!resourceToDelete} onOpenChange={(open) => { if (!open) setResourceToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete resource?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove {resourceToDelete?.name} from the Resource Board. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="btn-cancel-delete-resource">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="btn-confirm-delete-resource"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteResource}
              disabled={deleteResource.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ResourceStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    available: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200",
    occupied: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200",
    cleaning: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200",
    offline: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400 border-gray-200"
  };
  return <Badge variant="outline" className={`text-[10px] uppercase ${colors[status] || ''}`}>{status}</Badge>;
}

function VisitCard({ visit, onAdvance, resources }: { visit: any, onAdvance: any, resources: any[] }) {
  const [assignRes, setAssignRes] = useState<string>("");
  const [payAmount, setPayAmount] = useState<string>("");

  const actions: Record<string, any> = {
    checked_in: { next: 'queue', label: 'Queue', icon: ArrowRight },
    queued: { next: 'assign', label: 'Assign Resource', icon: CheckSquare, needsRes: true },
    assigned: { next: 'notify', label: 'Notify Client', icon: Bell },
    notified: { next: 'start_service', label: 'Start Service', icon: Play },
    in_service: { next: 'request_payment', label: 'Req Payment', icon: CreditCard, needsPay: true },
    payment: { next: 'check_out', label: 'Check Out', icon: LogOut }
  };

  const action = actions[visit.status];

  return (
    <div className="border rounded-lg p-4 flex flex-col gap-3 bg-background hover:border-primary/30 transition-colors">
      <div className="flex justify-between items-start">
        <div>
          <div className="font-semibold text-lg">{visit.customerName}</div>
          <div className="text-sm text-muted-foreground flex gap-2 items-center mt-1">
            <span>{visit.serviceType}</span>
            <span>•</span>
            <span>Party of {visit.partySize}</span>
            {visit.resourceName && (
              <><span>•</span><span className="text-primary font-medium">{visit.resourceName}</span></>
            )}
          </div>
        </div>
        <Badge variant="outline" className="uppercase tracking-wider text-[10px] font-bold py-1">
          {visit.status.replace('_', ' ')}
        </Badge>
      </div>
      
      {action && (
        <div className="flex gap-2 items-center mt-2 border-t pt-3">
          {action.needsRes && (
            <Select value={assignRes} onValueChange={setAssignRes}>
              <SelectTrigger className="w-[180px] h-9 text-sm">
                <SelectValue placeholder="Select resource..." />
              </SelectTrigger>
              <SelectContent>
                {resources?.filter(r => r.status === 'available').map(r => (
                  <SelectItem key={r.id} value={r.id.toString()}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {action.needsPay && (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">$</span>
              <Input 
                type="number" 
                className="w-[100px] h-9" 
                placeholder="0.00" 
                value={payAmount} 
                onChange={e => setPayAmount(e.target.value)} 
              />
            </div>
          )}
          <Button 
            size="sm" 
            className="ml-auto" 
            disabled={(action.needsRes && !assignRes) || (action.needsPay && !payAmount)}
            onClick={() => {
              const data: any = {};
              if (action.needsRes) data.resourceId = parseInt(assignRes);
              if (action.needsPay) data.paymentAmount = parseFloat(payAmount);
              onAdvance(visit.id, action.next, data);
            }}
          >
            {action.label} <action.icon className="ml-2 h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

function CheckInDialog() {
  const [open, setOpen] = useState(false);
  const [customer, setCustomer] = useState<SosCustomer | null>(null);
  const [serviceType, setServiceType] = useState("");
  const [partySize, setPartySize] = useState("1");
  const checkIn = useCheckInSosVisit();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    if (!customer) return;
    checkIn.mutate(
      { data: { customerId: customer.id, serviceType, partySize: parseInt(partySize) } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosVisitsQueryKey({ active: true }) });
          setOpen(false);
          setCustomer(null);
          toast({ title: 'Checked in' });
        },
        onError: (err: any) => {
          toast({
            title: 'Check-in failed',
            description: err?.response?.data?.message || err?.message || 'Could not check the customer in. Please try again.',
            variant: 'destructive',
          });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="btn-check-in"><Plus className="mr-2 h-4 w-4" /> Check In Walk-in</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Check In Customer</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Customer</Label>
            <CustomerPicker value={customer} onChange={setCustomer} />
          </div>
          <div className="space-y-2">
            <Label>Service Type</Label>
            <ServiceTypeInput value={serviceType} onChange={setServiceType} />
          </div>
          <div className="space-y-2">
            <Label>Party Size</Label>
            <Input type="number" value={partySize} onChange={e => setPartySize(e.target.value)} min="1" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!serviceType || !customer || checkIn.isPending}>Check In</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddResourceDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const create = useCreateSosResource();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8"><Plus className="mr-2 h-3.5 w-3.5"/> Add</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Resource</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Resource Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Station 1, Room A" />
          </div>
          <div className="space-y-2">
            <Label>Resource Type</Label>
            <Input value={type} onChange={e => setType(e.target.value)} placeholder="e.g. Station, Room, Bay" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button 
            onClick={() => {
              create.mutate({ data: { name, resourceType: type } }, {
                onSuccess: () => {
                  queryClient.invalidateQueries({ queryKey: getListSosResourcesQueryKey() });
                  setOpen(false);
                },
                onError: (err: any) => {
                  toast({
                    title: 'Could not add resource',
                    description: err?.response?.data?.message || err?.message || 'Adding the resource failed. Please try again.',
                    variant: 'destructive',
                  });
                },
              });
            }} 
            disabled={!name || !type || create.isPending}
          >
            Add Resource
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
