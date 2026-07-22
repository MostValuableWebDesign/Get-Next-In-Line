import React, { useState } from 'react';
import { 
  useListSosVisits, useListSosResources, useListSosWaitlist,
  useAdvanceSosVisit, useCheckInSosVisit, useClaimSosWaitlistSlot,
  useUpdateSosResource, useCreateSosResource, useDeleteSosResource,
  getListSosVisitsQueryKey, getListSosResourcesQueryKey, getListSosWaitlistQueryKey,
  SosVisitStatus
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Play, ArrowRight, CheckSquare, Bell, CreditCard, Check, LogOut, Clock, Plus, Settings2, Trash2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function OperationsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
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

  const advanceVisit = useAdvanceSosVisit();
  const updateResource = useUpdateSosResource();
  const claimSlot = useClaimSosWaitlistSlot();

  const handleAdvance = (id: number, action: any, extraData: any = {}) => {
    advanceVisit.mutate(
      { id, data: { action, ...extraData } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosVisitsQueryKey({ active: true }) });
          queryClient.invalidateQueries({ queryKey: getListSosResourcesQueryKey() });
          toast({ title: 'Visit advanced', description: `Action ${action} successful.` });
        }
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
        }
      }
    );
  };

  return (
    <div className="p-6 h-full flex flex-col space-y-6 max-w-[1600px] mx-auto">
      <div className="flex justify-between items-center shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Operations Center</h1>
          <p className="text-muted-foreground text-sm mt-1">Live command center for active visits and resources.</p>
        </div>
        <CheckInDialog />
      </div>

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
                      onValueChange={(val) => {
                        updateResource.mutate({ id: res.id, data: { status: val as any } }, {
                          onSuccess: () => queryClient.invalidateQueries({ queryKey: getListSosResourcesQueryKey() })
                        });
                      }}
                    >
                      <SelectTrigger className="h-7 text-xs w-[110px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="available">Available</SelectItem>
                        <SelectItem value="occupied">Occupied</SelectItem>
                        <SelectItem value="cleaning">Cleaning</SelectItem>
                        <SelectItem value="offline">Offline</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Zone 3: Smart Waitlist */}
          <div className="flex-1 flex flex-col min-h-0 bg-card border rounded-lg shadow-sm">
            <div className="p-4 border-b bg-muted/30 shrink-0">
              <h2 className="font-semibold flex items-center gap-2">
                <Clock className="h-4 w-4 text-primary" /> Smart Waitlist
              </h2>
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
  const [customerId, setCustomerId] = useState("1"); // Hardcoded for demo, normally would search customers
  const [serviceType, setServiceType] = useState("");
  const [partySize, setPartySize] = useState("1");
  const checkIn = useCheckInSosVisit();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    checkIn.mutate(
      { data: { customerId: parseInt(customerId), serviceType, partySize: parseInt(partySize) } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosVisitsQueryKey({ active: true }) });
          setOpen(false);
          toast({ title: 'Checked in' });
        }
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
            <Label>Customer ID</Label>
            <Input value={customerId} onChange={e => setCustomerId(e.target.value)} placeholder="e.g. 1" />
          </div>
          <div className="space-y-2">
            <Label>Service Type</Label>
            <Input value={serviceType} onChange={e => setServiceType(e.target.value)} placeholder="e.g. Haircut, Consultation" />
          </div>
          <div className="space-y-2">
            <Label>Party Size</Label>
            <Input type="number" value={partySize} onChange={e => setPartySize(e.target.value)} min="1" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!serviceType}>Check In</Button>
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
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Chair 1, Room A" />
          </div>
          <div className="space-y-2">
            <Label>Resource Type</Label>
            <Input value={type} onChange={e => setType(e.target.value)} placeholder="e.g. Chair, Room, Bay" />
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
                }
              });
            }} 
            disabled={!name || !type}
          >
            Add Resource
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
