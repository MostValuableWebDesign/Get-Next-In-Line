import { useEffect, useMemo, useState } from 'react';
import {
  useListCoopCampaigns, getListCoopCampaignsQueryKey,
  useListCoopCampaignTemplates, getListCoopCampaignTemplatesQueryKey,
  useCreateCoopCampaign, useRespondToCoopCampaign, useTriggerCoopCampaignBlast,
  getListCoopActivePerksQueryKey,
  useListCoopPartnerships, getListCoopPartnershipsQueryKey,
  type CoopCampaign, type CoopCampaignBlastResult, type CoopCampaignTemplate,
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
import { useToast } from '@/hooks/use-toast';
import { Checkbox } from '@/components/ui/checkbox';
import { CalendarClock, Check, Megaphone, Rocket, Send, Timer, X, Zap } from 'lucide-react';

/**
 * Co-Op Promotional Campaigns & Seasonal Blasts — merchant-facing Campaigns
 * area inside the Local Co-Op Network hub.
 *
 * A merchant with at least one accepted, active partnership launches a flash
 * campaign from a preset (or custom) template: one uniform start/end window
 * for every participant plus a boosted perk description. Invited partners
 * join or decline; the boost shows on each joined participant's storefront
 * perk surface only while the window is open. The creator fires (or the
 * worker auto-fires at start) one joint SMS blast with a rolling 7-day
 * network-wide frequency cap; the sent vs. capped summary renders inline.
 */
export function CoopCampaignsSection({ tenantId }: { tenantId: number }) {
  const { data: campaigns, isLoading } = useListCoopCampaigns({
    query: { queryKey: getListCoopCampaignsQueryKey() },
  });

  const now = Date.now();
  const past = (campaigns ?? []).filter(c => new Date(c.endsAt).getTime() <= now);
  const current = (campaigns ?? []).filter(c => new Date(c.endsAt).getTime() > now);
  const invites = current.filter(c => c.myStatus === 'invited');
  const mine = current.filter(c => c.myStatus !== 'invited');

  return (
    <Card data-testid="coop-campaigns-section">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Megaphone className="w-4 h-4 text-primary" /> Flash Campaigns & Seasonal Blasts
        </CardTitle>
        <CardDescription>
          Launch a synchronized limited-time offer with your co-op partners and announce it with
          one joint SMS blast — shared customers are never texted more than once per week.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CreateCampaignDialog tenantId={tenantId} />
        {isLoading ? (
          <Skeleton className="h-20 w-full rounded-lg" />
        ) : (
          <>
            {invites.length > 0 && (
              <div className="space-y-2" data-testid="list-campaign-invites">
                <h4 className="text-sm font-semibold">Campaign invitations</h4>
                {invites.map(c => <CampaignCard key={c.id} campaign={c} />)}
              </div>
            )}
            <div className="space-y-2" data-testid="list-campaigns-active">
              <h4 className="text-sm font-semibold">Active & upcoming</h4>
              {mine.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="text-no-campaigns">
                  No campaigns yet. Launch one to coordinate a neighborhood-wide deal.
                </p>
              ) : (
                mine.map(c => <CampaignCard key={c.id} campaign={c} />)
              )}
            </div>
            {past.length > 0 && (
              <div className="space-y-2" data-testid="list-campaigns-past">
                <h4 className="text-sm font-semibold text-muted-foreground">Past campaigns</h4>
                {past.map(c => <CampaignCard key={c.id} campaign={c} past />)}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** Live countdown text: "starts in 2d 3h" / "ends in 5h 12m" / "ended". */
function useCountdown(campaign: CoopCampaign): string {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const start = new Date(campaign.startsAt).getTime();
  const end = new Date(campaign.endsAt).getTime();
  const target = nowMs < start ? start : end;
  if (nowMs >= end) return 'ended';
  const diff = target - nowMs;
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const span = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return nowMs < start ? `starts in ${span}` : `ends in ${span}`;
}

function CampaignCard({ campaign, past = false }: { campaign: CoopCampaign; past?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const countdown = useCountdown(campaign);
  const [blastResult, setBlastResult] = useState<CoopCampaignBlastResult | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListCoopCampaignsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListCoopActivePerksQueryKey() });
  };

  const respond = useRespondToCoopCampaign({
    mutation: {
      onSuccess: invalidate,
      onError: (err: unknown) =>
        toast({
          variant: 'destructive',
          title: 'Could not respond',
          description: (err as { data?: { message?: string } })?.data?.message ?? 'Please try again.',
        }),
    },
  });
  const blast = useTriggerCoopCampaignBlast({
    mutation: {
      onSuccess: (res: CoopCampaignBlastResult) => {
        setBlastResult(res);
        invalidate();
      },
      onError: (err: unknown) =>
        toast({
          variant: 'destructive',
          title: 'Blast not sent',
          description: (err as { data?: { message?: string } })?.data?.message ?? 'Please try again.',
        }),
    },
  });

  const live = campaign.phase === 'live' || (!past && new Date(campaign.startsAt).getTime() <= Date.now());
  const joined = campaign.participants.filter(p => p.status === 'joined');
  const pending = campaign.participants.filter(p => p.status === 'invited');

  return (
    <div
      className={`rounded-lg border p-3 space-y-2 ${past ? 'opacity-70' : ''}`}
      data-testid={`card-campaign-${campaign.id}`}
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="font-medium text-sm flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 text-amber-500" /> {campaign.name}
            <Badge variant="outline" className="text-[10px]">{campaign.template.replace(/_/g, ' ')}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{campaign.perkBoostText}</p>
        </div>
        <div className="text-right text-xs text-muted-foreground shrink-0">
          <div className="flex items-center gap-1 justify-end">
            <CalendarClock className="w-3 h-3" /> {fmt(campaign.startsAt)} → {fmt(campaign.endsAt)}
          </div>
          {!past && (
            <div className="flex items-center gap-1 justify-end mt-0.5 font-medium text-foreground" data-testid={`text-campaign-countdown-${campaign.id}`}>
              <Timer className="w-3 h-3" /> {countdown}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 text-xs" data-testid={`list-campaign-participants-${campaign.id}`}>
        {campaign.participants.map(p => (
          <Badge
            key={p.tenantId}
            variant={p.status === 'joined' ? 'default' : 'outline'}
            className={p.status === 'declined' ? 'line-through opacity-60' : ''}
          >
            {p.tenantName}
            {p.status === 'joined' ? ' ✓' : p.status === 'declined' ? ' ✕' : ' — invited'}
          </Badge>
        ))}
      </div>

      {campaign.myStatus === 'invited' && !past && (
        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            disabled={respond.isPending}
            onClick={() => respond.mutate({ id: campaign.id, data: { action: 'join' } })}
            data-testid={`button-campaign-join-${campaign.id}`}
          >
            <Check className="w-3.5 h-3.5 mr-1" /> Join campaign
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={respond.isPending}
            onClick={() => respond.mutate({ id: campaign.id, data: { action: 'decline' } })}
            data-testid={`button-campaign-decline-${campaign.id}`}
          >
            <X className="w-3.5 h-3.5 mr-1" /> Decline
          </Button>
        </div>
      )}

      {campaign.isCreator && !past && (
        <div className="pt-1 space-y-1.5">
          {campaign.blastTriggeredAt == null ? (
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                variant="secondary"
                disabled={blast.isPending || !live || joined.length === 0}
                onClick={() => blast.mutate({ id: campaign.id })}
                data-testid={`button-campaign-blast-${campaign.id}`}
              >
                <Send className="w-3.5 h-3.5 mr-1" /> Send joint SMS blast now
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {live
                  ? 'Or wait — it fires automatically at campaign start.'
                  : 'Fires automatically when the campaign starts.'}
                {pending.length > 0 && ` ${pending.length} partner${pending.length === 1 ? '' : 's'} still deciding.`}
              </span>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground" data-testid={`text-campaign-blast-done-${campaign.id}`}>
              Joint blast sent {fmt(campaign.blastTriggeredAt)}.
            </p>
          )}
          {blastResult && (
            <p className="text-xs" data-testid={`text-campaign-blast-summary-${campaign.id}`}>
              <span className="font-medium text-emerald-600">{blastResult.sent} sent</span>
              {' · '}
              <span className="text-muted-foreground">
                {blastResult.capped} frequency-capped · {blastResult.skipped} skipped (opt-out/no phone)
                {' of '}{blastResult.totalCandidates} customers
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Create-campaign dialog: template picker + boost editor + partner picker ──

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CreateCampaignDialog({ tenantId }: { tenantId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState('custom');
  const [name, setName] = useState('');
  const [boost, setBoost] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const { data: templates } = useListCoopCampaignTemplates({
    query: { queryKey: getListCoopCampaignTemplatesQueryKey() },
  });
  const { data: partnerships } = useListCoopPartnerships(
    { tenantId },
    { query: { queryKey: getListCoopPartnershipsQueryKey({ tenantId }) } },
  );
  // Current accepted, active partners — the only businesses a campaign may invite.
  const partners = useMemo(() => {
    const seen = new Map<number, string>();
    for (const p of partnerships ?? []) {
      if (p.status !== 'accepted' || !p.isActive || p.bannedAt != null) continue;
      const otherId = p.hostTenantId === tenantId ? p.partnerTenantId : p.hostTenantId;
      const otherName = p.hostTenantId === tenantId ? p.partnerTenantName : p.hostTenantName;
      seen.set(otherId, otherName);
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [partnerships, tenantId]);

  const applyTemplate = (t: CoopCampaignTemplate) => {
    setTemplate(t.slug);
    if (t.slug !== 'custom') {
      setName(prev => prev || t.label);
      setBoost(prev => prev || t.suggestedPerkBoost);
    }
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    const end = new Date(start.getTime() + t.defaultDurationDays * 86_400_000);
    setStartsAt(toLocalInputValue(start));
    setEndsAt(toLocalInputValue(end));
  };

  const create = useCreateCoopCampaign({
    mutation: {
      onSuccess: () => {
        toast({ title: 'Campaign launched', description: 'Your partners have been invited.' });
        queryClient.invalidateQueries({ queryKey: getListCoopCampaignsQueryKey() });
        setOpen(false);
        setName(''); setBoost(''); setStartsAt(''); setEndsAt(''); setSelected(new Set()); setTemplate('custom');
      },
      onError: (err: unknown) =>
        toast({
          variant: 'destructive',
          title: 'Could not launch campaign',
          description: (err as { data?: { message?: string } })?.data?.message ?? 'Please try again.',
        }),
    },
  });

  const canSubmit =
    name.trim() && boost.trim() && startsAt && endsAt && selected.size > 0 && !create.isPending;

  return (
    <>
      <Button
        size="sm"
        onClick={() => setOpen(true)}
        disabled={partners.length === 0}
        data-testid="button-new-campaign"
      >
        <Rocket className="w-3.5 h-3.5 mr-1" /> New flash campaign
      </Button>
      {partners.length === 0 && (
        <p className="text-xs text-muted-foreground mt-1" data-testid="text-campaigns-need-partner">
          You need at least one accepted, active partnership to launch a campaign.
        </p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Launch a flash campaign</DialogTitle>
            <DialogDescription>
              One uniform start/end window applies identically to every participating partner.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Template</Label>
              <div className="grid grid-cols-2 gap-2">
                {(templates ?? []).map(t => (
                  <button
                    key={t.slug}
                    type="button"
                    onClick={() => applyTemplate(t)}
                    className={`rounded-md border p-2 text-left text-xs transition-colors ${
                      template === t.slug ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                    }`}
                    data-testid={`button-template-${t.slug}`}
                  >
                    <div className="font-medium">{t.label}</div>
                    <div className="text-muted-foreground mt-0.5 line-clamp-2">{t.description}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="campaign-name">Campaign name</Label>
              <Input
                id="campaign-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Riverside Holiday Weekend"
                data-testid="input-campaign-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="campaign-boost">Boosted perk description</Label>
              <Textarea
                id="campaign-boost"
                value={boost}
                onChange={e => setBoost(e.target.value)}
                placeholder="The flash offer every participant shows during the window"
                rows={2}
                data-testid="input-campaign-boost"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="campaign-start">Starts</Label>
                <Input
                  id="campaign-start"
                  type="datetime-local"
                  value={startsAt}
                  onChange={e => setStartsAt(e.target.value)}
                  data-testid="input-campaign-start"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="campaign-end">Ends</Label>
                <Input
                  id="campaign-end"
                  type="datetime-local"
                  value={endsAt}
                  onChange={e => setEndsAt(e.target.value)}
                  data-testid="input-campaign-end"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Invite partners</Label>
              <div className="space-y-1.5 max-h-36 overflow-y-auto rounded-md border p-2">
                {partners.map(p => (
                  <label key={p.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={selected.has(p.id)}
                      onCheckedChange={checked => {
                        setSelected(prev => {
                          const next = new Set(prev);
                          if (checked) next.add(p.id); else next.delete(p.id);
                          return next;
                        });
                      }}
                      data-testid={`checkbox-campaign-partner-${p.id}`}
                    />
                    {p.label}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!canSubmit}
              onClick={() =>
                create.mutate({
                  data: {
                    name: name.trim(),
                    template,
                    perkBoostText: boost.trim(),
                    startsAt: new Date(startsAt).toISOString(),
                    endsAt: new Date(endsAt).toISOString(),
                    partnerTenantIds: [...selected],
                  },
                })
              }
              data-testid="button-launch-campaign"
            >
              Launch campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
