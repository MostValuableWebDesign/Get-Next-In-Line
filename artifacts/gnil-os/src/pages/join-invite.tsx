import { useState } from 'react';
import {
  useGetPublicPlatformInvite,
  getGetPublicPlatformInviteQueryKey,
  useRegisterViaPlatformInvite,
  type PlatformInviteRegistrationResult,
} from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle2, Clock, Handshake, Link2Off, Store } from 'lucide-react';

/**
 * Public fast-track registration page reached via a platform-invite link
 * (/join/:token). No login required — the invited business owner has no
 * account yet. Creates the business account + storefront, after which a
 * pending co-op partnership from the inviter is waiting in both hubs.
 */

const suggestSubdomain = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export default function JoinInvitePage({ token }: { token: string }) {
  const { data: invite, isLoading, isError } = useGetPublicPlatformInvite(token, {
    query: { queryKey: getGetPublicPlatformInviteQueryKey(token), retry: false },
  });

  return (
    <div className="min-h-screen bg-muted/30 flex items-start justify-center p-4 pt-10">
      <div className="w-full max-w-lg space-y-4">
        <div className="text-center space-y-1">
          <div className="text-lg font-bold tracking-tight">Get Next In Line</div>
          <p className="text-sm text-muted-foreground">Local merchant network</p>
        </div>

        {isLoading ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : isError || !invite ? (
          <FriendlyState
            icon={<Link2Off className="w-8 h-8 text-muted-foreground" />}
            title="This invitation link isn't valid"
            body="The link may have been copied incorrectly. Ask the business that invited you to send a new one."
            testId="state-invite-invalid"
          />
        ) : invite.status === 'expired' ? (
          <FriendlyState
            icon={<Clock className="w-8 h-8 text-muted-foreground" />}
            title="This invitation has expired"
            body={`Invitation links are only valid for a limited time. Ask ${invite.inviterBusinessName} to send you a fresh one.`}
            testId="state-invite-expired"
          />
        ) : invite.status === 'registered' ? (
          <FriendlyState
            icon={<CheckCircle2 className="w-8 h-8 text-emerald-600" />}
            title="This invitation was already used"
            body="An account has already been created with this link. If that was you, you're all set — otherwise ask the inviting business for a new link."
            testId="state-invite-used"
          />
        ) : (
          <RegistrationCard
            token={token}
            inviterName={invite.inviterBusinessName}
            invitedName={invite.invitedBusinessName}
          />
        )}
      </div>
    </div>
  );
}

function FriendlyState({
  icon, title, body, testId,
}: {
  icon: React.ReactNode; title: string; body: string; testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="p-8 text-center space-y-3">
        <div className="flex justify-center">{icon}</div>
        <div className="font-semibold">{title}</div>
        <p className="text-sm text-muted-foreground">{body}</p>
      </CardContent>
    </Card>
  );
}

function RegistrationCard({
  token, inviterName, invitedName,
}: {
  token: string; inviterName: string; invitedName: string;
}) {
  const [businessName, setBusinessName] = useState(invitedName);
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [category, setCategory] = useState('');
  const [subdomain, setSubdomain] = useState(suggestSubdomain(invitedName));
  const [subdomainTouched, setSubdomainTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<PlatformInviteRegistrationResult | null>(null);

  const register = useRegisterViaPlatformInvite();

  const submit = () => {
    setError(null);
    register.mutate(
      {
        token,
        data: {
          businessName: businessName.trim(),
          subdomain: subdomain.trim().toLowerCase(),
          ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
          ...(contactEmail.trim() ? { contactEmail: contactEmail.trim() } : {}),
          ...(category.trim() ? { category: category.trim() } : {}),
        },
      },
      {
        onSuccess: result => setDone(result),
        onError: (err: unknown) => {
          const e = err as { data?: { message?: string }; message?: string };
          setError(e?.data?.message ?? e?.message ?? 'Something went wrong. Please try again.');
        },
      },
    );
  };

  const subdomainValid = /^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/.test(subdomain.trim().toLowerCase());
  const canSubmit = businessName.trim() !== '' && subdomainValid && !register.isPending;

  if (done) {
    return (
      <Card data-testid="state-registration-success">
        <CardContent className="p-8 text-center space-y-3">
          <div className="flex justify-center"><CheckCircle2 className="w-8 h-8 text-emerald-600" /></div>
          <div className="font-semibold">Welcome to the network, {done.brandName}!</div>
          <p className="text-sm text-muted-foreground">
            Your business account and storefront are ready.
          </p>
          {done.partnershipCreated ? (
            <p className="text-sm flex items-center justify-center gap-1.5" data-testid="text-partnership-waiting">
              <Handshake className="w-4 h-4 text-primary" />
              A partnership request from {inviterName} is waiting in your Co-Op hub — accept it to
              put the cross-promotion perk live on both sides.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="text-partnership-blocked">
              {done.partnershipBlockedReason}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="card-fast-track-registration">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Store className="w-5 h-5 text-primary" /> Join &amp; partner with {inviterName}
        </CardTitle>
        <CardDescription>
          {inviterName} invited you to the local merchant network. Set up your business in under a
          minute to unlock automated customer cross-promotion.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="join-business-name">Business name</Label>
          <Input
            id="join-business-name"
            value={businessName}
            onChange={e => {
              setBusinessName(e.target.value);
              if (!subdomainTouched) setSubdomain(suggestSubdomain(e.target.value));
            }}
            data-testid="input-join-business-name"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="join-contact-name">Your name</Label>
            <Input
              id="join-contact-name"
              value={contactName}
              onChange={e => setContactName(e.target.value)}
              data-testid="input-join-contact-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="join-contact-email">Email</Label>
            <Input
              id="join-contact-email"
              type="email"
              value={contactEmail}
              onChange={e => setContactEmail(e.target.value)}
              data-testid="input-join-contact-email"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="join-category">Business category</Label>
          <Input
            id="join-category"
            placeholder="e.g. Florist, Cafe, Barbershop"
            value={category}
            onChange={e => setCategory(e.target.value)}
            data-testid="input-join-category"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="join-subdomain">Your web address</Label>
          <div className="flex items-center gap-2">
            <Input
              id="join-subdomain"
              value={subdomain}
              onChange={e => { setSubdomain(e.target.value); setSubdomainTouched(true); }}
              className="font-mono"
              data-testid="input-join-subdomain"
            />
            <span className="text-xs text-muted-foreground whitespace-nowrap">.getnextinline.io</span>
          </div>
          {!subdomainValid && subdomain.trim() !== '' && (
            <p className="text-xs text-destructive">
              Use 3–62 lowercase letters, numbers, or dashes (no leading/trailing dash).
            </p>
          )}
        </div>
        {error && (
          <p className="text-sm text-destructive" role="alert" data-testid="text-join-error">{error}</p>
        )}
        <Button
          className="w-full"
          onClick={submit}
          disabled={!canSubmit}
          data-testid="button-join-register"
        >
          {register.isPending ? 'Creating your account…' : 'Create My Business Account'}
        </Button>
      </CardContent>
    </Card>
  );
}
