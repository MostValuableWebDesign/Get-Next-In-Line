import { useEffect, useState } from 'react';
import {
  useGetAmbassadorProgram, getGetAmbassadorProgramQueryKey,
  useUpdateAmbassadorProgram,
  useGetAmbassadorLedger, getGetAmbassadorLedgerQueryKey,
  useRedeemAmbassadorReward,
  type AmbassadorRewardRedeemResult,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Trophy, Users, Coins, TicketCheck, Scale } from 'lucide-react';

/**
 * Ambassador Program — merchant console inside the Co-Op hub.
 *
 * Customers who redeem co-op perks across multiple partner businesses and
 * refer friends advance through network-wide ambassador tiers. Opted-in
 * merchants pledge a small amount per redemption into a shared reward pool;
 * referral rewards are redeemable at any opted-in storefront, with the
 * acquisition cost attributed to the business that received the referred
 * foot traffic. This section covers opt-in/pledge settings, the pool balance
 * and ledger, top ambassadors, referral stats, and staff reward redemption.
 */

const TIER_LABELS: Record<string, string> = {
  member: 'Member',
  advocate: 'Advocate',
  ambassador: 'Community Ambassador',
};

export function AmbassadorProgramSection({ tenantId }: { tenantId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: program, isLoading } = useGetAmbassadorProgram({
    query: { queryKey: [...getGetAmbassadorProgramQueryKey(), tenantId] },
  });
  const { data: ledger } = useGetAmbassadorLedger({
    query: { queryKey: [...getGetAmbassadorLedgerQueryKey(), tenantId] },
  });

  const [pledge, setPledge] = useState('');
  useEffect(() => {
    if (program) setPledge(String(program.settings.pledgePerRedemption));
  }, [program]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetAmbassadorProgramQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetAmbassadorLedgerQueryKey() });
  };

  const update = useUpdateAmbassadorProgram({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: 'Ambassador Program settings saved' });
      },
      onError: (err: unknown) =>
        toast({
          title: 'Could not save settings',
          description: (err as { message?: string })?.message ?? 'Please try again.',
          variant: 'destructive',
        }),
    },
  });

  const [rewardCode, setRewardCode] = useState('');
  const [redeemResult, setRedeemResult] = useState<AmbassadorRewardRedeemResult | null>(null);
  const redeem = useRedeemAmbassadorReward({
    mutation: {
      onSuccess: (res) => {
        setRedeemResult(res);
        if (res.valid) {
          setRewardCode('');
          invalidate();
        }
      },
      onError: () => setRedeemResult(null),
    },
  });

  if (isLoading || !program) {
    return (
      <Card data-testid="ambassador-program-section">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Trophy className="w-4 h-4 text-primary" /> Ambassador Program
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  const pledgeNumber = Number(pledge);
  const pledgeValid = Number.isFinite(pledgeNumber) && pledgeNumber >= 0 && pledgeNumber <= 100;
  const optedIn = program.settings.optedIn;

  return (
    <Card data-testid="ambassador-program-section">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Trophy className="w-4 h-4 text-primary" /> Ambassador Program
        </CardTitle>
        <CardDescription>
          Frequent co-op customers earn network-wide tiers and referral rewards funded by a shared
          pool. Opt in to honor ambassador benefits and pledge a small amount per redemption.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Opt-in + pledge */}
        <div className="rounded-lg border p-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Participate in the Ambassador Program</p>
              <p className="text-xs text-muted-foreground">
                Opted-in businesses fund the pool, honor tier benefits, and can redeem network rewards.
              </p>
            </div>
            <Switch
              checked={optedIn}
              disabled={update.isPending}
              onCheckedChange={(checked) =>
                update.mutate({
                  data: {
                    optedIn: checked,
                    ...(pledgeValid ? { pledgePerRedemption: pledgeNumber } : {}),
                  },
                })
              }
              data-testid="switch-ambassador-opt-in"
            />
          </div>
          <div className="flex items-end gap-2">
            <div className="space-y-1.5 flex-1">
              <Label htmlFor="ambassador-pledge">Pledge per co-op redemption ($)</Label>
              <Input
                id="ambassador-pledge"
                type="number"
                min={0}
                max={100}
                step="0.25"
                value={pledge}
                onChange={e => setPledge(e.target.value)}
                data-testid="input-ambassador-pledge"
              />
            </div>
            <Button
              size="sm"
              disabled={!pledgeValid || update.isPending}
              onClick={() => update.mutate({ data: { optedIn, pledgePerRedemption: pledgeNumber } })}
              data-testid="button-save-ambassador-pledge"
            >
              {update.isPending ? 'Saving…' : 'Save pledge'}
            </Button>
          </div>
        </div>

        {/* Pool + my balance */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border p-3 text-center">
            <Coins className="w-4 h-4 mx-auto text-primary mb-1" />
            <p className="text-lg font-semibold" data-testid="text-ambassador-pool-balance">
              ${program.poolBalance.toFixed(2)}
            </p>
            <p className="text-xs text-muted-foreground">Shared pool</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <Scale className="w-4 h-4 mx-auto text-primary mb-1" />
            <p className="text-lg font-semibold" data-testid="text-ambassador-my-contribution">
              ${program.myContribution.toFixed(2)}
            </p>
            <p className="text-xs text-muted-foreground">You contributed</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <Users className="w-4 h-4 mx-auto text-primary mb-1" />
            <p className="text-lg font-semibold" data-testid="text-ambassador-my-benefit">
              ${program.myBenefit.toFixed(2)}
            </p>
            <p className="text-xs text-muted-foreground">Attributed to you</p>
          </div>
        </div>

        {/* Referral stats */}
        <p className="text-xs text-muted-foreground" data-testid="text-ambassador-referral-stats">
          Referrals network-wide: {program.referralStats.totalReferrals} started ·{' '}
          {program.referralStats.convertedReferrals} converted ·{' '}
          {program.referralStats.convertedAtThisBusiness} converted at your business
        </p>

        {/* Tier defaults */}
        <div className="flex flex-wrap gap-1.5" data-testid="list-ambassador-tiers">
          {program.tiers.map(t => (
            <Badge key={t.key} variant="outline">
              {t.name}
              {t.minPartners > 0 && ` · ${t.minPartners} businesses or ${t.minReferrals} referrals`}
              {t.discountPercent > 0 && ` → ${t.discountPercent}% off${t.vip ? ' + VIP' : ''}`}
            </Badge>
          ))}
        </div>

        {/* Staff reward redemption */}
        <div className="rounded-lg border p-3 space-y-2">
          <p className="text-sm font-medium flex items-center gap-1.5">
            <TicketCheck className="w-4 h-4 text-primary" /> Redeem an ambassador reward
          </p>
          <div className="flex gap-2">
            <Input
              value={rewardCode}
              onChange={e => setRewardCode(e.target.value)}
              placeholder="AMB-XXXXXXXX"
              data-testid="input-ambassador-reward-code"
            />
            <Button
              size="sm"
              disabled={!rewardCode.trim() || redeem.isPending}
              onClick={() => redeem.mutate({ data: { code: rewardCode.trim() } })}
              data-testid="button-redeem-ambassador-reward"
            >
              {redeem.isPending ? 'Checking…' : 'Redeem'}
            </Button>
          </div>
          {redeemResult && (
            redeemResult.valid ? (
              <p className="text-sm text-green-600 dark:text-green-400" data-testid="text-ambassador-redeem-success">
                Reward redeemed — apply ${redeemResult.reward?.amount.toFixed(2)} off this checkout.
              </p>
            ) : (
              <p className="text-sm text-destructive" data-testid="text-ambassador-redeem-error">
                {redeemResult.reason}
              </p>
            )
          )}
        </div>

        {/* Top ambassadors */}
        {program.topAmbassadors.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Top ambassadors</p>
            <div className="space-y-1" data-testid="list-top-ambassadors">
              {program.topAmbassadors.map((a, i) => (
                <div key={i} className="flex items-center justify-between text-sm rounded-md border px-3 py-1.5">
                  <span>{a.displayName}</span>
                  <span className="text-xs text-muted-foreground">
                    {TIER_LABELS[a.tier] ?? a.tier} · {a.distinctPartners} businesses · {a.convertedReferrals} referrals
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pool ledger */}
        {ledger && ledger.entries.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Pool ledger</p>
            <div className="space-y-1 max-h-56 overflow-y-auto" data-testid="list-ambassador-ledger">
              {ledger.entries.map(e => (
                <div key={e.id} className="flex items-center justify-between text-sm rounded-md border px-3 py-1.5">
                  <div className="min-w-0">
                    <p className="truncate">{e.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {e.businessName ?? 'Network'} · {new Date(e.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <span className={`shrink-0 font-medium ${e.entryType === 'contribution' ? 'text-green-600 dark:text-green-400' : 'text-destructive'}`}>
                    {e.entryType === 'contribution' ? '+' : '−'}${e.amount.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
