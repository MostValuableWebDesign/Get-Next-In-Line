import React, { useMemo, useState } from 'react';
import {
  useListSosStaff, useCreateSosStaffMember, useUpdateSosStaffMember,
  useGetSosStaffEarnings, getListSosStaffQueryKey, getGetSosStaffEarningsQueryKey,
  useGetSosGratuityConfig, useUpdateSosGratuityConfig, getGetSosGratuityConfigQueryKey,
  type SosStaffMember,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Plus, Pencil, Users, DollarSign, Percent, Home, HandCoins } from 'lucide-react';

type CompType = 'commission' | 'flat_fee' | 'booth_rent';

const COMP_LABELS: Record<CompType, string> = {
  commission: 'Commission split',
  flat_fee: 'Flat fee',
  booth_rent: 'Booth rent',
};

const COMP_ICONS: Record<CompType, React.ComponentType<{ className?: string }>> = {
  commission: Percent,
  flat_fee: DollarSign,
  booth_rent: Home,
};

function compSummary(s: SosStaffMember): string {
  if (s.compensationType === 'commission') return `${s.commissionPercent}% commission`;
  const cadence = s.cadence === 'weekly' ? 'week' : 'month';
  return s.compensationType === 'flat_fee'
    ? `$${(s.amount ?? 0).toFixed(2)} fee / ${cadence}`
    : `$${(s.amount ?? 0).toFixed(2)} rent / ${cadence}`;
}

// ── period selection for the earnings summary ────────────────────────────────

const PERIODS = [
  { value: 'this_week', label: 'This week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
] as const;
type PeriodKey = (typeof PERIODS)[number]['value'];

function periodRange(key: PeriodKey): { from: Date; to: Date } {
  const now = new Date();
  if (key === 'this_week') {
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - from.getDay()); // Sunday start
    const to = new Date(from);
    to.setDate(to.getDate() + 7);
    return { from, to };
  }
  if (key === 'this_month') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { from, to };
  }
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from, to };
}

// ── main content ─────────────────────────────────────────────────────────────

export function StaffContent() {
  const { data: staff } = useListSosStaff();
  const [editing, setEditing] = useState<SosStaffMember | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [period, setPeriod] = useState<PeriodKey>('this_month');

  const range = useMemo(() => periodRange(period), [period]);
  const params = { from: range.from.toISOString(), to: range.to.toISOString() };
  const { data: earnings } = useGetSosStaffEarnings(params, {
    query: { queryKey: getGetSosStaffEarningsQueryKey(params) },
  });

  const active = staff?.filter(s => s.isActive) ?? [];
  const inactive = staff?.filter(s => !s.isActive) ?? [];

  return (
    <div className="grid lg:grid-cols-2 gap-6 items-start">
      {/* Team roster */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-primary" /> Team
          </CardTitle>
          <Button
            size="sm"
            data-testid="btn-add-staff"
            onClick={() => { setEditing(null); setDialogOpen(true); }}
          >
            <Plus className="mr-2 h-3.5 w-3.5" /> Add Staff
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {(staff?.length ?? 0) === 0 && (
            <div className="text-sm text-muted-foreground text-center py-8">
              No staff members yet. Add your first team member to start tracking earnings.
            </div>
          )}
          {[...active, ...inactive].map(s => (
            <StaffRow key={s.id} member={s} onEdit={() => { setEditing(s); setDialogOpen(true); }} />
          ))}
        </CardContent>
      </Card>

      {/* Earnings summary */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <DollarSign className="h-4 w-4 text-primary" /> Earnings Summary
          </CardTitle>
          <Select value={period} onValueChange={(v) => setPeriod(v as PeriodKey)}>
            <SelectTrigger className="w-[150px] h-8 text-xs" data-testid="select-earnings-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="space-y-3">
          {(earnings?.length ?? 0) === 0 && (
            <div className="text-sm text-muted-foreground text-center py-8">
              Nothing to summarize yet.
            </div>
          )}
          {earnings?.map(row => (
            <div
              key={row.staffId}
              className="border rounded-md p-3 flex justify-between items-center gap-3"
              data-testid={`earnings-row-${row.staffId}`}
            >
              <div>
                <div className="font-medium text-sm flex items-center gap-2">
                  {row.name}
                  {!row.isActive && <Badge variant="secondary" className="text-[10px]">Inactive</Badge>}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {row.compensationType === 'commission'
                    ? `${row.attributedVisits} visit${row.attributedVisits === 1 ? '' : 's'} • $${row.attributedRevenue.toFixed(2)} attributed revenue`
                    : COMP_LABELS[row.compensationType as CompType]}
                </div>
              </div>
              <div className="text-right shrink-0">
                {row.compensationType === 'commission' ? (
                  <>
                    <div className="font-semibold">${(row.commissionEarned ?? 0).toFixed(2)}</div>
                    <div className="text-[11px] text-muted-foreground">{row.commissionPercent}% split earned</div>
                  </>
                ) : row.compensationType === 'flat_fee' ? (
                  <>
                    <div className="font-semibold">${(row.amountDue ?? 0).toFixed(2)}</div>
                    <div className="text-[11px] text-muted-foreground">fee owed to staff</div>
                  </>
                ) : (
                  <>
                    <div className="font-semibold">${(row.amountDue ?? 0).toFixed(2)}</div>
                    <div className="text-[11px] text-muted-foreground">rent due from staff</div>
                  </>
                )}
                {/* Pooled tips — itemized separately, never part of commission */}
                <div className="text-[11px] mt-0.5" data-testid={`tips-earned-${row.staffId}`}>
                  <span className="font-medium text-emerald-700">+${(row.tipsEarned ?? 0).toFixed(2)}</span>
                  <span className="text-muted-foreground"> tips</span>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Tip pooling rules — default split rule + per-staff shares/weights */}
      <div className="lg:col-span-2">
        <TipPoolingCard />
      </div>

      <StaffDialog
        key={editing?.id ?? 'new'}
        member={editing}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}

// ── tip pooling rules ────────────────────────────────────────────────────────

const TIP_RULES = [
  { value: 'equal', label: 'Equal split — everyone in the pool gets the same share' },
  { value: 'percentage', label: 'Percentage — split by each member\'s tip %' },
  { value: 'role_weighted', label: 'Role-weighted — split by role weight (e.g. senior 2×)' },
] as const;

function TipPoolingCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: config } = useGetSosGratuityConfig();
  const update = useUpdateSosGratuityConfig();
  // Local edits keyed by staffId; empty string = unset (NULL).
  const [edits, setEdits] = useState<Record<number, { tipPercent?: string; tipRoleWeight?: string }>>({});

  const save = (body: Parameters<typeof update.mutate>[0]['data']) => {
    update.mutate(
      { data: body },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetSosGratuityConfigQueryKey() });
          setEdits({});
          toast({ title: 'Tip pooling settings saved' });
        },
        onError: (err: any) => {
          toast({
            title: 'Could not save tip settings',
            description: err?.response?.data?.message || err?.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const saveShares = () => {
    const staffShares = Object.entries(edits).map(([staffId, e]) => ({
      staffId: Number(staffId),
      ...(e.tipPercent !== undefined
        ? { tipPercent: e.tipPercent === '' ? null : Math.round(Number(e.tipPercent)) }
        : {}),
      ...(e.tipRoleWeight !== undefined
        ? { tipRoleWeight: e.tipRoleWeight === '' ? null : Math.round(Number(e.tipRoleWeight)) }
        : {}),
    }));
    if (staffShares.length > 0) save({ staffShares });
  };

  const staff = config?.staff ?? [];

  return (
    <Card data-testid="card-tip-pooling">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <HandCoins className="h-4 w-4 text-primary" /> Tip Pooling
        </CardTitle>
        <Select
          value={config?.tipSplitRule ?? 'equal'}
          onValueChange={(v) => save({ tipSplitRule: v as any })}
        >
          <SelectTrigger className="w-[340px] h-8 text-xs" data-testid="select-tip-split-rule">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIP_RULES.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Tips entered at checkout are pooled and split across active staff by this rule —
          on shared co-op visits, across both businesses' staff. Every allocation lands on the
          gratuity ledger, separate from commissions and service revenue.
        </p>
        {staff.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-4">No staff members yet.</div>
        ) : (
          <div className="space-y-2">
            {staff.map(s => {
              const e = edits[s.staffId] ?? {};
              return (
                <div key={s.staffId} className="flex items-center gap-3 border rounded-md p-2.5" data-testid={`tip-share-row-${s.staffId}`}>
                  <div className="flex-1 text-sm font-medium">
                    {s.name}
                    {!s.isActive && <Badge variant="secondary" className="ml-2 text-[10px]">Inactive</Badge>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs text-muted-foreground">Tip %</Label>
                    <Input
                      type="number" min="0" max="100"
                      className="w-20 h-8"
                      value={e.tipPercent ?? (s.tipPercent?.toString() ?? '')}
                      onChange={ev => setEdits(prev => ({ ...prev, [s.staffId]: { ...prev[s.staffId], tipPercent: ev.target.value } }))}
                      data-testid={`input-tip-percent-${s.staffId}`}
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs text-muted-foreground">Weight</Label>
                    <Input
                      type="number" min="0"
                      className="w-16 h-8"
                      placeholder="1"
                      value={e.tipRoleWeight ?? (s.tipRoleWeight?.toString() ?? '')}
                      onChange={ev => setEdits(prev => ({ ...prev, [s.staffId]: { ...prev[s.staffId], tipRoleWeight: ev.target.value } }))}
                      data-testid={`input-tip-weight-${s.staffId}`}
                    />
                  </div>
                </div>
              );
            })}
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={saveShares}
                disabled={update.isPending || Object.keys(edits).length === 0}
                data-testid="btn-save-tip-shares"
              >
                Save Shares
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StaffRow({ member, onEdit }: { member: SosStaffMember; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateSosStaffMember();
  const Icon = COMP_ICONS[member.compensationType as CompType] ?? Percent;

  const toggleActive = () => {
    update.mutate(
      { id: member.id, data: { isActive: !member.isActive } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosStaffQueryKey() });
          toast({
            title: member.isActive ? 'Staff member deactivated' : 'Staff member reactivated',
            description: member.isActive
              ? `${member.name} is hidden from checkout attribution but keeps their history.`
              : `${member.name} can be attributed on checkouts again.`,
          });
        },
        onError: (err: any) => {
          toast({ title: 'Update failed', description: err?.response?.data?.message || err?.message, variant: 'destructive' });
        },
      },
    );
  };

  return (
    <div
      className={`border rounded-md p-3 flex justify-between items-center gap-3 ${member.isActive ? '' : 'opacity-60'}`}
      data-testid={`staff-row-${member.id}`}
    >
      <div>
        <div className="font-medium text-sm flex items-center gap-2">
          {member.name}
          {!member.isActive && <Badge variant="secondary" className="text-[10px]">Inactive</Badge>}
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
          <Icon className="h-3 w-3" /> {compSummary(member)}
          {(member.phone || member.email) && <span>• {member.phone || member.email}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit} data-testid={`btn-edit-staff-${member.id}`}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={toggleActive}
          disabled={update.isPending}
          data-testid={`btn-toggle-staff-${member.id}`}
        >
          {member.isActive ? 'Deactivate' : 'Reactivate'}
        </Button>
      </div>
    </div>
  );
}

// ── add / edit dialog ────────────────────────────────────────────────────────

function StaffDialog({
  member, open, onOpenChange,
}: {
  member: SosStaffMember | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateSosStaffMember();
  const update = useUpdateSosStaffMember();

  const [name, setName] = useState(member?.name ?? '');
  const [phone, setPhone] = useState(member?.phone ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [compType, setCompType] = useState<CompType>((member?.compensationType as CompType) ?? 'commission');
  const [commissionPercent, setCommissionPercent] = useState(member?.commissionPercent?.toString() ?? '');
  const [amount, setAmount] = useState(member?.amount?.toString() ?? '');
  const [cadence, setCadence] = useState<'weekly' | 'monthly'>((member?.cadence as 'weekly' | 'monthly') ?? 'monthly');

  const isCommission = compType === 'commission';
  const valid =
    name.trim().length > 0 &&
    (isCommission
      ? commissionPercent !== '' && Number(commissionPercent) >= 0 && Number(commissionPercent) <= 100
      : amount !== '' && Number(amount) >= 0);

  const done = (title: string) => {
    queryClient.invalidateQueries({ queryKey: getListSosStaffQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetSosStaffEarningsQueryKey() });
    toast({ title });
    onOpenChange(false);
  };
  const fail = (err: any) => {
    toast({
      title: 'Could not save staff member',
      description: err?.response?.data?.message || err?.message,
      variant: 'destructive',
    });
  };

  const handleSave = () => {
    const terms = isCommission
      ? { commissionPercent: Math.round(Number(commissionPercent)) }
      : { amount: Number(amount), cadence };
    const contact = {
      ...(phone.trim() ? { phone: phone.trim() } : {}),
      ...(email.trim() ? { email: email.trim() } : {}),
    };
    if (member) {
      update.mutate(
        { id: member.id, data: { name: name.trim(), ...contact, compensationType: compType, ...terms } },
        { onSuccess: () => done('Staff member updated'), onError: fail },
      );
    } else {
      create.mutate(
        { data: { name: name.trim(), ...contact, compensationType: compType, ...terms } },
        { onSuccess: () => done('Staff member added'), onError: fail },
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{member ? `Edit ${member.name}` : 'Add Staff Member'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Jamie Rivera" data-testid="input-staff-name" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Phone (optional)</Label>
              <Input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 010-2233" />
            </div>
            <div className="space-y-2">
              <Label>Email (optional)</Label>
              <Input value={email} onChange={e => setEmail(e.target.value)} placeholder="jamie@example.com" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Compensation Model</Label>
            <Select value={compType} onValueChange={(v) => setCompType(v as CompType)}>
              <SelectTrigger data-testid="select-compensation-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="commission">Commission split — % of service revenue</SelectItem>
                <SelectItem value="flat_fee">Flat fee — fixed pay per week/month</SelectItem>
                <SelectItem value="booth_rent">Booth rent — staff pays rent per week/month</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {isCommission ? (
            <div className="space-y-2">
              <Label>Commission %</Label>
              <div className="relative">
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={commissionPercent}
                  onChange={e => setCommissionPercent(e.target.value)}
                  placeholder="50"
                  data-testid="input-commission-percent"
                />
                <span className="absolute right-3 top-2.5 text-muted-foreground text-sm">%</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Their share of the revenue on visits attributed to them at checkout.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>{compType === 'flat_fee' ? 'Fee Amount' : 'Rent Amount'}</Label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                  <Input
                    type="number"
                    min="0"
                    className="pl-7"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    placeholder="0.00"
                    data-testid="input-comp-amount"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Billing Cadence</Label>
                <Select value={cadence} onValueChange={(v) => setCadence(v as 'weekly' | 'monthly')}>
                  <SelectTrigger data-testid="select-comp-cadence">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={handleSave}
            disabled={!valid || create.isPending || update.isPending}
            data-testid="btn-save-staff"
          >
            {member ? 'Save Changes' : 'Add Staff Member'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
