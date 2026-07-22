import { useState } from 'react';
import { Link, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetAdminModuleDetail,
  getGetAdminModuleDetailQueryKey,
} from '@workspace/api-client-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EditConnectorDialog } from '@/components/EditConnectorDialog';
import { formatCurrency } from '@/lib/format';
import { ArrowLeft, Cable, History, Pencil, Settings, ShieldAlert, Users } from 'lucide-react';

const STATUS_BADGE: Record<string, string> = {
  active: 'border-emerald-500/40 text-emerald-600 bg-emerald-500/5',
  suspended: 'border-red-500/40 text-red-600 bg-red-500/5',
  pending: 'border-amber-500/40 text-amber-600 bg-amber-500/5',
};

export default function AdminModuleDetail() {
  const params = useParams<{ id: string }>();
  const moduleId = Number(params.id);
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();

  const { data: detail, isLoading, isError } = useGetAdminModuleDetail(moduleId, {
    query: { queryKey: getGetAdminModuleDetailQueryKey(moduleId), enabled: Number.isInteger(moduleId) },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Skeleton className="h-[320px] rounded-xl" />
          <Skeleton className="h-[320px] rounded-xl" />
        </div>
      </div>
    );
  }

  if (isError || !detail) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">Module not found</h1>
        <p className="text-muted-foreground">This module does not exist or is no longer available.</p>
        <Button asChild variant="outline">
          <Link href="/connectors">Back to Connector Registry</Link>
        </Button>
      </div>
    );
  }

  const { mapping } = detail;

  return (
    <div className="space-y-6" data-testid="page-admin-module-detail">
      <Button asChild variant="ghost" size="sm" className="gap-2 -ml-2 text-muted-foreground" data-testid="link-back-registry">
        <Link href="/connectors">
          <ArrowLeft className="w-4 h-4" /> Back to Connector Registry
        </Link>
      </Button>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2" data-testid="text-module-name">
            <Cable className="size-6 text-primary" />
            {mapping.name}
          </h1>
          <p className="text-muted-foreground mt-1 max-w-2xl" data-testid="text-module-description">
            {detail.description}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Button asChild variant="outline" size="sm" className="gap-2" data-testid="link-module-settings">
            <Link href="/settings">
              <Settings className="size-3.5" /> Configure
            </Link>
          </Button>
          <Badge variant="destructive" className="shrink-0 gap-1.5 uppercase tracking-wider font-mono">
            <ShieldAlert className="size-3.5" />
            Admin Only
          </Badge>
        </div>
      </div>

      {/* Connector mapping */}
      <Card data-testid="card-connector-mapping">
        <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base font-semibold">Connector Mapping</CardTitle>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => setEditing(true)}
            data-testid="button-edit-mapping"
          >
            <Pencil className="size-3.5" /> Edit Mapping
          </Button>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Slug</div>
            {mapping.slug ? (
              <code className="text-sm font-mono bg-muted px-1.5 py-0.5 rounded" data-testid="text-mapping-slug">{mapping.slug}</code>
            ) : (
              <span className="text-sm text-muted-foreground italic">no slug</span>
            )}
          </div>
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Upstream Vendor</div>
            <div className="text-sm" data-testid="text-mapping-vendor">
              {mapping.upstreamVendor ?? <span className="text-muted-foreground italic">—</span>}
            </div>
          </div>
          <div className="md:col-span-2">
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Hidden Connector</div>
            <div className="text-sm" data-testid="text-mapping-connector">
              {mapping.hiddenConnector ?? (
                <span className="text-muted-foreground italic">Internal — no external connector mapped</span>
              )}
            </div>
          </div>
          <div className="md:col-span-2">
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Proxy Notes</div>
            <div className="text-sm" data-testid="text-mapping-notes">
              {mapping.proxyNotes ?? <span className="text-muted-foreground italic">—</span>}
            </div>
          </div>
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Wholesale / Resale</div>
            <div className="text-sm font-mono" data-testid="text-mapping-pricing">
              {formatCurrency(detail.wholesalePrice)} → {formatCurrency(detail.resalePrice)}/mo
              <span className="text-muted-foreground font-sans"> ({detail.markupPercent}% markup)</span>
              {detail.resalePriceBiweekly != null && (
                <span className="text-muted-foreground"> · {formatCurrency(detail.resalePriceBiweekly)}/2wk</span>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Status</div>
            <Badge
              variant="outline"
              className={mapping.isActive ? STATUS_BADGE.active : STATUS_BADGE.suspended}
              data-testid="badge-mapping-active"
            >
              {mapping.isActive ? 'active' : 'inactive'}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Provisioned tenants */}
        <Card data-testid="card-provisioned-tenants">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Users className="size-4 text-primary" /> Provisioned Tenants
              <span className="text-xs font-mono font-normal text-muted-foreground">
                {detail.tenants.length} tenant{detail.tenants.length === 1 ? '' : 's'}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {detail.tenants.length === 0 ? (
              <p className="text-sm text-muted-foreground px-6 pb-6" data-testid="text-no-tenants">
                No tenants have this module provisioned yet.
              </p>
            ) : (
              <div className="divide-y" data-testid="list-provisioned-tenants">
                {detail.tenants.map((t) => (
                  <Link
                    key={t.tenantId}
                    href={`/tenants/${t.tenantId}`}
                    className="flex items-center justify-between gap-4 px-6 py-3 hover:bg-muted/50 transition-colors"
                    data-testid={`link-tenant-${t.tenantId}`}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{t.brandName}</div>
                      <div className="text-xs text-muted-foreground font-mono truncate">{t.subdomain}</div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 text-right">
                      <div>
                        <div className="text-xs text-muted-foreground">
                          Provisioned {new Date(t.provisionedAt).toLocaleDateString()}
                        </div>
                        <div className="text-xs font-mono">
                          {formatCurrency(t.mrrContribution)}/mo · {t.cadence}
                        </div>
                      </div>
                      <Badge variant="outline" className={STATUS_BADGE[t.status] ?? STATUS_BADGE.pending}>
                        {t.status}
                      </Badge>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Provisioning activity */}
        <Card data-testid="card-provisioning-activity">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <History className="size-4 text-primary" /> Recent Provisioning Activity
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {detail.activity.length === 0 ? (
              <p className="text-sm text-muted-foreground px-6 pb-6" data-testid="text-no-activity">
                No provisioning activity recorded for this module yet.
              </p>
            ) : (
              <div className="divide-y" data-testid="list-provisioning-activity">
                {detail.activity.map((a) => (
                  <div key={a.id} className="px-6 py-3" data-testid={`activity-${a.id}`}>
                    <div className="flex items-center justify-between gap-4">
                      <div className="text-sm font-medium">{a.action}</div>
                      <div className="text-xs text-muted-foreground shrink-0">
                        {new Date(a.timestamp).toLocaleString()}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      <Link href={`/tenants/${a.tenantId}`} className="underline-offset-2 hover:underline">
                        {a.tenantName}
                      </Link>
                      {a.details ? ` — ${a.details}` : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {editing && (
        <EditConnectorDialog
          entry={mapping}
          onClose={() => setEditing(false)}
          onSaved={() =>
            queryClient.invalidateQueries({ queryKey: getGetAdminModuleDetailQueryKey(moduleId) })
          }
        />
      )}
    </div>
  );
}
