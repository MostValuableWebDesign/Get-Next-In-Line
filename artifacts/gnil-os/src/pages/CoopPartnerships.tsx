import { useEffect, useState } from 'react';
import {
  useListCoopPartnerships,
  getListCoopPartnershipsQueryKey,
  useCreateCoopPartnership,
  updateCoopPartnership,
  useListTenants,
  getListTenantsQueryKey,
  useListAdminCoopDisputes,
  getListAdminCoopDisputesQueryKey,
  useReinstateCoopDispute,
  useBanCoopDisputePartnership,
  useAddCoopDisputeMediationNote,
  type CoopPartnership,
  type CoopDispute,
} from '@workspace/api-client-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import {
  AlertTriangle, ArrowLeftRight, Ban, Gavel, Handshake, NotebookPen, Plus, Power,
  RotateCcw, Ticket,
} from 'lucide-react';

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
  // Partnerships are tenant-scoped on the server (participant-only): the
  // operator picks a business, and the list shows the pacts that business
  // participates in as host or partner.
  const { data: tenants } = useListTenants({
    query: { queryKey: getListTenantsQueryKey() },
  });
  const [selectedTenantId, setSelectedTenantId] = useState<string>('');
  useEffect(() => {
    if (selectedTenantId === '' && tenants && tenants.length > 0) {
      setSelectedTenantId(String(tenants[0].id));
    }
  }, [tenants, selectedTenantId]);
  const tenantId = selectedTenantId ? Number(selectedTenantId) : null;

  const listParams = tenantId != null ? { tenantId } : undefined;
  const { data: partnerships, isLoading } = useListCoopPartnerships(listParams, {
    query: {
      queryKey: getListCoopPartnershipsQueryKey(listParams),
      enabled: tenantId != null,
    },
  });

  // Mutations must carry participant tenant context; scope each toggle to the
  // partnership's host tenant explicitly.
  const updatePartnership = useMutation({
    mutationFn: ({ p, isActive }: { p: CoopPartnership; isActive: boolean }) =>
      updateCoopPartnership(p.id, { isActive }, {
        headers: { 'x-tenant-id': String(p.hostTenantId) },
      }),
  });

  const toggleActive = (p: CoopPartnership) => {
    updatePartnership.mutate(
      { p, isActive: !p.isActive },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCoopPartnershipsQueryKey(listParams) });
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
        <div className="flex items-center gap-2">
          <Select value={selectedTenantId} onValueChange={setSelectedTenantId}>
            <SelectTrigger className="w-[220px]" data-testid="select-partnerships-tenant">
              <SelectValue placeholder="Select a business" />
            </SelectTrigger>
            <SelectContent>
              {(tenants ?? []).map((t) => (
                <SelectItem key={t.id} value={String(t.id)}>
                  {t.brandName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <CreatePartnershipDialog />
        </div>
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
                    {p.perkEndsAt != null && new Date(p.perkEndsAt).getTime() <= Date.now() ? (
                      <Badge variant="outline" data-testid={`badge-partnership-status-${p.id}`}>
                        Expired
                      </Badge>
                    ) : (
                      <Badge variant={p.isActive ? 'default' : 'secondary'} data-testid={`badge-partnership-status-${p.id}`}>
                        {p.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    )}
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
                  {(p.perkStartsAt || p.perkEndsAt) && (
                    <div className="text-xs text-muted-foreground" data-testid={`text-perk-window-${p.id}`}>
                      {p.perkStartsAt ? new Date(p.perkStartsAt).toLocaleDateString() : 'Now'} –{' '}
                      {p.perkEndsAt ? new Date(p.perkEndsAt).toLocaleDateString() : 'no end date'}
                    </div>
                  )}
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

      <DisputeQueue />
    </div>
  );
}

// ── Admin dispute escalation queue ───────────────────────────────────────────

const DISPUTE_STATUS_FILTERS = ['all', 'open', 'escalated', 'resolved', 'withdrawn', 'banned'] as const;

function disputeAge(createdAt: string): string {
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function statusBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'escalated': return 'destructive';
    case 'open': return 'default';
    case 'banned': return 'outline';
    default: return 'secondary';
  }
}

/**
 * Platform mediation console: open/escalated disputes with parties, category,
 * and age, plus reinstate / permanently ban / mediation-note actions.
 */
function DisputeQueue() {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const params = statusFilter === 'all' ? undefined : { status: statusFilter as CoopDispute['status'] };
  const { data: disputes, isLoading } = useListAdminCoopDisputes(params, {
    query: { queryKey: getListAdminCoopDisputesQueryKey(params) },
  });

  return (
    <Card className="border-none shadow-md" data-testid="card-dispute-queue">
      <CardHeader className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Gavel className="w-5 h-5 text-primary" /> Dispute Escalation Queue
          </CardTitle>
          <CardDescription>
            Merchant-reported partner issues. Escalated disputes have already paused the shared
            perk — reinstate, permanently ban, or record mediation notes.
          </CardDescription>
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40" data-testid="select-dispute-status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DISPUTE_STATUS_FILTERS.map(s => (
              <SelectItem key={s} value={s} className="capitalize">{s === 'all' ? 'All statuses' : s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : !disputes || disputes.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-disputes">
            No disputes {statusFilter === 'all' ? 'filed yet' : `with status "${statusFilter}"`}.
          </p>
        ) : (
          disputes.map(d => <DisputeRow key={d.id} dispute={d} />)
        )}
      </CardContent>
    </Card>
  );
}

function DisputeRow({ dispute: d }: { dispute: CoopDispute }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState<'reinstate' | 'ban' | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const reinstate = useReinstateCoopDispute();
  const ban = useBanCoopDisputePartnership();
  const addNote = useAddCoopDisputeMediationNote();

  const refresh = () => {
    queryClient.invalidateQueries({
      predicate: q => typeof q.queryKey[0] === 'string' &&
        (q.queryKey[0].includes('/api/admin/coop/') || q.queryKey[0].includes('/api/coop/')),
    });
  };
  const onError = (err: unknown) => {
    const e = err as { data?: { message?: string }; message?: string };
    toast({
      title: 'Action failed',
      description: e?.data?.message ?? e?.message ?? 'Please try again.',
      variant: 'destructive',
    });
  };

  const actionable = d.status === 'open' || d.status === 'escalated';
  const busy = reinstate.isPending || ban.isPending || addNote.isPending;

  return (
    <div className="border rounded-lg p-4 space-y-2" data-testid={`row-dispute-${d.id}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-sm" data-testid={`text-dispute-parties-${d.id}`}>
          {d.reportingTenantName}
        </span>
        <span className="text-xs text-muted-foreground">reported</span>
        <span className="font-semibold text-sm">{d.reportedTenantName}</span>
        <Badge variant={statusBadgeVariant(d.status)} className="capitalize" data-testid={`badge-dispute-status-${d.id}`}>
          {d.status}
        </Badge>
        <span className="text-xs text-muted-foreground ml-auto" data-testid={`text-dispute-age-${d.id}`}>
          Filed {disputeAge(d.createdAt)}
        </span>
      </div>
      <div className="text-sm" data-testid={`text-dispute-category-${d.id}`}>{d.category}</div>
      <div className="text-xs text-muted-foreground">
        Perk: {d.perkTitle} · Grace deadline {new Date(d.graceDeadlineAt).toLocaleDateString()}
        {d.escalatedAt && ` · Escalated ${new Date(d.escalatedAt).toLocaleDateString()}`}
        {d.resolvedAt && ` · Closed ${new Date(d.resolvedAt).toLocaleDateString()}`}
      </div>
      {d.details && <div className="text-xs text-muted-foreground italic">“{d.details}”</div>}
      {d.mediationNotes && (
        <pre className="text-xs text-muted-foreground whitespace-pre-wrap bg-muted/50 rounded p-2" data-testid={`text-mediation-notes-${d.id}`}>
          {d.mediationNotes}
        </pre>
      )}

      {actionable && (
        confirming ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm space-y-2" data-testid={`confirm-${confirming}-${d.id}`}>
            <p>
              {confirming === 'reinstate'
                ? 'Resolve this dispute and reinstate the partnership? The perk goes live again and the partnership returns to the directory.'
                : 'Permanently ban this partnership? The perk will never be served again. This can only be undone by reinstating through a future dispute record.'}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={confirming === 'ban' ? 'destructive' : 'default'}
                disabled={busy}
                onClick={() => {
                  const m = confirming === 'reinstate' ? reinstate : ban;
                  m.mutate({ id: d.id }, {
                    onSuccess: () => {
                      refresh();
                      toast({
                        title: confirming === 'reinstate' ? 'Partnership reinstated' : 'Partnership banned',
                        description: `${d.reportingTenantName} × ${d.reportedTenantName}`,
                      });
                      setConfirming(null);
                    },
                    onError,
                  });
                }}
                data-testid={`button-confirm-${confirming}-${d.id}`}
              >
                Yes, {confirming === 'reinstate' ? 'reinstate' : 'ban permanently'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(null)} data-testid={`button-cancel-${confirming}-${d.id}`}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => setConfirming('reinstate')} data-testid={`button-reinstate-${d.id}`}>
              <RotateCcw className="w-3.5 h-3.5" /> Resolve & Reinstate
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5 text-destructive hover:text-destructive" disabled={busy} onClick={() => setConfirming('ban')} data-testid={`button-ban-${d.id}`}>
              <Ban className="w-3.5 h-3.5" /> Ban Partnership
            </Button>
            <Button size="sm" variant="ghost" className="gap-1.5" disabled={busy} onClick={() => setNoteOpen(o => !o)} data-testid={`button-mediation-note-${d.id}`}>
              <NotebookPen className="w-3.5 h-3.5" /> Add Mediation Note
            </Button>
          </div>
        )
      )}
      {actionable && noteOpen && !confirming && (
        <div className="space-y-2 pt-1">
          <Textarea
            placeholder="Record a mediation step — the dispute stays open."
            value={note}
            onChange={e => setNote(e.target.value)}
            data-testid={`input-mediation-note-${d.id}`}
          />
          <Button
            size="sm"
            disabled={!note.trim() || busy}
            onClick={() => addNote.mutate({ id: d.id, data: { note: note.trim() } }, {
              onSuccess: () => { refresh(); setNote(''); setNoteOpen(false); toast({ title: 'Mediation note recorded' }); },
              onError,
            })}
            data-testid={`button-save-mediation-note-${d.id}`}
          >
            Save Note
          </Button>
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
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  // Set when the server rejects with the industry barrier; the admin must
  // confirm the override explicitly before we retry.
  const [barrierMessage, setBarrierMessage] = useState<string | null>(null);

  const windowInvalid = startsAt !== '' && endsAt !== '' && new Date(endsAt) <= new Date(startsAt);

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
    setStartsAt('');
    setEndsAt('');
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
          ...(startsAt ? { perkStartsAt: new Date(startsAt).toISOString() } : {}),
          ...(endsAt ? { perkEndsAt: new Date(endsAt).toISOString() } : {}),
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
    hostTenantId !== '' && partnerTenantId !== '' && hostTenantId !== partnerTenantId &&
    perkTitle.trim() !== '' && !windowInvalid;

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
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="coop-perk-starts">Start date (optional)</Label>
              <Input
                id="coop-perk-starts"
                type="date"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                data-testid="input-perk-starts"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="coop-perk-ends">End date (optional)</Label>
              <Input
                id="coop-perk-ends"
                type="date"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                data-testid="input-perk-ends"
              />
            </div>
          </div>
          {windowInvalid && (
            <p className="text-sm text-destructive" data-testid="text-perk-window-error">
              The end date must be after the start date.
            </p>
          )}
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
