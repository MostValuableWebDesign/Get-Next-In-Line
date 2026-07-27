import { useState } from 'react';
import {
  useListPassportChallenges, getListPassportChallengesQueryKey,
  useCreatePassportChallenge, useUpdatePassportChallenge,
  type PassportChallenge,
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
import { Stamp, Plus, Users, Pause, Play, Pencil } from 'lucide-react';

/**
 * Neighborhood Passport — merchant sponsorship console inside the Co-Op hub.
 *
 * Merchants sponsor milestone challenges: a customer who redeems co-op perks
 * at N distinct partner businesses within an M-day rolling window
 * automatically earns the configured reward (bonus perk, sweepstakes entry,
 * or free service upgrade) — issued exactly once per customer and announced
 * by SMS. The console shows completion counts per challenge.
 */

const REWARD_OPTIONS = [
  { value: 'bonus_perk', label: 'Bonus perk' },
  { value: 'sweepstakes_entry', label: 'Sweepstakes entry' },
  { value: 'free_upgrade', label: 'Free service upgrade' },
] as const;

const rewardLabel = (v: string) => REWARD_OPTIONS.find(o => o.value === v)?.label ?? v;

// datetime-local → ISO (null when blank).
const toIso = (v: string): string | null => (v ? new Date(v).toISOString() : null);
const toLocalInput = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

interface ChallengeFormState {
  title: string;
  requiredBusinesses: string;
  windowDays: string;
  rewardType: string;
  rewardDescription: string;
  startsAt: string;
  endsAt: string;
}

const emptyForm: ChallengeFormState = {
  title: '',
  requiredBusinesses: '3',
  windowDays: '30',
  rewardType: 'bonus_perk',
  rewardDescription: '',
  startsAt: '',
  endsAt: '',
};

function ChallengeFormFields({
  form, setForm,
}: {
  form: ChallengeFormState;
  setForm: (f: ChallengeFormState) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="challenge-title">Challenge name</Label>
        <Input
          id="challenge-title"
          value={form.title}
          onChange={e => setForm({ ...form, title: e.target.value })}
          placeholder="Neighborhood Explorer Sprint"
          data-testid="input-challenge-title"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="challenge-businesses">Businesses to visit</Label>
          <Input
            id="challenge-businesses"
            type="number"
            min={2}
            max={50}
            value={form.requiredBusinesses}
            onChange={e => setForm({ ...form, requiredBusinesses: e.target.value })}
            data-testid="input-challenge-businesses"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="challenge-window">Within (days)</Label>
          <Input
            id="challenge-window"
            type="number"
            min={1}
            max={365}
            value={form.windowDays}
            onChange={e => setForm({ ...form, windowDays: e.target.value })}
            data-testid="input-challenge-window"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Reward</Label>
        <Select value={form.rewardType} onValueChange={v => setForm({ ...form, rewardType: v })}>
          <SelectTrigger data-testid="select-challenge-reward-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REWARD_OPTIONS.map(o => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="challenge-reward-desc">Reward details (shown to the customer)</Label>
        <Textarea
          id="challenge-reward-desc"
          value={form.rewardDescription}
          onChange={e => setForm({ ...form, rewardDescription: e.target.value })}
          placeholder="Free deluxe add-on on your next visit"
          rows={2}
          data-testid="input-challenge-reward-description"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="challenge-starts">Starts (optional)</Label>
          <Input
            id="challenge-starts"
            type="datetime-local"
            value={form.startsAt}
            onChange={e => setForm({ ...form, startsAt: e.target.value })}
            data-testid="input-challenge-starts"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="challenge-ends">Ends (optional)</Label>
          <Input
            id="challenge-ends"
            type="datetime-local"
            value={form.endsAt}
            onChange={e => setForm({ ...form, endsAt: e.target.value })}
            data-testid="input-challenge-ends"
          />
        </div>
      </div>
    </div>
  );
}

function formValid(form: ChallengeFormState): boolean {
  const n = Number(form.requiredBusinesses);
  const w = Number(form.windowDays);
  return (
    form.title.trim().length > 0 &&
    form.rewardDescription.trim().length > 0 &&
    Number.isInteger(n) && n >= 2 && n <= 50 &&
    Number.isInteger(w) && w >= 1 && w <= 365
  );
}

export function PassportChallengesSection({ tenantId }: { tenantId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: challenges, isLoading } = useListPassportChallenges({
    query: { queryKey: [...getListPassportChallengesQueryKey(), tenantId] },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListPassportChallengesQueryKey() });

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<PassportChallenge | null>(null);
  const [form, setForm] = useState<ChallengeFormState>(emptyForm);

  const create = useCreatePassportChallenge({
    mutation: {
      onSuccess: () => {
        invalidate();
        setCreateOpen(false);
        setForm(emptyForm);
        toast({ title: 'Challenge created', description: 'Customers can start earning it right away.' });
      },
      onError: (err: unknown) =>
        toast({
          title: 'Could not create challenge',
          description: (err as { message?: string })?.message ?? 'Please check the form and try again.',
          variant: 'destructive',
        }),
    },
  });

  const update = useUpdatePassportChallenge({
    mutation: {
      onSuccess: () => {
        invalidate();
        setEditing(null);
      },
      onError: (err: unknown) =>
        toast({
          title: 'Could not update challenge',
          description: (err as { message?: string })?.message ?? 'Please try again.',
          variant: 'destructive',
        }),
    },
  });

  const submitCreate = () =>
    create.mutate({
      data: {
        title: form.title.trim(),
        requiredBusinesses: Number(form.requiredBusinesses),
        windowDays: Number(form.windowDays),
        rewardType: form.rewardType as 'bonus_perk' | 'sweepstakes_entry' | 'free_upgrade',
        rewardDescription: form.rewardDescription.trim(),
        startsAt: toIso(form.startsAt),
        endsAt: toIso(form.endsAt),
      },
    });

  const submitEdit = () => {
    if (!editing) return;
    update.mutate({
      id: editing.id,
      data: {
        title: form.title.trim(),
        requiredBusinesses: Number(form.requiredBusinesses),
        windowDays: Number(form.windowDays),
        rewardType: form.rewardType as 'bonus_perk' | 'sweepstakes_entry' | 'free_upgrade',
        rewardDescription: form.rewardDescription.trim(),
        startsAt: toIso(form.startsAt),
        endsAt: toIso(form.endsAt),
      },
    });
  };

  const openEdit = (c: PassportChallenge) => {
    setForm({
      title: c.title,
      requiredBusinesses: String(c.requiredBusinesses),
      windowDays: String(c.windowDays),
      rewardType: c.rewardType,
      rewardDescription: c.rewardDescription,
      startsAt: toLocalInput(c.startsAt),
      endsAt: toLocalInput(c.endsAt),
    });
    setEditing(c);
  };

  return (
    <Card data-testid="passport-challenges-section">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Stamp className="w-4 h-4 text-primary" /> Neighborhood Passport Challenges
        </CardTitle>
        <CardDescription>
          Sponsor a milestone: customers who redeem co-op perks at enough different partner
          businesses within your window automatically earn the reward — once per customer, with
          an SMS announcement.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          size="sm"
          onClick={() => { setForm(emptyForm); setCreateOpen(true); }}
          data-testid="button-create-passport-challenge"
        >
          <Plus className="w-4 h-4 mr-1" /> Sponsor a challenge
        </Button>

        {isLoading ? (
          <Skeleton className="h-20 w-full rounded-lg" />
        ) : (challenges ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-passport-challenges">
            No sponsored challenges yet. Create one to reward customers for exploring the
            neighborhood.
          </p>
        ) : (
          <div className="space-y-2" data-testid="list-passport-challenges">
            {(challenges ?? []).map(c => (
              <div
                key={c.id}
                className="rounded-lg border p-3 space-y-1.5"
                data-testid={`card-passport-challenge-${c.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-sm flex items-center gap-2">
                      {c.title}
                      {!c.isActive && <Badge variant="outline">Paused</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {c.requiredBusinesses} businesses in {c.windowDays} days ·{' '}
                      {rewardLabel(c.rewardType)}: {c.rewardDescription}
                    </p>
                    {(c.startsAt || c.endsAt) && (
                      <p className="text-xs text-muted-foreground">
                        {c.startsAt ? `From ${new Date(c.startsAt).toLocaleDateString()}` : ''}
                        {c.startsAt && c.endsAt ? ' ' : ''}
                        {c.endsAt ? `until ${new Date(c.endsAt).toLocaleDateString()}` : ''}
                      </p>
                    )}
                  </div>
                  <Badge
                    variant="secondary"
                    className="shrink-0"
                    data-testid={`badge-challenge-completions-${c.id}`}
                  >
                    <Users className="w-3 h-3 mr-1" /> {c.completionCount} completed
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openEdit(c)}
                    data-testid={`button-edit-challenge-${c.id}`}
                  >
                    <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={update.isPending}
                    onClick={() => update.mutate({ id: c.id, data: { isActive: !c.isActive } })}
                    data-testid={`button-toggle-challenge-${c.id}`}
                  >
                    {c.isActive
                      ? <><Pause className="w-3.5 h-3.5 mr-1" /> Pause</>
                      : <><Play className="w-3.5 h-3.5 mr-1" /> Activate</>}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent data-testid="dialog-create-passport-challenge">
          <DialogHeader>
            <DialogTitle>Sponsor a passport challenge</DialogTitle>
            <DialogDescription>
              Customers who redeem perks at enough different partner businesses within the window
              automatically earn your reward.
            </DialogDescription>
          </DialogHeader>
          <ChallengeFormFields form={form} setForm={setForm} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={submitCreate}
              disabled={!formValid(form) || create.isPending}
              data-testid="button-submit-passport-challenge"
            >
              {create.isPending ? 'Creating…' : 'Create challenge'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editing != null} onOpenChange={open => { if (!open) setEditing(null); }}>
        <DialogContent data-testid="dialog-edit-passport-challenge">
          <DialogHeader>
            <DialogTitle>Edit challenge</DialogTitle>
            <DialogDescription>
              Changes apply to future completions; already-issued rewards keep their original
              details.
            </DialogDescription>
          </DialogHeader>
          <ChallengeFormFields form={form} setForm={setForm} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              onClick={submitEdit}
              disabled={!formValid(form) || update.isPending}
              data-testid="button-save-passport-challenge"
            >
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
