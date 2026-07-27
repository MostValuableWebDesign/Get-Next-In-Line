import { useState } from 'react';
import {
  useListCoopPartnerships,
  getListCoopPartnershipsQueryKey,
  useCreateCoopPartnership,
  useUpdateCoopPartnership,
  useListTenants,
  getListTenantsQueryKey,
  type CoopPartnership,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { AlertTriangle, ArrowLeftRight, Handshake, Plus, Power, Ticket } from 'lucide-react';

/**
 * Command Center — merchant co-op partnerships.
 *
 * Cross-promotion pacts between two businesses: a host tenant offers a perk
 * (with a redemption code) to customers referred from a partner tenant. The
 * industry barrier blocks same-category pairings unless the admin confirms
 * an explicit override after the server rejects the first attempt.
 */
export default function CoopPartnerships() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: partnerships, isLoading } = useListCoopPartnerships(undefined, {
    query: { queryKey: getListCoopPartnershipsQueryKey(undefined) },
  });
  const updatePartnership = useUpdateCoopPartnership();

  const toggleActive = (p: CoopPartnership) => {
    updatePartnership.mutate(
      { id: p.id, data: { isActive: !p.isActive } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCoopPartnershipsQueryKey(undefined) });
          toast({
            title: p.isActive ? 'Partnership deactivated' : 'Partnership reactivated',
            description: `${p.hostTenantName} × ${p.partnerTenantName}`,
          });
        },
        onError: () => toast({ title: 'Update failed', variant: 'destructive' }),
      },
    );
  };

  return (
    <div className="space-y-6" data-testid="page-coop-partnerships">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Handshake className="w-6 h-6 text-primary" /> Merchant Co-op Partnerships
          </h1>
          <p className="text-muted-foreground mt-1">
            Cross-promotion pacts between businesses — a host offers a perk to customers referred
            from its partner. Same-industry pairings are blocked unless explicitly overridden.
          </p>
        </div>
        <CreatePartnershipDialog />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : !partnerships || partnerships.length === 0 ? (
        <Card className="border-dashed shadow-none">
          <CardContent className="p-10 text-center text-muted-foreground" data-testid="text-no-partnerships">
            No partnerships yet. Create one to start cross-promoting two businesses.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3" data-testid="list-coop-partnerships">
          {partnerships.map((p) => (
            <Card key={p.id} className={`border-none shadow-md ${p.isActive ? '' : 'opacity-60'}`} data-testid={`card-partnership-${p.id}`}>
              <CardContent className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold" data-testid={`text-partnership-pair-${p.id}`}>
                      {p.hostTenantName}
                    </span>
                    <ArrowLeftRight className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="font-semibold">{p.partnerTenantName}</span>
                    <Badge variant={p.isActive ? 'default' : 'secondary'} data-testid={`badge-partnership-status-${p.id}`}>
                      {p.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                    {p.industryBarrierOverridden && (
                      <Badge variant="outline" className="text-amber-600 border-amber-300">
                        <AlertTriangle className="w-3 h-3 mr-1" /> Barrier overridden
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm font-medium">{p.perkTitle}</div>
                  {p.perkDescription && (
                    <div className="text-sm text-muted-foreground">{p.perkDescription}</div>
                  )}
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
                    <Ticket className="w-3.5 h-3.5" />
                    <span data-testid={`text-redemption-code-${p.id}`}>{p.redemptionCode}</span>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 shrink-0 self-start md:self-center"
                  onClick={() => toggleActive(p)}
                  disabled={updatePartnership.isPending}
                  data-testid={`button-toggle-partnership-${p.id}`}
                >
                  <Power className="w-4 h-4" />
                  {p.isActive ? 'Deactivate' : 'Reactivate'}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function CreatePartnershipDialog() {
  const [open, setOpen] = useState(false);
  const [hostTenantId, setHostTenantId] = useState<string>('');
  const [partnerTenantId, setPartnerTenantId] = useState<string>('');
  const [perkTitle, setPerkTitle] = useState('');
  const [perkDescription, setPerkDescription] = useState('');
  const [redemptionCode, setRedemptionCode] = useState('');
  // Set when the server rejects with the industry barrier; the admin must
  // confirm the override explicitly before we retry.
  const [barrierMessage, setBarrierMessage] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: tenants } = useListTenants({
    query: { queryKey: getListTenantsQueryKey(), enabled: open },
  });
  const createPartnership = useCreateCoopPartnership();

  const reset = () => {
    setHostTenantId('');
    setPartnerTenantId('');
    setPerkTitle('');
    setPerkDescription('');
    setRedemptionCode('');
    setBarrierMessage(null);
  };

  const submit = (override: boolean) => {
    createPartnership.mutate(
      {
        data: {
          hostTenantId: Number(hostTenantId),
          partnerTenantId: Number(partnerTenantId),
          perkTitle: perkTitle.trim(),
          ...(perkDescription.trim() ? { perkDescription: perkDescription.trim() } : {}),
          ...(redemptionCode.trim() ? { redemptionCode: redemptionCode.trim() } : {}),
          ...(override ? { overrideIndustryBarrier: true } : {}),
        },
      },
      {
        onSuccess: (created) => {
          queryClient.invalidateQueries({ queryKey: getListCoopPartnershipsQueryKey(undefined) });
          toast({
            title: 'Partnership created',
            description: `Redemption code: ${created.redemptionCode}`,
          });
          setOpen(false);
          reset();
        },
        onError: (err: unknown) => {
          const e = err as { status?: number; message?: string; data?: { message?: string } };
          const message = e?.data?.message ?? e?.message ?? 'Could not create the partnership.';
          if (e?.status === 409) {
            setBarrierMessage(message);
          } else {
            toast({ title: 'Create failed', description: message, variant: 'destructive' });
          }
        },
      },
    );
  };

  const canSubmit =
    hostTenantId !== '' && partnerTenantId !== '' && hostTenantId !== partnerTenantId && perkTitle.trim() !== '';

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button className="gap-2" data-testid="button-new-partnership">
          <Plus className="w-4 h-4" /> New Partnership
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Co-op Partnership</DialogTitle>
          <DialogDescription>
            The host business offers the perk to customers referred from the partner business.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Host business</Label>
              <Select value={hostTenantId} onValueChange={(v) => { setHostTenantId(v); setBarrierMessage(null); }}>
                <SelectTrigger data-testid="select-host-tenant">
                  <SelectValue placeholder="Select business" />
                </SelectTrigger>
                <SelectContent>
                  {(tenants ?? []).map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.brandName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Partner business</Label>
              <Select value={partnerTenantId} onValueChange={(v) => { setPartnerTenantId(v); setBarrierMessage(null); }}>
                <SelectTrigger data-testid="select-partner-tenant">
                  <SelectValue placeholder="Select business" />
                </SelectTrigger>
                <SelectContent>
                  {(tenants ?? []).map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.brandName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="coop-perk-title">Perk title</Label>
            <Input
              id="coop-perk-title"
              placeholder="e.g. 15% off your first visit"
              value={perkTitle}
              onChange={(e) => setPerkTitle(e.target.value)}
              data-testid="input-perk-title"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="coop-perk-description">Perk description (optional)</Label>
            <Textarea
              id="coop-perk-description"
              placeholder="Details staff should know when honoring the perk"
              value={perkDescription}
              onChange={(e) => setPerkDescription(e.target.value)}
              data-testid="input-perk-description"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="coop-redemption-code">Redemption code (optional)</Label>
            <Input
              id="coop-redemption-code"
              placeholder="Auto-generated when left blank"
              value={redemptionCode}
              onChange={(e) => setRedemptionCode(e.target.value)}
              className="font-mono"
              data-testid="input-redemption-code"
            />
          </div>
          {barrierMessage && (
            <div
              className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm space-y-2"
              data-testid="alert-industry-barrier"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <span>{barrierMessage}</span>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          {barrierMessage ? (
            <Button
              variant="destructive"
              onClick={() => submit(true)}
              disabled={!canSubmit || createPartnership.isPending}
              data-testid="button-override-barrier"
            >
              Override barrier and create anyway
            </Button>
          ) : (
            <Button
              onClick={() => submit(false)}
              disabled={!canSubmit || createPartnership.isPending}
              data-testid="button-create-partnership"
            >
              Create Partnership
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Read-only list of the partnerships a single tenant participates in (as
 * host or partner) — surfaced on the tenant's Configuration view.
 */
export function TenantCoopPartnershipsSection({ tenantId }: { tenantId: number }) {
  const { data: partnerships, isLoading } = useListCoopPartnerships(
    { tenantId },
    { query: { queryKey: getListCoopPartnershipsQueryKey({ tenantId }) } },
  );

  return (
    <Card data-testid="card-tenant-coop-partnerships">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Handshake className="w-5 h-5 text-primary" /> Co-op Partnerships
        </CardTitle>
        <CardDescription>
          Cross-promotion pacts this business participates in, as host or partner. Managed from the
          Command Center.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : !partnerships || partnerships.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-tenant-partnerships">
            This business isn't part of any co-op partnerships yet.
          </p>
        ) : (
          <div className="divide-y" data-testid="list-tenant-partnerships">
            {partnerships.map((p) => {
              const isHost = p.hostTenantId === tenantId;
              const otherName = isHost ? p.partnerTenantName : p.hostTenantName;
              return (
                <div key={p.id} className="py-3 flex items-center justify-between gap-4" data-testid={`row-tenant-partnership-${p.id}`}>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">
                      {isHost ? 'Hosting for' : 'Referred by perk from'} {otherName}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{p.perkTitle}</div>
                    <div className="text-xs text-muted-foreground font-mono flex items-center gap-1 mt-0.5">
                      <Ticket className="w-3 h-3" /> {p.redemptionCode}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className="text-[9px] uppercase">
                      {isHost ? 'Host' : 'Partner'}
                    </Badge>
                    <Badge variant={p.isActive ? 'default' : 'secondary'}>
                      {p.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
