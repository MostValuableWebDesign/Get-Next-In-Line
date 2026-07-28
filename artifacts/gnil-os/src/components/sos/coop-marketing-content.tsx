import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useListCoopMarketingTemplates, getListCoopMarketingTemplatesQueryKey,
  useGetCoopMarketingBranding, getGetCoopMarketingBrandingQueryKey,
  useListCoopMarketingChannels, getListCoopMarketingChannelsQueryKey,
  useCreateCoopMarketingChannel, useDeleteCoopMarketingChannel,
  useSuggestCoopMarketingCopy,
  useListCoopMarketingCampaigns, getListCoopMarketingCampaignsQueryKey,
  useCreateCoopMarketingCampaign, useRespondToCoopMarketingCampaign,
  useDispatchCoopMarketingCampaign,
  useGetCoopMarketingCampaignAnalytics, getGetCoopMarketingCampaignAnalyticsQueryKey,
  useListCoopPartnerships, getListCoopPartnershipsQueryKey,
  type CoopMarketingTemplate, type CoopMarketingCampaign,
  type CoopMarketingChannelTarget,
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
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import {
  BarChart3, Check, Download, Instagram, Link2, Megaphone, Palette,
  Send, Sparkles, Timer, Wand2, X,
} from 'lucide-react';

/**
 * Co-Op Automated Marketing & Social Media Syndication Hub.
 *
 * Partner businesses with an accepted co-op partnership generate co-branded
 * promotional assets from a template library (rendered client-side on a
 * canvas from both businesses' branding + offer fields), then compose joint
 * campaigns that broadcast across each participant's connected social
 * channels (simulated mode without real credentials) and SMS subscriber
 * list. Partners must approve a campaign before it goes out on their
 * channels; a unified per-campaign analytics ledger rolls up deliveries,
 * clicks, and reach per channel and per business.
 */
export function CoopMarketingSection({ tenantId }: { tenantId: number }) {
  const { data: campaigns, isLoading } = useListCoopMarketingCampaigns({
    query: { queryKey: getListCoopMarketingCampaignsQueryKey() },
  });

  const list = campaigns ?? [];
  const approvals = list.filter(c => !c.isCreator && c.myApproval === 'pending' && c.status === 'pending_approval');
  const others = list.filter(c => !approvals.includes(c));

  return (
    <Card data-testid="coop-marketing-section">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Megaphone className="w-4 h-4 text-primary" /> Marketing Hub
        </CardTitle>
        <CardDescription>
          Generate co-branded promo assets with a co-op partner and syndicate one joint campaign
          across both businesses' social channels and SMS subscribers — with unified analytics.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ChannelConnectionsCard tenantId={tenantId} />
        <AssetGeneratorDialog tenantId={tenantId} />
        {isLoading ? (
          <Skeleton className="h-20 w-full rounded-lg" />
        ) : (
          <>
            {approvals.length > 0 && (
              <div className="space-y-2" data-testid="list-marketing-approvals">
                <h4 className="text-sm font-semibold">Awaiting your approval</h4>
                {approvals.map(c => <MarketingCampaignCard key={c.id} campaign={c} />)}
              </div>
            )}
            <div className="space-y-2" data-testid="list-marketing-campaigns">
              <h4 className="text-sm font-semibold">Campaigns</h4>
              {others.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="text-no-marketing-campaigns">
                  No joint campaigns yet. Generate a co-branded asset to get started.
                </p>
              ) : (
                others.map(c => <MarketingCampaignCard key={c.id} campaign={c} />)
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Channel connections ──────────────────────────────────────────────────────

function ChannelConnectionsCard({ tenantId: _tenantId }: { tenantId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: channels } = useListCoopMarketingChannels({
    query: { queryKey: getListCoopMarketingChannelsQueryKey() },
  });
  const [handle, setHandle] = useState('');
  const [platform, setPlatform] = useState<'instagram' | 'facebook'>('instagram');

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListCoopMarketingChannelsQueryKey() });

  const connect = useCreateCoopMarketingChannel({
    mutation: {
      onSuccess: () => { setHandle(''); invalidate(); },
      onError: (err: unknown) =>
        toast({
          variant: 'destructive',
          title: 'Could not connect channel',
          description: (err as { data?: { message?: string } })?.data?.message ?? 'Please try again.',
        }),
    },
  });
  const disconnect = useDeleteCoopMarketingChannel({
    mutation: { onSuccess: invalidate },
  });

  const connected = channels ?? [];
  return (
    <div className="rounded-lg border p-3 space-y-2" data-testid="card-marketing-channels">
      <div className="text-sm font-medium flex items-center gap-2">
        <Instagram className="w-3.5 h-3.5" /> Social channels
      </div>
      {connected.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="text-no-channels">
          No channels connected. Joint campaigns can still reach SMS subscribers.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {connected.map(ch => (
            <Badge key={ch.id} variant="secondary" className="gap-1" data-testid={`badge-channel-${ch.platform}`}>
              {ch.platform} · @{ch.handle}
              <span className="text-[10px] uppercase text-muted-foreground">({ch.mode})</span>
              <button
                type="button"
                aria-label={`Disconnect ${ch.platform}`}
                onClick={() => disconnect.mutate({ id: ch.id })}
                data-testid={`button-disconnect-${ch.platform}`}
              >
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={platform}
          onChange={e => setPlatform(e.target.value as 'instagram' | 'facebook')}
          data-testid="select-channel-platform"
        >
          <option value="instagram">Instagram</option>
          <option value="facebook">Facebook</option>
        </select>
        <Input
          className="h-8 w-40 text-xs"
          placeholder="account handle"
          value={handle}
          onChange={e => setHandle(e.target.value)}
          data-testid="input-channel-handle"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!handle.trim() || connect.isPending}
          onClick={() => connect.mutate({ data: { platform, handle: handle.trim() } })}
          data-testid="button-connect-channel"
        >
          <Link2 className="w-3.5 h-3.5 mr-1" /> Connect
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Without real posting credentials, social posts run in clearly-labeled simulated mode.
      </p>
    </div>
  );
}

// ── Asset generator + campaign composer ─────────────────────────────────────

const PREVIEW_MAX = 320;

function drawAsset(
  canvas: HTMLCanvasElement,
  tpl: CoopMarketingTemplate,
  opts: {
    hostName: string; partnerName: string;
    primary: string; secondary: string;
    headline: string; body: string; offer: string;
    hostLogo?: HTMLImageElement | null; partnerLogo?: HTMLImageElement | null;
  },
) {
  const w = tpl.width ?? 1080;
  const h = tpl.height ?? 1080;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, opts.primary);
  grad.addColorStop(1, opts.secondary);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  const unit = Math.min(w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  const pad = unit * 0.06;
  ctx.fillRect(pad, pad, w - pad * 2, h - pad * 2);

  const logoSize = unit * 0.14;
  if (opts.hostLogo) ctx.drawImage(opts.hostLogo, pad * 1.5, pad * 1.5, logoSize, logoSize);
  if (opts.partnerLogo) ctx.drawImage(opts.partnerLogo, w - pad * 1.5 - logoSize, pad * 1.5, logoSize, logoSize);

  ctx.fillStyle = opts.primary;
  ctx.textAlign = 'center';
  ctx.font = `bold ${unit * 0.045}px sans-serif`;
  ctx.fillText(`${opts.hostName}  ×  ${opts.partnerName}`, w / 2, pad * 1.5 + logoSize * 0.7, w - pad * 4);

  ctx.font = `bold ${unit * 0.07}px sans-serif`;
  wrapText(ctx, opts.headline || 'Better Together!', w / 2, h * 0.42, w - pad * 4, unit * 0.085);

  ctx.fillStyle = '#333333';
  ctx.font = `${unit * 0.035}px sans-serif`;
  wrapText(ctx, opts.body, w / 2, h * 0.58, w - pad * 4, unit * 0.05);

  if (opts.offer) {
    ctx.fillStyle = opts.secondary;
    const bh = unit * 0.1;
    ctx.fillRect(pad * 2, h - pad * 2 - bh, w - pad * 4, bh);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${unit * 0.04}px sans-serif`;
    ctx.fillText(opts.offer, w / 2, h - pad * 2 - bh / 2 + unit * 0.014, w - pad * 5);
  }
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string, x: number, y: number, maxWidth: number, lineHeight: number,
) {
  const words = text.split(/\s+/);
  let line = '';
  let yy = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, yy, maxWidth);
      line = word;
      yy += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, yy, maxWidth);
}

function useLogoImage(dataUrl: string | undefined): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!dataUrl) { setImg(null); return; }
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = dataUrl;
  }, [dataUrl]);
  return img;
}

function AssetGeneratorDialog({ tenantId }: { tenantId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [partnershipId, setPartnershipId] = useState<number | null>(null);
  const [templateSlug, setTemplateSlug] = useState('instagram_square');
  const [name, setName] = useState('');
  const [headline, setHeadline] = useState('');
  const [body, setBody] = useState('');
  const [smsText, setSmsText] = useState('');
  const [offer, setOffer] = useState('');
  const [targets, setTargets] = useState<CoopMarketingChannelTarget[]>([]);
  const [schedule, setSchedule] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { data: templates } = useListCoopMarketingTemplates({
    query: { queryKey: getListCoopMarketingTemplatesQueryKey(), enabled: open },
  });
  const { data: partnerships } = useListCoopPartnerships(undefined, {
    query: { queryKey: getListCoopPartnershipsQueryKey(), enabled: open },
  });
  const accepted = useMemo(
    () => (partnerships ?? []).filter(p => p.status === 'accepted'),
    [partnerships],
  );
  useEffect(() => {
    if (open && partnershipId == null && accepted.length > 0) setPartnershipId(accepted[0].id);
  }, [open, accepted, partnershipId]);

  const { data: branding } = useGetCoopMarketingBranding(
    { partnershipId: partnershipId ?? 0 },
    {
      query: {
        queryKey: getGetCoopMarketingBrandingQueryKey({ partnershipId: partnershipId ?? 0 }),
        enabled: open && partnershipId != null,
      },
    },
  );
  const tpl = (templates ?? []).find(t => t.slug === templateSlug);
  const hostLogo = useLogoImage(branding?.host.logoUrl || undefined);
  const partnerLogo = useLogoImage(branding?.partner.logoUrl || undefined);

  // Re-render the canvas preview whenever inputs change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !tpl || tpl.width == null || !branding) return;
    drawAsset(canvas, tpl, {
      hostName: branding.host.name,
      partnerName: branding.partner.name,
      primary: branding.host.primaryColor,
      secondary: branding.partner.primaryColor,
      headline, body, offer: offer || branding.perkTitle,
      hostLogo, partnerLogo,
    });
  }, [tpl, branding, headline, body, offer, hostLogo, partnerLogo]);

  const suggest = useSuggestCoopMarketingCopy({
    mutation: {
      onSuccess: copy => {
        setHeadline(copy.headline);
        setBody(copy.body);
        setSmsText(copy.smsText);
      },
    },
  });
  const create = useCreateCoopMarketingCampaign({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCoopMarketingCampaignsQueryKey() });
        setOpen(false);
        toast({ title: 'Campaign created', description: 'Your partner must approve before it sends.' });
      },
      onError: (err: unknown) =>
        toast({
          variant: 'destructive',
          title: 'Could not create campaign',
          description: (err as { data?: { message?: string } })?.data?.message ?? 'Please try again.',
        }),
    },
  });

  const participantIds = useMemo(() => {
    const p = accepted.find(x => x.id === partnershipId);
    return p ? [p.hostTenantId, p.partnerTenantId] : [];
  }, [accepted, partnershipId]);

  const toggleTarget = (target: CoopMarketingChannelTarget) => {
    setTargets(prev => {
      const exists = prev.some(t => t.tenantId === target.tenantId && t.channel === target.channel);
      return exists
        ? prev.filter(t => !(t.tenantId === target.tenantId && t.channel === target.channel))
        : [...prev, target];
    });
  };
  const isTargeted = (tid: number, channel: CoopMarketingChannelTarget['channel']) =>
    targets.some(t => t.tenantId === tid && t.channel === channel);

  const download = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const a = document.createElement('a');
    a.download = `${templateSlug}-${Date.now()}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  };

  const nameOf = (tid: number) =>
    branding && branding.host.tenantId === tid ? branding.host.name : branding?.partner.name ?? `Business ${tid}`;

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-testid="button-open-marketing-generator">
        <Sparkles className="w-3.5 h-3.5 mr-1" /> Create co-branded campaign
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Co-branded campaign</DialogTitle>
            <DialogDescription>
              Pick a partner and template, tune the copy, preview the asset, then choose channels.
            </DialogDescription>
          </DialogHeader>
          {accepted.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-partnerships">
              You need an accepted co-op partnership to run a joint campaign.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Partnership</Label>
                  <select
                    className="mt-1 w-full h-9 rounded-md border bg-background px-2 text-sm"
                    value={partnershipId ?? ''}
                    onChange={e => { setPartnershipId(Number(e.target.value)); setTargets([]); }}
                    data-testid="select-marketing-partnership"
                  >
                    {accepted.map(p => (
                      <option key={p.id} value={p.id}>{p.perkTitle}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-xs">Template</Label>
                  <select
                    className="mt-1 w-full h-9 rounded-md border bg-background px-2 text-sm"
                    value={templateSlug}
                    onChange={e => setTemplateSlug(e.target.value)}
                    data-testid="select-marketing-template"
                  >
                    {(templates ?? []).map(t => (
                      <option key={t.slug} value={t.slug}>
                        {t.label}{t.width ? ` (${t.width}×${t.height})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <Label className="text-xs">Campaign name</Label>
                <Input
                  className="mt-1"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Fall cross-promo"
                  data-testid="input-marketing-name"
                />
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Label className="text-xs">Offer line</Label>
                  <Input
                    className="mt-1"
                    value={offer}
                    onChange={e => setOffer(e.target.value)}
                    placeholder={branding?.perkTitle ?? 'Shared offer'}
                    data-testid="input-marketing-offer"
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={partnershipId == null || suggest.isPending}
                  onClick={() =>
                    partnershipId != null &&
                    suggest.mutate({ data: { partnershipId, templateSlug, offerText: offer } })
                  }
                  data-testid="button-suggest-copy"
                >
                  <Wand2 className="w-3.5 h-3.5 mr-1" /> Suggest copy
                </Button>
              </div>
              <div>
                <Label className="text-xs">Headline</Label>
                <Input
                  className="mt-1"
                  value={headline}
                  onChange={e => setHeadline(e.target.value)}
                  data-testid="input-marketing-headline"
                />
              </div>
              <div>
                <Label className="text-xs">Body text</Label>
                <Textarea
                  className="mt-1"
                  rows={2}
                  value={body}
                  onChange={e => setBody(e.target.value)}
                  data-testid="input-marketing-body"
                />
              </div>
              <div>
                <Label className="text-xs">SMS blast text</Label>
                <Textarea
                  className="mt-1"
                  rows={2}
                  value={smsText}
                  onChange={e => setSmsText(e.target.value)}
                  placeholder="Short text for both subscriber lists (tracked link added automatically)"
                  data-testid="input-marketing-sms"
                />
              </div>
              {tpl && tpl.width != null && tpl.height != null && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs flex items-center gap-1">
                      <Palette className="w-3 h-3" /> Preview ({tpl.width}×{tpl.height})
                    </Label>
                    <Button size="sm" variant="ghost" onClick={download} data-testid="button-download-asset">
                      <Download className="w-3.5 h-3.5 mr-1" /> Download PNG
                    </Button>
                  </div>
                  <canvas
                    ref={canvasRef}
                    data-testid="canvas-marketing-preview"
                    style={{
                      width: tpl.width >= tpl.height ? PREVIEW_MAX : (PREVIEW_MAX * tpl.width) / tpl.height,
                      height: tpl.width >= tpl.height ? (PREVIEW_MAX * tpl.height) / tpl.width : PREVIEW_MAX,
                    }}
                    className="rounded-md border"
                  />
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-xs">Channels</Label>
                <div className="grid grid-cols-2 gap-2">
                  {participantIds.map(tid => (
                    <div key={tid} className="rounded-md border p-2 space-y-1">
                      <div className="text-xs font-medium">{nameOf(tid)}</div>
                      {(['sms', 'instagram', 'facebook'] as const).map(channel => (
                        <label key={channel} className="flex items-center gap-2 text-xs">
                          <Checkbox
                            checked={isTargeted(tid, channel)}
                            onCheckedChange={() => toggleTarget({ tenantId: tid, channel })}
                            data-testid={`checkbox-target-${tid}-${channel}`}
                          />
                          {channel === 'sms' ? 'SMS subscribers' : channel}
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <Label className="text-xs">Schedule (optional — blank sends after approval)</Label>
                <Input
                  className="mt-1"
                  type="datetime-local"
                  value={schedule}
                  onChange={e => setSchedule(e.target.value)}
                  data-testid="input-marketing-schedule"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={
                create.isPending || partnershipId == null || !name.trim() || targets.length === 0
              }
              onClick={() =>
                partnershipId != null &&
                create.mutate({
                  data: {
                    partnershipId,
                    name: name.trim(),
                    templateSlug,
                    headline,
                    bodyText: body,
                    smsText,
                    assetPayload: {
                      offer: offer || branding?.perkTitle || '',
                      hostName: branding?.host.name,
                      partnerName: branding?.partner.name,
                      primaryColor: branding?.host.primaryColor,
                      secondaryColor: branding?.partner.primaryColor,
                    },
                    channels: targets,
                    scheduledAt: schedule ? new Date(schedule).toISOString() : null,
                  },
                })
              }
              data-testid="button-create-marketing-campaign"
            >
              <Send className="w-3.5 h-3.5 mr-1" /> Create campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Campaign cards, approvals & analytics ────────────────────────────────────

const STATUS_LABELS: Record<CoopMarketingCampaign['status'], string> = {
  pending_approval: 'pending partner approval',
  scheduled: 'scheduled',
  sending: 'sending',
  sent: 'sent',
  failed: 'failed',
  declined: 'declined',
};

function MarketingCampaignCard({ campaign }: { campaign: CoopMarketingCampaign }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showAnalytics, setShowAnalytics] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListCoopMarketingCampaignsQueryKey() });

  const respond = useRespondToCoopMarketingCampaign({
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
  const dispatch = useDispatchCoopMarketingCampaign({
    mutation: {
      onSuccess: res => {
        invalidate();
        toast({
          title: 'Campaign sent',
          description: `${res.smsSent} SMS delivered, ${res.sends} channel sends.`,
        });
      },
      onError: (err: unknown) =>
        toast({
          variant: 'destructive',
          title: 'Could not send',
          description: (err as { data?: { message?: string } })?.data?.message ?? 'Please try again.',
        }),
    },
  });

  const canRespond = !campaign.isCreator && campaign.myApproval === 'pending' && !campaign.dispatchTriggeredAt;
  const allApproved = campaign.participants.every(p => p.approval === 'approved');
  const canDispatch =
    campaign.isCreator && allApproved && !campaign.dispatchTriggeredAt && campaign.status === 'scheduled';

  return (
    <div className="rounded-lg border p-3 space-y-2" data-testid={`card-marketing-campaign-${campaign.id}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="font-medium text-sm flex items-center gap-2">
            {campaign.name}
            <Badge variant="outline" className="text-[10px]">{campaign.templateSlug.replace(/_/g, ' ')}</Badge>
            <Badge
              variant={campaign.status === 'sent' ? 'default' : 'secondary'}
              className="text-[10px]"
              data-testid={`badge-marketing-status-${campaign.id}`}
            >
              {STATUS_LABELS[campaign.status]}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            by {campaign.creatorTenantName}
            {campaign.scheduledAt && (
              <span className="ml-2 inline-flex items-center gap-1">
                <Timer className="w-3 h-3" />
                {new Date(campaign.scheduledAt).toLocaleString(undefined, {
                  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                })}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {canRespond && (
            <>
              <Button
                size="sm"
                disabled={respond.isPending}
                onClick={() => respond.mutate({ id: campaign.id, data: { action: 'approve' } })}
                data-testid={`button-approve-marketing-${campaign.id}`}
              >
                <Check className="w-3.5 h-3.5 mr-1" /> Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={respond.isPending}
                onClick={() => respond.mutate({ id: campaign.id, data: { action: 'decline' } })}
                data-testid={`button-decline-marketing-${campaign.id}`}
              >
                <X className="w-3.5 h-3.5 mr-1" /> Decline
              </Button>
            </>
          )}
          {canDispatch && !campaign.scheduledAt && (
            <Button
              size="sm"
              disabled={dispatch.isPending}
              onClick={() => dispatch.mutate({ id: campaign.id })}
              data-testid={`button-dispatch-marketing-${campaign.id}`}
            >
              <Send className="w-3.5 h-3.5 mr-1" /> Send now
            </Button>
          )}
          {(campaign.status === 'sent' || campaign.status === 'failed') && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowAnalytics(v => !v)}
              data-testid={`button-analytics-marketing-${campaign.id}`}
            >
              <BarChart3 className="w-3.5 h-3.5 mr-1" /> Analytics
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {campaign.participants.map(p => (
          <Badge key={p.tenantId} variant="outline" className="text-[10px]" data-testid={`badge-participant-${campaign.id}-${p.tenantId}`}>
            {p.tenantName}: {p.approval}
          </Badge>
        ))}
      </div>
      {showAnalytics && <CampaignAnalytics campaignId={campaign.id} />}
    </div>
  );
}

function CampaignAnalytics({ campaignId }: { campaignId: number }) {
  const { data, isLoading } = useGetCoopMarketingCampaignAnalytics(campaignId, {
    query: { queryKey: getGetCoopMarketingCampaignAnalyticsQueryKey(campaignId) },
  });
  if (isLoading) return <Skeleton className="h-12 w-full rounded" />;
  if (!data) return null;
  return (
    <div className="rounded-md bg-muted/50 p-2 space-y-1 text-xs" data-testid={`analytics-marketing-${campaignId}`}>
      <div className="font-medium">
        Reach {data.totals.reach}
        {data.totals.simulatedReach > 0 && (
          <span className="text-muted-foreground"> ({data.totals.simulatedReach} simulated)</span>
        )}
        {' · '}Delivered {data.totals.delivered} · Failed {data.totals.failed} · Clicks {data.totals.clicks}
      </div>
      {data.entries.map((e, i) => (
        <div key={i} className="flex items-center justify-between gap-2 text-muted-foreground">
          <span>{e.tenantName} · {e.channel}{e.simulated ? ' (simulated)' : ''}</span>
          <span>
            {e.channel === 'sms'
              ? `${e.delivered}/${e.recipients} delivered, ${e.skipped} opted out`
              : `${e.impressions} impressions`}
            {' · '}{e.clicks} clicks
          </span>
        </div>
      ))}
    </div>
  );
}
