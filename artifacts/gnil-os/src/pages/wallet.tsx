import React, { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  useRequestWalletLoginCode,
  useVerifyWalletLoginCode,
  useListWalletPasses,
  getListWalletPassesQueryKey,
  useGetWalletPassport,
  getGetWalletPassportQueryKey,
  useGetWalletAmbassador,
  getGetWalletAmbassadorQueryKey,
  useEnterWalletReferralCode,
  type WalletPass,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Gift, ChevronLeft, Clock, CheckCircle2, Smartphone, LogOut, TicketCheck, TicketX,
  Stamp, Trophy, Sparkles, MapPin,
} from 'lucide-react';

/**
 * "Local Perks" customer wallet — public, mobile-first, PWA-installable.
 * Customers sign in with their phone number (SMS code) and see the perk
 * passes deposited by local co-op businesses; tapping a pass shows the QR
 * staff scan at the partner storefront. Lives OUTSIDE the staff shell.
 */

const SESSION_KEY = 'gnil-wallet-session';

function loadSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export default function WalletPage() {
  const [session, setSession] = useState<string | null>(loadSession);
  const [selected, setSelected] = useState<WalletPass | null>(null);
  const [view, setView] = useState<'passes' | 'passport' | 'ambassador'>('passes');

  const signOut = () => {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    setSession(null);
    setSelected(null);
    setView('passes');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <div className="max-w-md mx-auto px-4 py-6">
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Gift className="h-6 w-6 text-amber-400" />
            <h1 className="text-xl font-bold tracking-tight">Local Perks</h1>
          </div>
          {session && (
            <Button variant="ghost" size="sm" className="text-slate-400" onClick={signOut} data-testid="button-wallet-signout">
              <LogOut className="h-4 w-4 mr-1" /> Sign out
            </Button>
          )}
        </header>
        {!session ? (
          <PhoneLogin onSession={(t) => {
            try { localStorage.setItem(SESSION_KEY, t); } catch { /* ignore */ }
            setSession(t);
          }} />
        ) : selected ? (
          <PassDetail pass={selected} onBack={() => setSelected(null)} />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2" data-testid="tabs-wallet-view">
              <Button
                variant={view === 'passes' ? 'default' : 'outline'}
                className={view === 'passes'
                  ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold'
                  : 'border-slate-700 bg-transparent text-slate-300 hover:bg-slate-900'}
                onClick={() => setView('passes')}
                data-testid="button-wallet-view-passes"
              >
                <Gift className="h-4 w-4 mr-1.5" /> My Perks
              </Button>
              <Button
                variant={view === 'passport' ? 'default' : 'outline'}
                className={view === 'passport'
                  ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold'
                  : 'border-slate-700 bg-transparent text-slate-300 hover:bg-slate-900'}
                onClick={() => setView('passport')}
                data-testid="button-wallet-view-passport"
              >
                <Stamp className="h-4 w-4 mr-1.5" /> Passport
              </Button>
              <Button
                variant={view === 'ambassador' ? 'default' : 'outline'}
                className={view === 'ambassador'
                  ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold'
                  : 'border-slate-700 bg-transparent text-slate-300 hover:bg-slate-900'}
                onClick={() => setView('ambassador')}
                data-testid="button-wallet-view-ambassador"
              >
                <Trophy className="h-4 w-4 mr-1.5" /> Ambassador
              </Button>
            </div>
            {view === 'passport' ? (
              <PassportView session={session} onUnauthorized={signOut} />
            ) : view === 'ambassador' ? (
              <AmbassadorView session={session} onUnauthorized={signOut} />
            ) : (
              <PassList session={session} onSelect={setSelected} onUnauthorized={signOut} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Phone login (request code → verify) ──────────────────────────────────────

function PhoneLogin({ onSession }: { onSession: (token: string) => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestCode = useRequestWalletLoginCode();
  const verify = useVerifyWalletLoginCode();

  const errMsg = (err: unknown, fallback: string) =>
    (err as { data?: { message?: string } })?.data?.message ?? fallback;

  return (
    <Card className="bg-slate-900 border-slate-800 text-slate-50">
      <CardContent className="pt-6 space-y-4">
        <div className="text-center space-y-1">
          <Smartphone className="h-10 w-10 mx-auto text-amber-400" />
          <h2 className="text-lg font-semibold">Your perks, one wallet</h2>
          <p className="text-sm text-slate-400">
            Sign in with your phone number to see the perk passes local businesses have given you.
          </p>
        </div>
        {!codeSent ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="wallet-phone" className="text-slate-300">Mobile number</Label>
              <Input
                id="wallet-phone"
                type="tel"
                inputMode="tel"
                placeholder="(555) 123-4567"
                className="bg-slate-950 border-slate-700 text-slate-50"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                data-testid="input-wallet-phone"
              />
            </div>
            {error && <p className="text-sm text-red-400" data-testid="text-wallet-error">{error}</p>}
            <Button
              className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold"
              disabled={requestCode.isPending || phone.trim().length < 7}
              onClick={() => {
                setError(null);
                requestCode.mutate(
                  { data: { phone: phone.trim() } },
                  {
                    onSuccess: () => setCodeSent(true),
                    onError: (err) => setError(errMsg(err, "Couldn't send the code — try again.")),
                  },
                );
              }}
              data-testid="button-wallet-send-code"
            >
              {requestCode.isPending ? 'Sending…' : 'Text me a sign-in code'}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="wallet-code" className="text-slate-300">Enter the 6-digit code we texted you</Label>
              <Input
                id="wallet-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                className="bg-slate-950 border-slate-700 text-slate-50 text-center text-lg tracking-[0.4em] font-mono"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                data-testid="input-wallet-code"
              />
            </div>
            {error && <p className="text-sm text-red-400" data-testid="text-wallet-error">{error}</p>}
            <Button
              className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold"
              disabled={verify.isPending || code.length !== 6}
              onClick={() => {
                setError(null);
                verify.mutate(
                  { data: { phone: phone.trim(), code } },
                  {
                    onSuccess: (res) => onSession(res.token),
                    onError: (err) => setError(errMsg(err, "That code didn't work — try again.")),
                  },
                );
              }}
              data-testid="button-wallet-verify"
            >
              {verify.isPending ? 'Verifying…' : 'Open my wallet'}
            </Button>
            <Button
              variant="ghost"
              className="w-full text-slate-400"
              onClick={() => { setCodeSent(false); setCode(''); setError(null); }}
              data-testid="button-wallet-change-phone"
            >
              Use a different number
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Pass list, grouped by status ─────────────────────────────────────────────

const STATUS_META: Record<WalletPass['status'], { label: string; icon: React.ElementType }> = {
  active: { label: 'Ready to use', icon: Gift },
  redeemed: { label: 'Used', icon: TicketCheck },
  expired: { label: 'Expired', icon: TicketX },
};

function PassList({
  session, onSelect, onUnauthorized,
}: {
  session: string;
  onSelect: (p: WalletPass) => void;
  onUnauthorized: () => void;
}) {
  const { data, isLoading, isError, error } = useListWalletPasses({
    query: { queryKey: [...getListWalletPassesQueryKey(), session] },
    request: { headers: { 'x-wallet-session': session } },
  });

  // Expired/invalid session → back to login.
  useEffect(() => {
    if (isError && (error as { status?: number })?.status === 401) onUnauthorized();
  }, [isError, error, onUnauthorized]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full bg-slate-800" />
        <Skeleton className="h-24 w-full bg-slate-800" />
      </div>
    );
  }
  const passes = data?.passes ?? [];
  if (passes.length === 0) {
    return (
      <Card className="bg-slate-900 border-slate-800 border-dashed text-slate-50">
        <CardContent className="pt-6 text-center space-y-2 pb-8" data-testid="text-wallet-empty">
          <Gift className="h-10 w-10 mx-auto text-slate-600" />
          <h2 className="font-semibold">No perks yet</h2>
          <p className="text-sm text-slate-400">
            Visit a participating local business — partner perks land here automatically after your visit.
          </p>
        </CardContent>
      </Card>
    );
  }

  const groups: WalletPass['status'][] = ['active', 'redeemed', 'expired'];
  return (
    <div className="space-y-6" data-testid="list-wallet-passes">
      {groups.map(status => {
        const items = passes.filter(p => p.status === status);
        if (items.length === 0) return null;
        const meta = STATUS_META[status];
        return (
          <section key={status}>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5">
              <meta.icon className="h-3.5 w-3.5" /> {meta.label}
            </h2>
            <div className="space-y-2">
              {items.map(p => (
                <button
                  key={p.id}
                  className="w-full text-left disabled:opacity-60"
                  onClick={() => onSelect(p)}
                  data-testid={`card-wallet-pass-${p.id}`}
                >
                  <Card className={`bg-slate-900 border-slate-800 text-slate-50 transition-colors ${status === 'active' ? 'hover:border-amber-500/60' : 'opacity-70'}`}>
                    <CardContent className="py-4 space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-semibold">{p.perkTitle}</div>
                        {status === 'active' && <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30 shrink-0">Active</Badge>}
                      </div>
                      <p className="text-sm text-slate-400">
                        Redeem at <span className="text-slate-200 font-medium">{p.redeemAtBusinessName}</span>
                        {' · '}from {p.grantedByBusinessName}
                      </p>
                      <p className="text-xs text-slate-500 flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {status === 'redeemed' && p.redeemedAt
                          ? `Used ${new Date(p.redeemedAt).toLocaleDateString()}`
                          : `Expires ${new Date(p.expiresAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`}
                      </p>
                    </CardContent>
                  </Card>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ── Neighborhood Passport — stamps, tiers, challenges, rewards ──────────────

const REWARD_LABELS: Record<string, string> = {
  bonus_perk: 'Bonus perk',
  sweepstakes_entry: 'Sweepstakes entry',
  free_upgrade: 'Free upgrade',
};

function PassportView({ session, onUnauthorized }: { session: string; onUnauthorized: () => void }) {
  const { data, isLoading, isError, error } = useGetWalletPassport({
    query: { queryKey: [...getGetWalletPassportQueryKey(), session] },
    request: { headers: { 'x-wallet-session': session } },
  });

  useEffect(() => {
    if (isError && (error as { status?: number })?.status === 401) onUnauthorized();
  }, [isError, error, onUnauthorized]);

  if (isLoading || !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full bg-slate-800" />
        <Skeleton className="h-24 w-full bg-slate-800" />
      </div>
    );
  }

  const nextTier = data.tiers.find(t => !t.unlocked) ?? null;

  return (
    <div className="space-y-4" data-testid="view-wallet-passport">
      {/* Tier status + progress toward the next badge */}
      <Card className="bg-slate-900 border-slate-800 text-slate-50">
        <CardContent className="pt-6 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="font-bold text-lg flex items-center gap-2">
                <Stamp className="h-5 w-5 text-amber-400" /> Neighborhood Passport
              </h2>
              <p className="text-sm text-slate-400" data-testid="text-passport-stamp-count">
                {data.stampCount} {data.stampCount === 1 ? 'business' : 'businesses'} stamped
              </p>
            </div>
            {data.currentTier && (
              <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30 shrink-0" data-testid="badge-passport-tier">
                <Trophy className="h-3 w-3 mr-1" /> {data.currentTier}
              </Badge>
            )}
          </div>
          {nextTier && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-slate-400">
                <span>Next badge: <span className="text-slate-200">{nextTier.name}</span></span>
                <span>{data.stampCount}/{nextTier.threshold}</span>
              </div>
              <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-amber-500 transition-all"
                  style={{ width: `${Math.min(100, (data.stampCount / nextTier.threshold) * 100)}%` }}
                />
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {data.tiers.map(t => (
              <Badge
                key={t.name}
                variant="outline"
                className={t.unlocked
                  ? 'border-amber-500/40 text-amber-300'
                  : 'border-slate-700 text-slate-500'}
              >
                {t.name} · {t.threshold}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Stamp grid */}
      {data.stamps.length === 0 ? (
        <Card className="bg-slate-900 border-slate-800 border-dashed text-slate-50">
          <CardContent className="pt-6 text-center space-y-2 pb-8" data-testid="text-passport-empty">
            <MapPin className="h-10 w-10 mx-auto text-slate-600" />
            <h3 className="font-semibold">No stamps yet</h3>
            <p className="text-sm text-slate-400">
              Redeem a partner perk at a local business to earn your first passport stamp.
            </p>
          </CardContent>
        </Card>
      ) : (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Stamps</h3>
          <div className="grid grid-cols-2 gap-2" data-testid="grid-passport-stamps">
            {data.stamps.map((s, i) => (
              <Card key={i} className="bg-slate-900 border-slate-800 text-slate-50">
                <CardContent className="py-3 px-3 space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <Stamp className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                    <span className="font-medium text-sm truncate">{s.businessName}</span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {new Date(s.stampedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Active challenges */}
      {data.challenges.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Challenges</h3>
          <div className="space-y-2" data-testid="list-passport-challenges">
            {data.challenges.map(c => (
              <Card key={c.id} className="bg-slate-900 border-slate-800 text-slate-50">
                <CardContent className="py-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-sm">{c.title}</div>
                      <p className="text-xs text-slate-400">
                        Visit {c.requiredBusinesses} businesses in {c.windowDays} days · by {c.sponsorName}
                      </p>
                    </div>
                    {c.completed && (
                      <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30 shrink-0">
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Done
                      </Badge>
                    )}
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>{REWARD_LABELS[c.rewardType] ?? c.rewardType}: {c.rewardDescription}</span>
                      <span>{c.progress}/{c.requiredBusinesses}</span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${c.completed ? 'bg-emerald-500' : 'bg-amber-500'}`}
                        style={{ width: `${Math.min(100, (c.progress / c.requiredBusinesses) * 100)}%` }}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Earned rewards */}
      {data.rewards.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Earned rewards</h3>
          <div className="space-y-2" data-testid="list-passport-rewards">
            {data.rewards.map(r => (
              <Card key={r.id} className="bg-slate-900 border-emerald-500/30 text-slate-50">
                <CardContent className="py-3 space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <Sparkles className="h-4 w-4 text-emerald-400 shrink-0" />
                    <span className="font-medium text-sm">{REWARD_LABELS[r.rewardType] ?? r.rewardType}: {r.rewardDescription}</span>
                  </div>
                  <p className="text-xs text-slate-500">
                    "{r.challengeTitle}" · {r.sponsorName} · {new Date(r.issuedAt).toLocaleDateString()}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── Ambassador Program — tier, progress, referral code, network rewards ─────

const AMBASSADOR_SOURCE_LABELS: Record<string, string> = {
  referral_referrer: 'Friend referral',
  referral_friend: 'Welcome reward',
};

function AmbassadorView({ session, onUnauthorized }: { session: string; onUnauthorized: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useGetWalletAmbassador({
    query: { queryKey: [...getGetWalletAmbassadorQueryKey(), session] },
    request: { headers: { 'x-wallet-session': session } },
  });
  const [refCode, setRefCode] = useState('');
  const [refError, setRefError] = useState<string | null>(null);
  const enterCode = useEnterWalletReferralCode({
    request: { headers: { 'x-wallet-session': session } },
    mutation: {
      onSuccess: () => {
        setRefCode('');
        setRefError(null);
        queryClient.invalidateQueries({ queryKey: getGetWalletAmbassadorQueryKey() });
      },
      onError: (err: unknown) =>
        setRefError((err as { data?: { message?: string } })?.data?.message ?? "That code didn't work."),
    },
  });

  useEffect(() => {
    if (isError && (error as { status?: number })?.status === 401) onUnauthorized();
  }, [isError, error, onUnauthorized]);

  if (isLoading || !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full bg-slate-800" />
        <Skeleton className="h-24 w-full bg-slate-800" />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="view-wallet-ambassador">
      {/* Tier + progress toward the next tier */}
      <Card className="bg-slate-900 border-slate-800 text-slate-50">
        <CardContent className="pt-6 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="font-bold text-lg flex items-center gap-2">
                <Trophy className="h-5 w-5 text-amber-400" /> Community Ambassador
              </h2>
              <p className="text-sm text-slate-400" data-testid="text-ambassador-progress">
                {data.distinctPartners} {data.distinctPartners === 1 ? 'business' : 'businesses'} visited ·{' '}
                {data.convertedReferrals} {data.convertedReferrals === 1 ? 'friend' : 'friends'} referred
              </p>
            </div>
            <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30 shrink-0" data-testid="badge-ambassador-tier">
              {data.tier.name}
            </Badge>
          </div>
          {(data.tier.discountPercent > 0 || data.tier.vip) && (
            <p className="text-sm text-emerald-300" data-testid="text-ambassador-benefits">
              <Sparkles className="h-3.5 w-3.5 inline mr-1" />
              Network benefits: {data.tier.discountPercent > 0 ? `${data.tier.discountPercent}% off at every opted-in partner` : ''}
              {data.tier.discountPercent > 0 && data.tier.vip ? ' · ' : ''}
              {data.tier.vip ? 'VIP treatment' : ''}
            </p>
          )}
          {data.nextTier && (
            <p className="text-xs text-slate-400" data-testid="text-ambassador-next-tier">
              Next: <span className="text-slate-200">{data.nextTier.name}</span> — visit{' '}
              {data.nextTier.partnersRemaining} more {data.nextTier.partnersRemaining === 1 ? 'business' : 'businesses'} or refer{' '}
              {data.nextTier.referralsRemaining} more {data.nextTier.referralsRemaining === 1 ? 'friend' : 'friends'}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Personal referral code */}
      <Card className="bg-slate-900 border-slate-800 text-slate-50">
        <CardContent className="pt-6 space-y-2 text-center">
          <h3 className="font-semibold text-sm">Your referral code</h3>
          <p className="text-2xl font-mono font-bold tracking-widest text-amber-300" data-testid="text-ambassador-referral-code">
            {data.referralCode}
          </p>
          <p className="text-xs text-slate-500">
            Share it with a friend — when they visit any participating business, you both earn a
            reward good at every opted-in storefront.
          </p>
        </CardContent>
      </Card>

      {/* Enter a friend's code (only until this customer is referred) */}
      {data.referredByStatus == null && (
        <Card className="bg-slate-900 border-slate-800 text-slate-50">
          <CardContent className="pt-6 space-y-2">
            <Label htmlFor="ambassador-ref-code" className="text-sm">Were you referred? Enter your friend's code</Label>
            <div className="flex gap-2">
              <Input
                id="ambassador-ref-code"
                value={refCode}
                onChange={e => setRefCode(e.target.value)}
                placeholder="FRIEND-XXXXXX"
                className="bg-slate-950 border-slate-700"
                data-testid="input-ambassador-referral-code"
              />
              <Button
                disabled={!refCode.trim() || enterCode.isPending}
                onClick={() => enterCode.mutate({ data: { code: refCode.trim() } })}
                className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold"
                data-testid="button-ambassador-enter-code"
              >
                {enterCode.isPending ? 'Saving…' : 'Apply'}
              </Button>
            </div>
            {refError && <p className="text-xs text-red-400" data-testid="text-ambassador-referral-error">{refError}</p>}
          </CardContent>
        </Card>
      )}
      {data.referredByStatus === 'pending' && (
        <p className="text-xs text-slate-400" data-testid="text-ambassador-referred-pending">
          Referral applied — complete a visit at any participating business to unlock rewards for you and your friend.
        </p>
      )}

      {/* Network-wide rewards */}
      {data.rewards.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Network rewards</h3>
          <div className="space-y-2" data-testid="list-ambassador-rewards">
            {data.rewards.map(r => (
              <Card key={r.id} className={`bg-slate-900 text-slate-50 ${r.status === 'issued' ? 'border-emerald-500/30' : 'border-slate-800 opacity-70'}`}>
                <CardContent className="py-3 space-y-0.5" data-testid={`card-ambassador-reward-${r.id}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm">
                      <Sparkles className="h-3.5 w-3.5 inline mr-1 text-emerald-400" />
                      ${r.amount.toFixed(2)} · {AMBASSADOR_SOURCE_LABELS[r.source] ?? r.source}
                    </span>
                    {r.status === 'issued'
                      ? <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">Ready</Badge>
                      : <Badge variant="outline" className="text-slate-400 border-slate-700">Used</Badge>}
                  </div>
                  {r.status === 'issued' ? (
                    <p className="text-xs text-slate-400">
                      Show code <span className="font-mono text-slate-200">{r.code}</span> at any opted-in business
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      Redeemed{r.redeemedAtBusiness ? ` at ${r.redeemedAtBusiness}` : ''}
                      {r.redeemedAt ? ` on ${new Date(r.redeemedAt).toLocaleDateString()}` : ''}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── Pass detail with QR + expiry countdown ───────────────────────────────────

function useCountdown(target: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return useMemo(() => {
    const ms = new Date(target).getTime() - now;
    if (ms <= 0) return 'Expired';
    const days = Math.floor(ms / 86_400_000);
    if (days >= 2) return `Expires in ${days} days`;
    const hours = Math.floor(ms / 3_600_000);
    if (hours >= 2) return `Expires in ${hours} hours`;
    return `Expires in ${Math.max(1, Math.floor(ms / 60_000))} minutes`;
  }, [target, now]);
}

function PassDetail({ pass, onBack }: { pass: WalletPass; onBack: () => void }) {
  const countdown = useCountdown(pass.expiresAt);
  const usable = pass.status === 'active';
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="text-slate-400 -ml-2" onClick={onBack} data-testid="button-wallet-back">
        <ChevronLeft className="h-4 w-4 mr-1" /> All perks
      </Button>
      <Card className="bg-slate-900 border-slate-800 text-slate-50">
        <CardContent className="pt-6 text-center space-y-4" data-testid="card-wallet-pass-detail">
          <div className="space-y-1">
            <h2 className="text-lg font-bold">{pass.perkTitle}</h2>
            {pass.perkDescription && <p className="text-sm text-slate-400">{pass.perkDescription}</p>}
            <p className="text-sm text-slate-300">
              Show this at <span className="font-semibold">{pass.redeemAtBusinessName}</span>
            </p>
          </div>
          <div className={`mx-auto w-fit rounded-xl bg-white p-4 ${usable ? '' : 'opacity-30'}`} data-testid="qr-wallet-pass">
            <QRCodeSVG value={pass.token} size={208} marginSize={0} />
          </div>
          {usable ? (
            <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30" data-testid="text-wallet-countdown">
              <Clock className="h-3 w-3 mr-1" /> {countdown}
            </Badge>
          ) : pass.status === 'redeemed' ? (
            <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Used{pass.redeemedAt ? ` on ${new Date(pass.redeemedAt).toLocaleDateString()}` : ''}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-slate-400 border-slate-700">Expired</Badge>
          )}
          <p className="text-xs text-slate-500">
            Staff scan this code once — it locks after redemption. Perk provided by {pass.grantedByBusinessName}'s partner network.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
