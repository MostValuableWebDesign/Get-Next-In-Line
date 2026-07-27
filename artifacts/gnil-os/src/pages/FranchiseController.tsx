import { useState } from 'react';
import {
  useListFranchiseOrgs,
  getListFranchiseOrgsQueryKey,
  useCreateFranchiseOrg,
  useGetFranchiseOrg,
  getGetFranchiseOrgQueryKey,
  useUpdateFranchiseOrg,
  useCreateFranchiseRegion,
  useAttachFranchiseStorefront,
  useUpdateFranchiseStorefront,
  useDetachFranchiseStorefront,
  useListFranchiseRoles,
  getListFranchiseRolesQueryKey,
  useAssignFranchiseRole,
  useRemoveFranchiseRole,
  useListFranchiseTemplates,
  getListFranchiseTemplatesQueryKey,
  useCreateFranchiseTemplate,
  useUpdateFranchiseTemplate,
  useListFranchiseRequests,
  getListFranchiseRequestsQueryKey,
  useCreateFranchiseRequest,
  useDecideFranchiseRequest,
  useGetFranchiseRollup,
  getGetFranchiseRollupQueryKey,
  useListTenants,
  type FranchiseOrgDetail,
  type FranchiseTemplate,
  type FranchisePartnershipRequest,
  type FranchiseRollup,
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
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { formatCurrency } from '@/lib/format';
import {
  Building2, Check, Crown, Landmark, MapPin, Plus, ShieldCheck, Trash2, X,
} from 'lucide-react';

/**
 * Multi-Location & Enterprise Franchise Co-Op Controller.
 *
 * One master dashboard for enterprise owners governing co-op partnerships
 * across every branch: hierarchy management (HQ → region → storefront),
 * org role assignment, global perk template designer with per-location
 * deployment status, the local-autonomy policy + approval queue, and the
 * consolidated executive roll-up report. Every surface is gated by the
 * caller's org role, mirroring the API's own enforcement.
 */

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  regional_manager: 'Regional Manager',
  storefront_operator: 'Storefront Operator',
};

const POLICY_LABELS: Record<string, string> = {
  allowed: 'Allowed — storefronts may partner locally on their own',
  approval_required: 'Approval required — requests queue for a manager',
  locked: 'Locked — HQ only',
};

function errMessage(err: unknown): string {
  const e = err as { data?: { message?: string }; message?: string };
  return e?.data?.message ?? e?.message ?? 'Something went wrong';
}

export default function FranchiseController() {
  const [selectedOrgId, setSelectedOrgId] = useState<number | null>(null);
  const [newOrgName, setNewOrgName] = useState('');
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const orgsQuery = useListFranchiseOrgs();
  const orgs = orgsQuery.data ?? [];
  const activeOrgId = selectedOrgId ?? orgs[0]?.id ?? null;

  const createOrg = useCreateFranchiseOrg({
    mutation: {
      onSuccess: (org) => {
        queryClient.invalidateQueries({ queryKey: getListFranchiseOrgsQueryKey() });
        setSelectedOrgId(org.id);
        setNewOrgName('');
        toast({ title: 'Organization created' });
      },
      onError: (e) => toast({ title: 'Could not create organization', description: errMessage(e), variant: 'destructive' }),
    },
  });

  if (orgsQuery.isLoading) {
    return <Skeleton className="h-64 w-full" data-testid="franchise-loading" />;
  }

  return (
    <div className="space-y-4" data-testid="franchise-controller">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Landmark className="h-5 w-5" /> Franchise Co-Op Controller
          </CardTitle>
          <CardDescription>
            Govern co-op partnerships across every branch: hierarchy, global perk templates,
            local-autonomy policy, and consolidated roll-up reporting.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label>Organization</Label>
            <Select
              value={activeOrgId != null ? String(activeOrgId) : undefined}
              onValueChange={(v) => setSelectedOrgId(Number(v))}
            >
              <SelectTrigger className="w-64" data-testid="select-franchise-org">
                <SelectValue placeholder="Select an organization" />
              </SelectTrigger>
              <SelectContent>
                {orgs.map((o) => (
                  <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="new-org-name">New organization</Label>
              <Input
                id="new-org-name"
                data-testid="input-new-org-name"
                placeholder="e.g. Shear Empire Holdings"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                className="w-64"
              />
            </div>
            <Button
              data-testid="button-create-org"
              disabled={newOrgName.trim() === '' || createOrg.isPending}
              onClick={() => createOrg.mutate({ data: { name: newOrgName.trim() } })}
            >
              <Plus className="h-4 w-4 mr-1" /> Create
            </Button>
          </div>
        </CardContent>
      </Card>

      {activeOrgId == null ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground" data-testid="franchise-empty">
            No organizations yet. Create one above to start grouping locations.
          </CardContent>
        </Card>
      ) : (
        <OrgWorkspace key={activeOrgId} orgId={activeOrgId} />
      )}
    </div>
  );
}

function OrgWorkspace({ orgId }: { orgId: number }) {
  const orgQuery = useGetFranchiseOrg(orgId);
  if (orgQuery.isLoading) return <Skeleton className="h-96 w-full" />;
  if (!orgQuery.data) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground">
          You have no role in this organization.
        </CardContent>
      </Card>
    );
  }
  const org = orgQuery.data;
  const isSuperAdmin = org.myRole === 'super_admin';
  const canApprove = org.myRole !== 'storefront_operator';
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" data-testid="badge-my-role">
          <Crown className="h-3 w-3 mr-1" /> {ROLE_LABELS[org.myRole] ?? org.myRole}
        </Badge>
        <Badge variant="outline" data-testid="badge-autonomy-policy">
          {POLICY_LABELS[org.autonomyPolicy]?.split(' — ')[0] ?? org.autonomyPolicy}
        </Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <HierarchyCard org={org} isSuperAdmin={isSuperAdmin} />
        {isSuperAdmin && <RolesCard org={org} />}
        <TemplatesCard org={org} isSuperAdmin={isSuperAdmin} />
        <ApprovalsCard org={org} canApprove={canApprove} />
      </div>
      <RollupCard orgId={org.id} />
    </div>
  );
}

// ── Hierarchy management ─────────────────────────────────────────────────────

function HierarchyCard({ org, isSuperAdmin }: { org: FranchiseOrgDetail; isSuperAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [regionName, setRegionName] = useState('');
  const [attachTenantId, setAttachTenantId] = useState('');
  const [attachRegionId, setAttachRegionId] = useState('none');
  const tenantsQuery = useListTenants();
  const attachedIds = new Set(org.storefronts.map((s) => s.tenantId));
  const attachable = (tenantsQuery.data ?? []).filter((t) => !attachedIds.has(t.id));

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetFranchiseOrgQueryKey(org.id) });
    queryClient.invalidateQueries({ queryKey: getListFranchiseTemplatesQueryKey(org.id) });
    queryClient.invalidateQueries({ queryKey: getGetFranchiseRollupQueryKey(org.id) });
  };
  const onError = (e: unknown) =>
    toast({ title: 'Hierarchy update failed', description: errMessage(e), variant: 'destructive' });

  const createRegion = useCreateFranchiseRegion({
    mutation: { onSuccess: () => { invalidate(); setRegionName(''); }, onError },
  });
  const attach = useAttachFranchiseStorefront({
    mutation: { onSuccess: () => { invalidate(); setAttachTenantId(''); }, onError },
  });
  const move = useUpdateFranchiseStorefront({ mutation: { onSuccess: invalidate, onError } });
  const detach = useDetachFranchiseStorefront({ mutation: { onSuccess: invalidate, onError } });
  const updateOrg = useUpdateFranchiseOrg({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: 'Autonomy policy updated' });
      },
      onError,
    },
  });

  return (
    <Card data-testid="card-hierarchy">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="h-4 w-4" /> Hierarchy — {org.name}
        </CardTitle>
        <CardDescription>Regions and attached storefront locations.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isSuperAdmin && (
          <div className="space-y-1">
            <Label>Local-autonomy policy</Label>
            <Select
              value={org.autonomyPolicy}
              onValueChange={(v) =>
                updateOrg.mutate({ orgId: org.id, data: { autonomyPolicy: v as never } })
              }
            >
              <SelectTrigger data-testid="select-autonomy-policy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(POLICY_LABELS).map(([v, label]) => (
                  <SelectItem key={v} value={v}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="space-y-2">
          {org.storefronts.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="text-no-storefronts">
              No storefronts attached yet.
            </p>
          )}
          {org.storefronts.map((sf) => (
            <div
              key={sf.id}
              className="flex items-center justify-between gap-2 rounded-md border p-2"
              data-testid={`storefront-row-${sf.tenantId}`}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{sf.tenantName}</p>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> {sf.postalCode ?? 'No zip on file'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {isSuperAdmin ? (
                  <Select
                    value={sf.regionId != null ? String(sf.regionId) : 'none'}
                    onValueChange={(v) =>
                      move.mutate({
                        orgId: org.id,
                        tenantId: sf.tenantId,
                        data: { regionId: v === 'none' ? null : Number(v) },
                      })
                    }
                  >
                    <SelectTrigger className="w-40 h-8" data-testid={`select-region-${sf.tenantId}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned</SelectItem>
                      {org.regions.map((r) => (
                        <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="outline">
                    {org.regions.find((r) => r.id === sf.regionId)?.name ?? 'Unassigned'}
                  </Badge>
                )}
                {isSuperAdmin && (
                  <Button
                    size="icon"
                    variant="ghost"
                    data-testid={`button-detach-${sf.tenantId}`}
                    onClick={() => detach.mutate({ orgId: org.id, tenantId: sf.tenantId })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
        {isSuperAdmin && (
          <div className="space-y-3 border-t pt-3">
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor="new-region">New region</Label>
                <Input
                  id="new-region"
                  data-testid="input-new-region"
                  placeholder="e.g. Northeast"
                  value={regionName}
                  onChange={(e) => setRegionName(e.target.value)}
                />
              </div>
              <Button
                variant="secondary"
                data-testid="button-add-region"
                disabled={regionName.trim() === '' || createRegion.isPending}
                onClick={() => createRegion.mutate({ orgId: org.id, data: { name: regionName.trim() } })}
              >
                Add region
              </Button>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label>Attach storefront</Label>
                <Select value={attachTenantId} onValueChange={setAttachTenantId}>
                  <SelectTrigger data-testid="select-attach-tenant">
                    <SelectValue placeholder="Choose a business" />
                  </SelectTrigger>
                  <SelectContent>
                    {attachable.map((t) => (
                      <SelectItem key={t.id} value={String(t.id)}>{t.brandName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Region</Label>
                <Select value={attachRegionId} onValueChange={setAttachRegionId}>
                  <SelectTrigger className="w-36" data-testid="select-attach-region">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {org.regions.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                data-testid="button-attach-storefront"
                disabled={attachTenantId === '' || attach.isPending}
                onClick={() =>
                  attach.mutate({
                    orgId: org.id,
                    data: {
                      storefrontTenantId: Number(attachTenantId),
                      ...(attachRegionId !== 'none' ? { regionId: Number(attachRegionId) } : {}),
                    },
                  })
                }
              >
                Attach
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Role assignment ──────────────────────────────────────────────────────────

function RolesCard({ org }: { org: FranchiseOrgDetail }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const rolesQuery = useListFranchiseRoles(org.id);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('storefront_operator');
  const [scopeId, setScopeId] = useState('');
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListFranchiseRolesQueryKey(org.id) });
  const onError = (e: unknown) =>
    toast({ title: 'Role update failed', description: errMessage(e), variant: 'destructive' });
  const assign = useAssignFranchiseRole({
    mutation: { onSuccess: () => { invalidate(); setUserId(''); setScopeId(''); }, onError },
  });
  const remove = useRemoveFranchiseRole({ mutation: { onSuccess: invalidate, onError } });

  return (
    <Card data-testid="card-roles">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" /> Hierarchy roles
        </CardTitle>
        <CardDescription>
          Super Admins govern the whole org, Regional Managers their region, Storefront
          Operators one location.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {(rolesQuery.data ?? []).map((r) => (
          <div
            key={r.id}
            className="flex items-center justify-between rounded-md border p-2"
            data-testid={`role-row-${r.id}`}
          >
            <div>
              <p className="text-sm font-medium">{r.username}</p>
              <p className="text-xs text-muted-foreground">
                {ROLE_LABELS[r.role] ?? r.role}
                {r.regionId != null &&
                  ` — ${org.regions.find((reg) => reg.id === r.regionId)?.name ?? `region ${r.regionId}`}`}
                {r.tenantId != null &&
                  ` — ${org.storefronts.find((s) => s.tenantId === r.tenantId)?.tenantName ?? `tenant ${r.tenantId}`}`}
              </p>
            </div>
            <Button
              size="icon"
              variant="ghost"
              data-testid={`button-remove-role-${r.id}`}
              onClick={() => remove.mutate({ orgId: org.id, roleId: r.id })}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <div className="grid grid-cols-2 gap-2 border-t pt-3">
          <div className="space-y-1">
            <Label htmlFor="role-user-id">User ID</Label>
            <Input
              id="role-user-id"
              data-testid="input-role-user-id"
              placeholder="e.g. 12"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => { setRole(v); setScopeId(''); }}>
              <SelectTrigger data-testid="select-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ROLE_LABELS).map(([v, label]) => (
                  <SelectItem key={v} value={v}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {role === 'regional_manager' && (
            <div className="space-y-1">
              <Label>Region</Label>
              <Select value={scopeId} onValueChange={setScopeId}>
                <SelectTrigger data-testid="select-role-region">
                  <SelectValue placeholder="Region" />
                </SelectTrigger>
                <SelectContent>
                  {org.regions.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {role === 'storefront_operator' && (
            <div className="space-y-1">
              <Label>Storefront</Label>
              <Select value={scopeId} onValueChange={setScopeId}>
                <SelectTrigger data-testid="select-role-storefront">
                  <SelectValue placeholder="Storefront" />
                </SelectTrigger>
                <SelectContent>
                  {org.storefronts.map((s) => (
                    <SelectItem key={s.tenantId} value={String(s.tenantId)}>{s.tenantName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="col-span-2">
            <Button
              className="w-full"
              data-testid="button-assign-role"
              disabled={
                userId.trim() === '' ||
                assign.isPending ||
                (role !== 'super_admin' && scopeId === '')
              }
              onClick={() =>
                assign.mutate({
                  orgId: org.id,
                  data: {
                    userId: Number(userId),
                    role: role as never,
                    ...(role === 'regional_manager' ? { regionId: Number(scopeId) } : {}),
                    ...(role === 'storefront_operator' ? { tenantId: Number(scopeId) } : {}),
                  },
                })
              }
            >
              Assign role
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Template designer & deployment status ───────────────────────────────────

function TemplatesCard({ org, isSuperAdmin }: { org: FranchiseOrgDetail; isSuperAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const templatesQuery = useListFranchiseTemplates(org.id);
  const [title, setTitle] = useState('');
  const [terms, setTerms] = useState('');
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListFranchiseTemplatesQueryKey(org.id) });
  };
  const onError = (e: unknown) =>
    toast({ title: 'Template update failed', description: errMessage(e), variant: 'destructive' });
  const create = useCreateFranchiseTemplate({
    mutation: {
      onSuccess: () => { invalidate(); setTitle(''); setTerms(''); toast({ title: 'Template deployed to all locations' }); },
      onError,
    },
  });
  const update = useUpdateFranchiseTemplate({ mutation: { onSuccess: invalidate, onError } });

  return (
    <Card data-testid="card-templates">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="h-4 w-4" /> Global perk templates
        </CardTitle>
        <CardDescription>
          HQ-defined perks that automatically go live at every storefront; updates and
          retirements propagate down.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {(templatesQuery.data ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="text-no-templates">
            No templates yet.
          </p>
        )}
        {(templatesQuery.data ?? []).map((t: FranchiseTemplate) => (
          <div key={t.id} className="rounded-md border p-3 space-y-2" data-testid={`template-row-${t.id}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{t.title}</p>
                {t.redemptionTerms && (
                  <p className="text-xs text-muted-foreground truncate">{t.redemptionTerms}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={t.status === 'active' ? 'default' : 'secondary'}>{t.status}</Badge>
                {isSuperAdmin && (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`button-toggle-template-${t.id}`}
                    onClick={() =>
                      update.mutate({
                        orgId: org.id,
                        templateId: t.id,
                        data: { status: t.status === 'active' ? 'retired' : 'active' },
                      })
                    }
                  >
                    {t.status === 'active' ? 'Retire' : 'Reactivate'}
                  </Button>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {t.deployments.map((d) => (
                <Badge
                  key={d.tenantId}
                  variant="outline"
                  className="text-xs"
                  data-testid={`deployment-${t.id}-${d.tenantId}`}
                >
                  {d.status === 'deployed' ? (
                    <Check className="h-3 w-3 mr-1 text-emerald-600" />
                  ) : (
                    <X className="h-3 w-3 mr-1 text-muted-foreground" />
                  )}
                  {d.tenantName}
                </Badge>
              ))}
            </div>
          </div>
        ))}
        {isSuperAdmin && (
          <div className="space-y-2 border-t pt-3">
            <div className="space-y-1">
              <Label htmlFor="template-title">Perk title</Label>
              <Input
                id="template-title"
                data-testid="input-template-title"
                placeholder="e.g. Franchise VIP — 15% off any service"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="template-terms">Redemption terms</Label>
              <Textarea
                id="template-terms"
                data-testid="input-template-terms"
                placeholder="e.g. One redemption per customer per visit"
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
              />
            </div>
            <Button
              data-testid="button-deploy-template"
              disabled={title.trim() === '' || create.isPending}
              onClick={() =>
                create.mutate({
                  orgId: org.id,
                  data: {
                    title: title.trim(),
                    ...(terms.trim() !== '' ? { redemptionTerms: terms.trim() } : {}),
                  },
                })
              }
            >
              <Plus className="h-4 w-4 mr-1" /> Deploy to all locations
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Approval queue & local partnership requests ─────────────────────────────

function ApprovalsCard({ org, canApprove }: { org: FranchiseOrgDetail; canApprove: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const requestsQuery = useListFranchiseRequests(org.id);
  const tenantsQuery = useListTenants();
  const [storefrontId, setStorefrontId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [perkTitle, setPerkTitle] = useState('');
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListFranchiseRequestsQueryKey(org.id) });
  const onError = (e: unknown) =>
    toast({ title: 'Request failed', description: errMessage(e), variant: 'destructive' });
  const create = useCreateFranchiseRequest({
    mutation: {
      onSuccess: (r) => {
        invalidate();
        setPerkTitle('');
        toast({
          title: r.status === 'approved' ? 'Local partnership invite sent' : 'Queued for approval',
        });
      },
      onError,
    },
  });
  const decide = useDecideFranchiseRequest({ mutation: { onSuccess: invalidate, onError } });
  const attachedIds = new Set(org.storefronts.map((s) => s.tenantId));
  const targets = (tenantsQuery.data ?? []).filter((t) => !attachedIds.has(t.id));

  return (
    <Card data-testid="card-approvals">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPin className="h-4 w-4" /> Local partnerships
        </CardTitle>
        <CardDescription>
          Storefront-initiated partnerships with nearby businesses in the same zip code.
          Policy: {POLICY_LABELS[org.autonomyPolicy] ?? org.autonomyPolicy}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {(requestsQuery.data ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="text-no-requests">
            No local partnership requests yet.
          </p>
        )}
        {(requestsQuery.data ?? []).map((r: FranchisePartnershipRequest) => (
          <div
            key={r.id}
            className="flex items-center justify-between gap-2 rounded-md border p-2"
            data-testid={`request-row-${r.id}`}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">
                {r.storefrontTenantName} → {r.targetTenantName}
              </p>
              <p className="text-xs text-muted-foreground truncate">{r.perkTitle}</p>
            </div>
            {r.status === 'pending' && canApprove ? (
              <div className="flex gap-1">
                <Button
                  size="sm"
                  data-testid={`button-approve-${r.id}`}
                  onClick={() =>
                    decide.mutate({ orgId: org.id, requestId: r.id, data: { action: 'approve' } })
                  }
                >
                  <Check className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`button-reject-${r.id}`}
                  onClick={() =>
                    decide.mutate({ orgId: org.id, requestId: r.id, data: { action: 'reject' } })
                  }
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <Badge
                variant={
                  r.status === 'approved' ? 'default' : r.status === 'rejected' ? 'destructive' : 'secondary'
                }
              >
                {r.status}
              </Badge>
            )}
          </div>
        ))}
        <div className="space-y-2 border-t pt-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>Storefront</Label>
              <Select value={storefrontId} onValueChange={setStorefrontId}>
                <SelectTrigger data-testid="select-request-storefront">
                  <SelectValue placeholder="Your location" />
                </SelectTrigger>
                <SelectContent>
                  {org.storefronts.map((s) => (
                    <SelectItem key={s.tenantId} value={String(s.tenantId)}>{s.tenantName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Nearby business</Label>
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger data-testid="select-request-target">
                  <SelectValue placeholder="Same zip code" />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.brandName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="request-perk-title">Perk offer</Label>
            <Input
              id="request-perk-title"
              data-testid="input-request-perk-title"
              placeholder="e.g. Free coffee with any haircut"
              value={perkTitle}
              onChange={(e) => setPerkTitle(e.target.value)}
            />
          </div>
          <Button
            data-testid="button-create-request"
            disabled={
              storefrontId === '' || targetId === '' || perkTitle.trim() === '' || create.isPending
            }
            onClick={() =>
              create.mutate({
                orgId: org.id,
                data: {
                  storefrontTenantId: Number(storefrontId),
                  targetTenantId: Number(targetId),
                  perkTitle: perkTitle.trim(),
                },
              })
            }
          >
            Request local partnership
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Executive roll-up report ─────────────────────────────────────────────────

function RollupCard({ orgId }: { orgId: number }) {
  const rollupQuery = useGetFranchiseRollup(orgId);
  const data: FranchiseRollup | undefined = rollupQuery.data;
  return (
    <Card data-testid="card-rollup">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Corporate roll-up report</CardTitle>
        <CardDescription>
          Cross-promotion traffic, perk redemptions, and revenue across your network — broken
          down by region and storefront.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rollupQuery.isLoading && <Skeleton className="h-24 w-full" />}
        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
              <RollupStat label="Impressions" value={String(data.totals.impressions)} testId="stat-impressions" />
              <RollupStat label="Claims" value={String(data.totals.claims)} testId="stat-claims" />
              <RollupStat label="Crossovers" value={String(data.totals.crossovers)} testId="stat-crossovers" />
              <RollupStat label="Redemptions" value={String(data.totals.redemptions)} testId="stat-redemptions" />
              <RollupStat label="Revenue influenced" value={formatCurrency(data.totals.revenueInfluenced)} testId="stat-revenue-influenced" />
              <RollupStat label="Ledger revenue" value={formatCurrency(data.totals.ledgerRevenue)} testId="stat-ledger-revenue" />
            </div>
            <div className="space-y-3">
              {data.regions.map((region) => (
                <div key={region.regionId ?? 'none'} className="rounded-md border p-3" data-testid={`rollup-region-${region.regionId ?? 'none'}`}>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">{region.regionName}</p>
                    <p className="text-xs text-muted-foreground">
                      {region.totals.redemptions} redemptions · {formatCurrency(region.totals.ledgerRevenue)} revenue
                    </p>
                  </div>
                  <div className="mt-2 space-y-1">
                    {region.storefronts.map((sf) => (
                      <div
                        key={sf.tenantId}
                        className="flex items-center justify-between text-xs text-muted-foreground"
                        data-testid={`rollup-storefront-${sf.tenantId}`}
                      >
                        <span>{sf.tenantName}</span>
                        <span>
                          {sf.totals.impressions} impressions · {sf.totals.claims} claims ·{' '}
                          {sf.totals.redemptions} redemptions · {formatCurrency(sf.totals.ledgerRevenue)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RollupStat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-md border p-3" data-testid={testId}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
