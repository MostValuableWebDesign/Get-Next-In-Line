import { useState } from 'react';
import { useLocation } from 'wouter';
import {
  useSubmitCoopApplication,
  useGetPublicCoopApplicationStatus,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle2, Clock, XCircle, Store, Copy } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

// ── Public co-op join application ────────────────────────────────────────────
// /apply          — the application form (no login required)
// /apply/:token   — applicant-facing status page

function PublicFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[hsl(210,20%,98%)] flex items-start justify-center py-12 px-4">
      <div className="w-full max-w-xl space-y-6">
        <div className="text-center">
          <div className="inline-flex items-center gap-2 text-indigo-600 font-bold text-xl">
            <Store className="w-6 h-6" /> Get Next In Line
          </div>
          <p className="text-muted-foreground text-sm mt-1">Local Business Co-Op Network</p>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ApplyPage() {
  const submit = useSubmitCoopApplication();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [statusToken, setStatusToken] = useState<string | null>(null);

  if (statusToken) {
    return (
      <PublicFrame>
        <Card className="border-none shadow-md" data-testid="card-application-received">
          <CardContent className="p-8 text-center space-y-4">
            <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
            <div>
              <h2 className="text-xl font-semibold">Application received!</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Our network team will review it. Save this link to check your status any time:
              </p>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-muted rounded px-3 py-2 text-xs break-all" data-testid="text-status-link">
                {`${window.location.origin}/apply/${statusToken}`}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() => {
                  navigator.clipboard?.writeText(`${window.location.origin}/apply/${statusToken}`).catch(() => {});
                  toast({ title: 'Link copied' });
                }}
              >
                <Copy className="w-4 h-4" />
              </Button>
            </div>
            <Button onClick={() => navigate(`/apply/${statusToken}`)} data-testid="button-view-status">
              View Status
            </Button>
          </CardContent>
        </Card>
      </PublicFrame>
    );
  }

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    submit.mutate(
      {
        data: {
          businessName: fd.get('businessName') as string,
          subdomain: (fd.get('subdomain') as string).toLowerCase(),
          contactName: (fd.get('contactName') as string) || undefined,
          contactEmail: (fd.get('contactEmail') as string) || undefined,
          category: (fd.get('category') as string) || undefined,
          pitch: (fd.get('pitch') as string) || undefined,
        },
      },
      {
        onSuccess: (res) => setStatusToken(res.statusToken),
        onError: (err: unknown) => {
          const msg = (err as { data?: { message?: string } })?.data?.message ?? 'Something went wrong — please try again.';
          toast({ title: 'Could not submit', description: msg, variant: 'destructive' });
        },
      },
    );
  };

  return (
    <PublicFrame>
      <Card className="border-none shadow-md" data-testid="card-apply-form">
        <CardHeader>
          <CardTitle>Apply to join the co-op</CardTitle>
          <CardDescription>
            Tell us about your business. Once approved, your storefront is set up automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="businessName">Business name</Label>
              <Input id="businessName" name="businessName" required minLength={2} placeholder="Rosie's Flowers" data-testid="input-business-name" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="subdomain">Preferred web address</Label>
              <div className="flex items-center gap-2">
                <Input id="subdomain" name="subdomain" required minLength={2} pattern="[A-Za-z0-9][A-Za-z0-9-]*" placeholder="rosies" className="flex-1" data-testid="input-subdomain" />
                <span className="text-sm font-mono text-muted-foreground bg-muted px-3 py-2 rounded border">.gnil.os</span>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="contactName">Contact name</Label>
                <Input id="contactName" name="contactName" placeholder="Rosie Alvarez" data-testid="input-contact-name" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactEmail">Contact email</Label>
                <Input id="contactEmail" name="contactEmail" type="email" placeholder="rosie@example.com" data-testid="input-contact-email" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="category">Business category</Label>
              <Input id="category" name="category" placeholder="Florist" data-testid="input-category" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pitch">Tell us about your business</Label>
              <Textarea id="pitch" name="pitch" rows={4} placeholder="What you do, how long you've been operating, and why you'd like to join the network…" data-testid="input-pitch" />
            </div>
            <Button type="submit" className="w-full" disabled={submit.isPending} data-testid="button-submit-application">
              {submit.isPending ? 'Submitting…' : 'Submit Application'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </PublicFrame>
  );
}

const STATUS_UI: Record<string, { icon: React.ReactNode; label: string; blurb: string; badge: string }> = {
  submitted: {
    icon: <Clock className="w-12 h-12 text-blue-500 mx-auto" />,
    label: 'Submitted',
    blurb: 'Your application is in the queue. The network team will pick it up shortly.',
    badge: 'bg-blue-100 text-blue-800',
  },
  under_review: {
    icon: <Clock className="w-12 h-12 text-amber-500 mx-auto" />,
    label: 'Under Review',
    blurb: 'A reviewer is verifying your business details right now.',
    badge: 'bg-amber-100 text-amber-800',
  },
  approved: {
    icon: <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />,
    label: 'Approved',
    blurb: "Welcome to the co-op! Your storefront has been provisioned — expect your login credentials from the network team shortly.",
    badge: 'bg-emerald-100 text-emerald-800',
  },
  rejected: {
    icon: <XCircle className="w-12 h-12 text-red-500 mx-auto" />,
    label: 'Not Approved',
    blurb: 'Unfortunately your application was not approved this time.',
    badge: 'bg-red-100 text-red-700',
  },
};

export function ApplyStatusPage({ token }: { token: string }) {
  const { data, isLoading, isError } = useGetPublicCoopApplicationStatus(token);

  return (
    <PublicFrame>
      <Card className="border-none shadow-md" data-testid="card-application-status">
        {isLoading ? (
          <CardContent className="p-8 space-y-3">
            <Skeleton className="h-12 w-12 rounded-full mx-auto" />
            <Skeleton className="h-6 w-48 mx-auto" />
            <Skeleton className="h-4 w-64 mx-auto" />
          </CardContent>
        ) : isError || !data ? (
          <CardContent className="p-8 text-center space-y-2" data-testid="status-not-found">
            <XCircle className="w-12 h-12 text-muted-foreground mx-auto" />
            <h2 className="text-xl font-semibold">Application not found</h2>
            <p className="text-sm text-muted-foreground">Double-check your status link.</p>
          </CardContent>
        ) : (
          <CardContent className="p-8 text-center space-y-4">
            {STATUS_UI[data.status]?.icon}
            <div>
              <h2 className="text-xl font-semibold">{data.businessName}</h2>
              <Badge className={`${STATUS_UI[data.status]?.badge} border-none mt-2`} data-testid="badge-application-status">
                {STATUS_UI[data.status]?.label ?? data.status}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{STATUS_UI[data.status]?.blurb}</p>
            {data.status === 'rejected' && data.rejectionReason && (
              <div className="text-sm bg-muted rounded p-3 text-left">
                <span className="font-medium">Reason: </span>
                <span data-testid="text-rejection-reason">{data.rejectionReason}</span>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Applied {new Date(data.submittedAt).toLocaleDateString()}
            </p>
          </CardContent>
        )}
      </Card>
    </PublicFrame>
  );
}
