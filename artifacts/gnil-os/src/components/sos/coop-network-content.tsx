import { useMemo, useState } from 'react';
import {
  useListCoopDirectory, getListCoopDirectoryQueryKey,
  useListCoopPartnerships, getListCoopPartnershipsQueryKey,
  useCreateCoopInvite, useRespondToCoopInvite,
  useListCoopActivePerks, getListCoopActivePerksQueryKey,
  type CoopDirectoryEntry, type CoopPartnership,
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
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  AlertTriangle, ArrowLeftRight, Bell, Check, Handshake, MapPin, Search,
  Send, Store, Ticket, X,
} from 'lucide-react';

const SAME_INDUSTRY_MESSAGE = 'Same-industry pairings are restricted by platform guidelines.';

/**
 * Local Co-Op Network — merchant-facing hub (Business Bookings tab).
 *
 * Business owners browse a directory of other businesses on the platform,
 * send partnership invites with a custom perk + mutual reward terms, and
 * accept/decline incoming invites. Accepted partnerships go live on both
 * businesses' checkout, receipt, and customer pass surfaces automatically.
 *
 * All requests are scoped by the selected business (?tenant= → x-tenant-id).
 */
export function CoopNetworkContent({ tenantId }: { tenantId: number | null }) {
  if (tenantId == null) {
    return (
      <Card className="border-dashed shadow-none">
        <CardContent className="p-10 text-center text-muted-foreground" data-testid="text-coop-pick-business">
          Select a specific business above to browse the Local Co-Op Network.
        </CardContent>
      </Card>
    );
  }
  return <CoopNetworkInner key={tenantId} tenantId={tenantId} />;
}

function CoopNetworkInner({ tenantId }: { tenantId: number }) {
  const { data: partnerships, isLoading } = useListCoopPartnerships(
    { tenantId },
    { query: { queryKey: getListCoopPartnershipsQueryKey({ tenantId }) } },
  );
  const { data: perks } = useListCoopActivePerks({
    query: { queryKey: getListCoopActivePerksQueryKey() },
  });

  const received = (partnerships ?? []).filter(
    p => p.status === 'pending' && p.requestedByTenantId != null && p.requestedByTenantId !== tenantId,
  );
  const sent = (partnerships ?? []).filter(
    p => p.status === 'pending' && p.requestedByTenantId === tenantId,
  );
  const active = (partnerships ?? []).filter(p => p.status === 'accepted' && p.isActive);
  const partneredTenantIds = useMemo(
    () =>
      new Set(
        (partnerships ?? [])
          .filter(p => p.status !== 'declined')
          .map(p => (p.hostTenantId === tenantId ? p.partnerTenantId : p.hostTenantId)),
      ),
    [partnerships, tenantId],
  );

  return (
    <div className="space-y-6" data-testid="coop-network-hub">
      <div>
        <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Handshake className="w-5 h-5 text-primary" /> Local Co-Op Network
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Partner with non-competing local businesses. Accepted perks go live automatically on both
          businesses' checkout, receipts, and customer passes.
        </p>
      </div>

      {received.length > 0 && (
        <div
          className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm flex items-center gap-2"
          role="alert"
          data-testid="alert-coop-incoming-invites"
        >
          <Bell className="w-4 h-4 text-primary shrink-0" />
          <span>
            You have {received.length} pending partnership invite{received.length === 1 ? '' : 's'} —
            review {received.length === 1 ? 'it' : 'them'} below.
          </span>
        </div>
      )}

      {isLoading ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : (
        <div className="grid lg:grid-cols-2 gap-6 items-start">
          <div className="space-y-6">
            <ReceivedInvites invites={received} />
            <SentInvites invites={sent} />
            <ActivePartnerships partnerships={active} perks={perks ?? []} tenantId={tenantId} />
          </div>
          <Directory tenantId={tenantId} partneredTenantIds={partneredTenantIds} />
        </div>
      )}
    </div>
  );
}

// ── Received invites ─────────────────────────────────────────────────────────

function ReceivedInvites({ invites }: { invites: CoopPartnership[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const respond = useRespondToCoopInvite();

  const act = (invite: CoopPartnership, action: 'accept' | 'decline') => {
    respond.mutate(
      { id: invite.id, data: { action } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            predicate: q => typeof q.queryKey[0] === 'string' && q.queryKey[0].includes('/api/coop/'),
          });
          toast({
            title: action === 'accept' ? 'Partnership accepted' : 'Invite declined',
            description:
              action === 'accept'
                ? 'The perk is now live on both businesses\u2019 checkout, receipts, and customer passes.'
                : 'The perk will not appear anywhere.',
          });
        },
        onError: (err: unknown) => {
          const e = err as { data?: { message?: string }; message?: string };
          toast({
            title: 'Could not respond',
            description: e?.data?.message ?? e?.message ?? 'Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <Card data-testid="card-coop-received-invites">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Bell className="w-4 h-4 text-primary" /> Invites Received
          {invites.length > 0 && <Badge data-testid="badge-received-count">{invites.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {invites.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-received-invites">
            No incoming invites right now.
          </p>
        ) : (
          invites.map(p => (
            <div key={p.id} className="border rounded-lg p-3 space-y-2" data-testid={`row-received-invite-${p.id}`}>
              <div className="text-sm font-semibold">{p.hostTenantName} wants to partner with you</div>
              <div className="text-sm">{p.perkTitle}</div>
              {p.perkDescription && <div className="text-xs text-muted-foreground">{p.perkDescription}</div>}
              {p.mutualRewardTerms && (
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium">Mutual terms:</span> {p.mutualRewardTerms}
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={respond.isPending}
                  onClick={() => act(p, 'accept')}
                  data-testid={`button-accept-invite-${p.id}`}
                >
                  <Check className="w-3.5 h-3.5" /> Accept Partnership
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={respond.isPending}
                  onClick={() => act(p, 'decline')}
                  data-testid={`button-decline-invite-${p.id}`}
                >
                  <X className="w-3.5 h-3.5" /> Decline
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ── Sent invites ─────────────────────────────────────────────────────────────

function SentInvites({ invites }: { invites: CoopPartnership[] }) {
  return (
    <Card data-testid="card-coop-sent-invites">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Send className="w-4 h-4 text-muted-foreground" /> Invites Sent
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {invites.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-sent-invites">
            No pending invites you've sent.
          </p>
        ) : (
          invites.map(p => (
            <div key={p.id} className="border rounded-lg p-3 flex items-center justify-between gap-3" data-testid={`row-sent-invite-${p.id}`}>
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">To {p.partnerTenantName}</div>
                <div className="text-xs text-muted-foreground truncate">{p.perkTitle}</div>
              </div>
              <Badge variant="secondary" className="shrink-0">Pending</Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ── Active partnerships ──────────────────────────────────────────────────────

function ActivePartnerships({
  partnerships, perks, tenantId,
}: {
  partnerships: CoopPartnership[];
  perks: { id: number; redemptionCode: string }[];
  tenantId: number;
}) {
  return (
    <Card data-testid="card-coop-active-partnerships">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Handshake className="w-4 h-4 text-emerald-600" /> Active Partnerships
        </CardTitle>
        <CardDescription>
          These perks are live on checkout, receipts, and customer passes for both businesses.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {partnerships.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-active-partnerships">
            No active partnerships yet — send an invite from the directory.
          </p>
        ) : (
          partnerships.map(p => {
            const otherName = p.hostTenantId === tenantId ? p.partnerTenantName : p.hostTenantName;
            return (
              <div key={p.id} className="border rounded-lg p-3 space-y-1" data-testid={`row-active-partnership-${p.id}`}>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ArrowLeftRight className="w-3.5 h-3.5 text-muted-foreground" /> {otherName}
                  <Badge className="ml-auto" data-testid={`badge-partnership-live-${p.id}`}>Live</Badge>
                </div>
                <div className="text-sm">{p.perkTitle}</div>
                {p.mutualRewardTerms && (
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium">Mutual terms:</span> {p.mutualRewardTerms}
                  </div>
                )}
                <div className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                  <Ticket className="w-3 h-3" /> {p.redemptionCode}
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

// ── Directory + perk builder ─────────────────────────────────────────────────

function Directory({
  tenantId, partneredTenantIds,
}: {
  tenantId: number;
  partneredTenantIds: Set<number>;
}) {
  const [search, setSearch] = useState('');
  const [city, setCity] = useState<string>('all');
  const [category, setCategory] = useState<string>('all');
  const [inviteTarget, setInviteTarget] = useState<CoopDirectoryEntry | null>(null);
  const { toast } = useToast();

  // Fetch unfiltered and filter client-side so the city/category dropdowns
  // always show every available option.
  const { data: directory, isLoading } = useListCoopDirectory(undefined, {
    query: { queryKey: getListCoopDirectoryQueryKey(undefined) },
  });

  const cities = useMemo(
    () => [...new Set((directory ?? []).map(d => d.city).filter((c): c is string => !!c))].sort(),
    [directory],
  );
  const categories = useMemo(
    () => [...new Set((directory ?? []).map(d => d.category).filter((c): c is string => !!c))].sort(),
    [directory],
  );

  const filtered = (directory ?? [])
    .filter(d => !search.trim() || d.name.toLowerCase().includes(search.trim().toLowerCase()))
    .filter(d => city === 'all' || d.city === city)
    .filter(d => category === 'all' || d.category === category);

  const startInvite = (biz: CoopDirectoryEntry) => {
    if (biz.sameIndustry) {
      toast({ title: 'Pairing restricted', description: SAME_INDUSTRY_MESSAGE, variant: 'destructive' });
      return;
    }
    setInviteTarget(biz);
  };

  return (
    <Card data-testid="card-coop-directory">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Store className="w-4 h-4 text-primary" /> Business Directory
        </CardTitle>
        <CardDescription>Discover non-competing local businesses to partner with.</CardDescription>
        <div className="flex flex-col sm:flex-row gap-2 pt-2">
          <div className="relative flex-1">
            <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search businesses…"
              className="pl-8 h-9"
              data-testid="input-directory-search"
            />
          </div>
          <Select value={city} onValueChange={setCity}>
            <SelectTrigger className="h-9 sm:w-36" data-testid="select-directory-city">
              <SelectValue placeholder="Location" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All locations</SelectItem>
              {cities.map(c => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="h-9 sm:w-36" data-testid="select-directory-category">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map(c => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <div className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6" data-testid="text-directory-empty">
            No businesses match your filters.
          </p>
        ) : (
          filtered.map(biz => (
            <div
              key={biz.id}
              className="border rounded-lg p-3 flex items-center justify-between gap-3"
              data-testid={`row-directory-business-${biz.id}`}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{biz.name}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
                  {biz.category && <span className="capitalize">{biz.category}</span>}
                  {biz.city && (
                    <span className="flex items-center gap-0.5">
                      <MapPin className="w-3 h-3" /> {biz.city}
                    </span>
                  )}
                </div>
                {biz.sameIndustry && (
                  <Badge
                    variant="outline"
                    className="mt-1 text-amber-600 border-amber-300"
                    data-testid={`badge-same-industry-${biz.id}`}
                  >
                    <AlertTriangle className="w-3 h-3 mr-1" /> Same industry — restricted
                  </Badge>
                )}
              </div>
              {partneredTenantIds.has(biz.id) ? (
                <Badge variant="secondary" className="shrink-0" data-testid={`badge-already-partnered-${biz.id}`}>
                  Invited / Partnered
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant={biz.sameIndustry ? 'outline' : 'default'}
                  className="shrink-0"
                  onClick={() => startInvite(biz)}
                  data-testid={`button-partner-up-${biz.id}`}
                >
                  Partner Up
                </Button>
              )}
            </div>
          ))
        )}
      </CardContent>

      <PerkBuilderDialog
        tenantId={tenantId}
        target={inviteTarget}
        onClose={() => setInviteTarget(null)}
      />
    </Card>
  );
}

function PerkBuilderDialog({
  tenantId, target, onClose,
}: {
  tenantId: number;
  target: CoopDirectoryEntry | null;
  onClose: () => void;
}) {
  const [perkTitle, setPerkTitle] = useState('');
  const [perkDescription, setPerkDescription] = useState('');
  const [mutualRewardTerms, setMutualRewardTerms] = useState('');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createInvite = useCreateCoopInvite();

  const close = () => {
    setPerkTitle('');
    setPerkDescription('');
    setMutualRewardTerms('');
    onClose();
  };

  const send = () => {
    if (!target) return;
    createInvite.mutate(
      {
        data: {
          partnerTenantId: target.id,
          perkTitle: perkTitle.trim(),
          ...(perkDescription.trim() ? { perkDescription: perkDescription.trim() } : {}),
          ...(mutualRewardTerms.trim() ? { mutualRewardTerms: mutualRewardTerms.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            predicate: q => typeof q.queryKey[0] === 'string' && q.queryKey[0].includes('/api/coop/'),
          });
          toast({
            title: 'Invite sent',
            description: `${target.name} will see your proposal and can accept it from their hub.`,
          });
          close();
        },
        onError: (err: unknown) => {
          const e = err as { status?: number; data?: { code?: string; message?: string }; message?: string };
          const restricted = e?.status === 403 || e?.data?.code === 'SAME_INDUSTRY_RESTRICTED';
          toast({
            title: restricted ? 'Pairing restricted' : 'Could not send invite',
            description: restricted
              ? SAME_INDUSTRY_MESSAGE
              : e?.data?.message ?? e?.message ?? 'Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <Dialog open={target != null} onOpenChange={o => { if (!o) close(); }}>
      <DialogContent data-testid="dialog-perk-builder">
        <DialogHeader>
          <DialogTitle>Partner with {target?.name}</DialogTitle>
          <DialogDescription>
            Describe the perk your businesses will offer each other's customers. It goes live on
            both checkouts, receipts, and customer passes the moment they accept.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="coop-invite-perk">Perk description</Label>
            <Input
              id="coop-invite-perk"
              placeholder='e.g. "10% off your meal or service"'
              value={perkTitle}
              onChange={e => setPerkTitle(e.target.value)}
              data-testid="input-invite-perk-title"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="coop-invite-details">Details for staff (optional)</Label>
            <Textarea
              id="coop-invite-details"
              placeholder="Anything staff should know when honoring the perk"
              value={perkDescription}
              onChange={e => setPerkDescription(e.target.value)}
              data-testid="input-invite-perk-description"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="coop-invite-terms">Mutual reward terms</Label>
            <Textarea
              id="coop-invite-terms"
              placeholder='e.g. "Each business honors the perk for customers referred by the other"'
              value={mutualRewardTerms}
              onChange={e => setMutualRewardTerms(e.target.value)}
              data-testid="input-invite-mutual-terms"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={send}
            disabled={perkTitle.trim() === '' || createInvite.isPending}
            className="gap-2"
            data-testid="button-send-partnership-invite"
          >
            <Send className="w-4 h-4" /> Send Partnership Invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
