import React, { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  useRequestWalletLoginCode,
  useVerifyWalletLoginCode,
  useListWalletPasses,
  getListWalletPassesQueryKey,
  type WalletPass,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Gift, ChevronLeft, Clock, CheckCircle2, Smartphone, LogOut, TicketCheck, TicketX,
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

  const signOut = () => {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    setSession(null);
    setSelected(null);
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
          <PassList session={session} onSelect={setSelected} onUnauthorized={signOut} />
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
