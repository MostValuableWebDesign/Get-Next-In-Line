import React, { useMemo, useState } from 'react';
import { useSearch } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListTipPoolRules, getListTipPoolRulesQueryKey,
  useCreateTipPoolRule, useUpdateTipPoolRule, useDeleteTipPoolRule,
  useListTipPoolPartnerStaff, getListTipPoolPartnerStaffQueryKey,
  useListGratuityLedger, getListGratuityLedgerQueryKey,
  useGetGratuityShiftReport, getGetGratuityShiftReportQueryKey,
  useListCoopPartnerships, getListCoopPartnershipsQueryKey,
  useListSosStaff,
} from '@workspace/api-client-react';
import { parseTenantParam } from '@/lib/sos-tenant';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { HandCoins, Plus, Trash2, Users } from 'lucide-react';

/**
 * Tip Pooling — merchant view for the Co-Op Automated Tip-Pooling &
 * Gratuity Splitter. Rules editor (percentage / equal / role-weighted, per
 * active partnership or for the business's own group events), distribution
 * history from the immutable gratuity ledger, and an end-of-shift report.
 * Ledger accounting only — no money movement.
 */
export function TipPoolingContent() {
  const searchString = useSearch();
  const tenantId = parseTenantParam(searchString);

  if (tenantId == null) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-10 text-center text-muted-foreground" data-testid="text-tips-pick-business">
          Select a specific business above to manage tip pooling.
        </CardContent>
      </Card>
    );
  }
  return <TipPoolingInner key={tenantId} tenantId={tenantId} />;
}

const METHOD_LABEL: Record<string, string> = {
  percentage: 'Percentage',
  equal: 'Equal split',
  role_weighted: 'Role-weighted',
};

function TipPoolingInner({ tenantId }: { tenantId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: rules } = useListTipPoolRules({
    query: { queryKey: getListTipPoolRulesQueryKey() },
  });
  const { data: ledger } = useListGratuityLedger(undefined, {
    query: { queryKey: getListGratuityLedgerQueryKey(undefined) },
  });
  const today = new Date().toISOString().slice(0, 10);
  const [reportDate, setReportDate] = useState(today);
  const { data: shiftReport } = useGetGratuityShiftReport(
    { date: reportDate },
    { query: { queryKey: getGetGratuityShiftReportQueryKey({ date: reportDate }) } },
  );
  const [editorOpen, setEditorOpen] = useState(false);

  const deleteRule = useDeleteTipPoolRule();
  const updateRule = useUpdateTipPoolRule();
  const invalidateRules = () =>
    queryClient.invalidateQueries({ queryKey: getListTipPoolRulesQueryKey() });

  return (
    <div className="space-y-6">
      {/* Rules */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <HandCoins className="w-4 h-4" /> Tip-Splitting Rules
          </CardTitle>
          <Button size="sm" onClick={() => setEditorOpen(true)} data-testid="button-new-tip-rule">
            <Plus className="w-4 h-4 mr-1" /> New Rule
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Gratuities on shared co-op visits (and your own group events) are split automatically at
            checkout by these rules and itemized per staff member, separate from commission. Without a
            rule, the full tip goes to the servicing staff member. Cross-business splits only apply
            while the partnership is accepted and active.
          </p>
          {(rules ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-tip-rules">
              No tip-splitting rules yet.
            </p>
          ) : (
            (rules ?? []).map(rule => (
              <div key={rule.id} className="border rounded-md p-3 space-y-2" data-testid={`tip-rule-${rule.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline">{METHOD_LABEL[rule.splitMethod] ?? rule.splitMethod}</Badge>
                    <Badge variant="secondary">
                      {rule.scope === 'partnership'
                        ? `Partnership${rule.partnerTenantName ? ` · ${rule.partnerTenantName}` : ''}`
                        : 'Group events'}
                    </Badge>
                    {!rule.isActive && <Badge variant="destructive">Inactive</Badge>}
                    {rule.tenantId !== tenantId && (
                      <Badge variant="outline" className="text-muted-foreground">Managed by partner</Badge>
                    )}
                  </div>
                  {rule.tenantId === tenantId && (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() =>
                          updateRule.mutate(
                            { id: rule.id, data: { isActive: !rule.isActive } },
                            { onSuccess: invalidateRules },
                          )
                        }
                      >
                        {rule.isActive ? 'Deactivate' : 'Activate'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-destructive"
                        data-testid={`button-delete-tip-rule-${rule.id}`}
                        onClick={() =>
                          deleteRule.mutate(
                            { id: rule.id },
                            {
                              onSuccess: () => {
                                invalidateRules();
                                toast({ title: 'Rule deleted', description: 'Past distributions keep their records.' });
                              },
                            },
                          )
                        }
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {rule.participants.map(p => (
                    <span key={p.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs bg-muted/30">
                      <Users className="w-3 h-3" />
                      {p.staffName}
                      {p.tenantName && p.tenantId !== tenantId ? ` (${p.tenantName})` : ''}
                      {rule.splitMethod === 'percentage' && p.percent != null ? ` — ${p.percent}%` : ''}
                      {rule.splitMethod === 'role_weighted' && p.weight != null ? ` — ×${p.weight}` : ''}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* End-of-shift report */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">End-of-Shift Gratuity Report</CardTitle>
          <Input
            type="date"
            className="w-40 h-8"
            value={reportDate}
            onChange={e => setReportDate(e.target.value)}
            data-testid="input-shift-report-date"
          />
        </CardHeader>
        <CardContent>
          {(shiftReport ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-shift-tips">
              No gratuities recorded for this day.
            </p>
          ) : (
            <table className="w-full text-sm" data-testid="table-shift-report">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-1.5">Staff</th>
                  <th className="py-1.5 text-right">Own business</th>
                  <th className="py-1.5 text-right">From partners</th>
                  <th className="py-1.5 text-right">Total</th>
                  <th className="py-1.5 text-right">Tips</th>
                </tr>
              </thead>
              <tbody>
                {(shiftReport ?? []).map(r => (
                  <tr key={r.staffId} className="border-b last:border-0">
                    <td className="py-1.5 font-medium">{r.staffName}</td>
                    <td className="py-1.5 text-right">${r.ownTips.toFixed(2)}</td>
                    <td className="py-1.5 text-right">${r.partnerTips.toFixed(2)}</td>
                    <td className="py-1.5 text-right font-semibold">${r.totalTips.toFixed(2)}</td>
                    <td className="py-1.5 text-right text-muted-foreground">{r.entries}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Distribution history */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Distribution History</CardTitle>
        </CardHeader>
        <CardContent>
          {(ledger ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-tip-history">
              No tip distributions yet.
            </p>
          ) : (
            <table className="w-full text-sm" data-testid="table-tip-history">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-1.5">When</th>
                  <th className="py-1.5">Staff</th>
                  <th className="py-1.5">Service</th>
                  <th className="py-1.5">Origin</th>
                  <th className="py-1.5 text-right">Tip</th>
                  <th className="py-1.5 text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {(ledger ?? []).map(e => (
                  <tr key={e.id} className="border-b last:border-0" data-testid={`ledger-entry-${e.id}`}>
                    <td className="py-1.5 text-muted-foreground whitespace-nowrap">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td className="py-1.5 font-medium">{e.recipientStaffName}</td>
                    <td className="py-1.5">{e.serviceType}</td>
                    <td className="py-1.5">
                      <Badge variant={e.origin === 'partner' ? 'secondary' : 'outline'}>
                        {e.origin === 'partner' ? (e.sourceTenantName ?? 'Partner') : 'Own business'}
                      </Badge>
                    </td>
                    <td className="py-1.5 text-right text-muted-foreground">${e.grossTip.toFixed(2)}</td>
                    <td className="py-1.5 text-right font-semibold">${e.allocatedShare.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <RuleEditorDialog
        tenantId={tenantId}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        onSaved={invalidateRules}
      />
    </div>
  );
}

type DraftParticipant = { tenantId: number; staffId: string; role: string; percent: string; weight: string };

function RuleEditorDialog({
  tenantId, open, onOpenChange, onSaved,
}: {
  tenantId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const createRule = useCreateTipPoolRule();
  const [scope, setScope] = useState<'partnership' | 'group_event'>('group_event');
  const [partnershipId, setPartnershipId] = useState<string>('');
  const [method, setMethod] = useState<'percentage' | 'equal' | 'role_weighted'>('equal');
  const [participants, setParticipants] = useState<DraftParticipant[]>([]);

  const { data: partnerships } = useListCoopPartnerships(
    { tenantId },
    { query: { queryKey: getListCoopPartnershipsQueryKey({ tenantId }), enabled: open } },
  );
  const activePartnerships = (partnerships ?? []).filter(
    p => p.status === 'accepted' && p.isActive && p.bannedAt == null,
  );
  const { data: ownStaff } = useListSosStaff();
  const pid = partnershipId ? Number(partnershipId) : null;
  const { data: partnerStaff } = useListTipPoolPartnerStaff(
    { partnershipId: pid ?? 0 },
    {
      query: {
        queryKey: getListTipPoolPartnerStaffQueryKey({ partnershipId: pid ?? 0 }),
        enabled: open && scope === 'partnership' && pid != null,
      },
    },
  );
  const selectedPartnership = activePartnerships.find(p => p.id === pid);
  const partnerTenantId = selectedPartnership
    ? (selectedPartnership.hostTenantId === tenantId
        ? selectedPartnership.partnerTenantId
        : selectedPartnership.hostTenantId)
    : null;

  // Staff options: own active staff always; partner staff when a partnership
  // is selected (cross-business rules split across both sides).
  const staffOptions = useMemo(() => {
    const own = (ownStaff ?? []).filter(s => s.isActive).map(s => ({
      key: `${tenantId}:${s.id}`, tenantId, staffId: s.id, label: s.name,
    }));
    const partner =
      scope === 'partnership' && partnerTenantId != null
        ? (partnerStaff ?? []).map(s => ({
            key: `${partnerTenantId}:${s.id}`,
            tenantId: partnerTenantId,
            staffId: s.id,
            label: `${s.name} (partner)`,
          }))
        : [];
    return [...own, ...partner];
  }, [ownStaff, partnerStaff, scope, partnerTenantId, tenantId]);

  const addParticipant = (key: string) => {
    const opt = staffOptions.find(o => o.key === key);
    if (!opt) return;
    if (participants.some(p => p.tenantId === opt.tenantId && p.staffId === String(opt.staffId))) return;
    setParticipants(prev => [
      ...prev,
      { tenantId: opt.tenantId, staffId: String(opt.staffId), role: '', percent: '', weight: '' },
    ]);
  };

  const percentTotal = participants.reduce((a, p) => a + (parseInt(p.percent) || 0), 0);

  const reset = () => {
    setScope('group_event');
    setPartnershipId('');
    setMethod('equal');
    setParticipants([]);
  };

  const save = () => {
    createRule.mutate(
      {
        data: {
          scope,
          ...(scope === 'partnership' && pid != null ? { partnershipId: pid } : {}),
          splitMethod: method,
          participants: participants.map(p => ({
            tenantId: p.tenantId,
            staffId: Number(p.staffId),
            ...(p.role ? { role: p.role } : {}),
            ...(method === 'percentage' && p.percent ? { percent: parseInt(p.percent) } : {}),
            ...(method === 'role_weighted' && p.weight ? { weight: parseInt(p.weight) } : {}),
          })),
        },
      },
      {
        onSuccess: () => {
          onSaved();
          onOpenChange(false);
          reset();
          toast({ title: 'Tip rule created' });
        },
        onError: (err: any) => {
          toast({
            title: 'Could not create rule',
            description: err?.data?.message ?? err?.message ?? 'Check the split terms and try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  const staffName = (p: DraftParticipant) =>
    staffOptions.find(o => o.tenantId === p.tenantId && String(o.staffId) === p.staffId)?.label ?? `Staff ${p.staffId}`;

  return (
    <Dialog open={open} onOpenChange={o => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="max-w-lg" data-testid="dialog-tip-rule-editor">
        <DialogHeader>
          <DialogTitle>New Tip-Splitting Rule</DialogTitle>
          <DialogDescription>
            Splits must total 100%. Cross-business rules require an accepted, active partnership.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Applies To</Label>
              <Select value={scope} onValueChange={v => { setScope(v as any); setParticipants([]); }}>
                <SelectTrigger data-testid="select-tip-rule-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="group_event">My group events</SelectItem>
                  <SelectItem value="partnership">Co-op partnership</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Split Method</Label>
              <Select value={method} onValueChange={v => setMethod(v as any)}>
                <SelectTrigger data-testid="select-tip-rule-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="equal">Equal split</SelectItem>
                  <SelectItem value="percentage">Percentage</SelectItem>
                  <SelectItem value="role_weighted">Role-weighted</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {scope === 'partnership' && (
            <div className="space-y-1.5">
              <Label>Partnership</Label>
              <Select value={partnershipId} onValueChange={v => { setPartnershipId(v); setParticipants([]); }}>
                <SelectTrigger data-testid="select-tip-rule-partnership">
                  <SelectValue placeholder="Pick an active partnership..." />
                </SelectTrigger>
                <SelectContent>
                  {activePartnerships.map(p => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.hostTenantId === tenantId ? p.partnerTenantName : p.hostTenantName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activePartnerships.length === 0 && (
                <p className="text-xs text-muted-foreground">No accepted, active partnerships available.</p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Add Recipient</Label>
            <Select value="" onValueChange={addParticipant}>
              <SelectTrigger data-testid="select-tip-rule-add-staff">
                <SelectValue placeholder="Add a staff member..." />
              </SelectTrigger>
              <SelectContent>
                {staffOptions.map(o => (
                  <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {participants.length > 0 && (
            <div className="space-y-2">
              {participants.map((p, i) => (
                <div key={`${p.tenantId}:${p.staffId}`} className="flex items-center gap-2">
                  <span className="text-sm flex-1 truncate">{staffName(p)}</span>
                  {method === 'percentage' && (
                    <div className="relative w-24">
                      <Input
                        type="number"
                        placeholder="%"
                        value={p.percent}
                        onChange={e =>
                          setParticipants(prev => prev.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))
                        }
                        data-testid={`input-tip-percent-${i}`}
                      />
                    </div>
                  )}
                  {method === 'role_weighted' && (
                    <Input
                      type="number"
                      placeholder="Weight"
                      className="w-24"
                      value={p.weight}
                      onChange={e =>
                        setParticipants(prev => prev.map((x, j) => (j === i ? { ...x, weight: e.target.value } : x)))
                      }
                      data-testid={`input-tip-weight-${i}`}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0 text-destructive"
                    onClick={() => setParticipants(prev => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
              {method === 'percentage' && (
                <p className={`text-xs ${percentTotal === 100 ? 'text-muted-foreground' : 'text-destructive'}`} data-testid="text-percent-total">
                  Total: {percentTotal}% {percentTotal !== 100 && '(must equal 100%)'}
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={save}
            disabled={
              createRule.isPending ||
              participants.length === 0 ||
              (scope === 'partnership' && pid == null) ||
              (method === 'percentage' && percentTotal !== 100)
            }
            data-testid="button-save-tip-rule"
          >
            Create Rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
