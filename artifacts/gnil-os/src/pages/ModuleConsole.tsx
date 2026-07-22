import { useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import {
  useListModules,
  useGetModulesPricing,
  useGetAgencySettings,
  useListTenants,
  useGetModuleTenantCounts,
  useGetModuleTenants,
  useSimulateCheckout,
  getListTenantsQueryKey,
  getGetModuleTenantCountsQueryKey,
  getGetModuleTenantsQueryKey,
  getGetBillingSummaryQueryKey,
  getGetAgencyDashboardQueryKey,
  getGetTenantActivityQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatCurrency } from '@/lib/format';
import { useToast } from '@/hooks/use-toast';
import {
  ArrowLeft, CreditCard, FileText, Lock, RefreshCw, Server, ShieldCheck, Sliders, Users,
} from 'lucide-react';

const CATEGORY_ROUTES: Record<string, { path: string; label: string }> = {
  marketing: { path: '/marketing', label: 'Marketing OS & Bridge' },
  operations: { path: '/operations', label: 'Operations' },
  partners: { path: '/partners', label: 'Partners' },
  media: { path: '/media', label: 'Media' },
};

export default function ModuleConsole() {
  const params = useParams<{ id: string }>();
  const moduleId = Number(params.id);

  const { data: modules, isLoading: isLoadingModules } = useListModules();
  const { data: pricing, isLoading: isLoadingPricing } = useGetModulesPricing();
  const { data: settings, isLoading: isLoadingSettings } = useGetAgencySettings();
  const { data: tenantCounts } = useGetModuleTenantCounts();
  const { data: subscribers, isLoading: isLoadingSubscribers } = useGetModuleTenants(moduleId, {
    query: { queryKey: getGetModuleTenantsQueryKey(moduleId), enabled: Number.isInteger(moduleId) },
  });
  const { toast } = useToast();

  if (isLoadingModules || isLoadingPricing || isLoadingSettings) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton className="lg:col-span-2 h-[320px] rounded-xl" />
          <Skeleton className="h-[320px] rounded-xl" />
        </div>
      </div>
    );
  }

  const module = modules?.find((m) => m.id === moduleId);

  if (!module) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">Module not found</h1>
        <p className="text-muted-foreground">This module does not exist or is no longer available.</p>
        <Button asChild variant="outline">
          <Link href="/">Back to Command Center</Link>
        </Button>
      </div>
    );
  }

  const priceInfo = pricing?.find((p) => p.id === module.id);
  const isPartner = module.categorySlug === 'partners';
  const markupPercent = settings?.markupPercent ?? priceInfo?.markupPercent ?? 0;
  const activeTenants = tenantCounts?.find((c) => c.moduleId === module.id)?.activeTenantCount ?? 0;
  const backRoute = CATEGORY_ROUTES[module.categorySlug] ?? { path: '/', label: 'Command Center' };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Button asChild variant="ghost" size="sm" className="gap-2 -ml-2 text-muted-foreground" data-testid="link-back-category">
        <Link href={backRoute.path}>
          <ArrowLeft className="w-4 h-4" /> Back to {backRoute.label}
        </Link>
      </Button>

      {/* Module Header */}
      <Card className="border-none shadow-md">
        <CardContent className="p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-primary/10 border border-primary/20 rounded-xl text-primary">
              {isPartner ? <ShieldCheck className="w-8 h-8" /> : <Server className="w-8 h-8" />}
            </div>
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-bold tracking-tight" data-testid="text-module-name">{module.name}</h1>
                <Badge variant="outline" className="uppercase text-[10px] tracking-wider border-emerald-500/40 text-emerald-600 bg-emerald-500/5">
                  {module.category}
                </Badge>
              </div>
              <p className="text-muted-foreground text-sm mt-1" data-testid="text-module-description">{module.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 self-stretch md:self-auto justify-end">
            {isPartner ? (
              <Badge
                variant="outline"
                className="border-sky-500/40 text-sky-600 bg-sky-500/5 px-3 py-1"
                data-testid="badge-partner-direct"
              >
                Partner Direct (0% Markup)
              </Badge>
            ) : (
              <div className="text-right mr-2">
                <div className="text-xs text-muted-foreground">Resale Price w/ {markupPercent}% Markup</div>
                <div className="text-xl font-extrabold font-mono text-emerald-600" data-testid="text-resale-price">
                  {formatCurrency(priceInfo?.resalePrice ?? module.wholesalePrice)}
                  <span className="text-xs text-muted-foreground font-normal font-sans">/mo</span>
                </div>
                {priceInfo?.resalePriceBiweekly != null && (
                  <div className="text-xs font-mono text-muted-foreground mt-0.5" data-testid="text-resale-price-biweekly">
                    or {formatCurrency(priceInfo.resalePriceBiweekly)}
                    <span className="font-sans">/2wk</span>
                  </div>
                )}
              </div>
            )}
            {!isPartner && <ProvisionModuleDialog moduleId={module.id} moduleName={module.name} />}
          </div>
        </CardContent>
      </Card>

      {/* Console Interactive Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 border-none shadow-md">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-lg flex items-center gap-2">
              <Sliders className="w-5 h-5 text-primary" /> Operational & Marketing Proxy Console
            </CardTitle>
            <span className="text-xs text-muted-foreground bg-muted px-2.5 py-1 rounded-md border">
              Unified Ecosystem Active
            </span>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="p-6 bg-muted/40 rounded-xl border space-y-4">
              <div className="flex justify-between items-center pb-4 border-b">
                <span className="text-sm font-medium">Active Tenants Subscribed</span>
                <span className="text-sm font-bold text-emerald-600" data-testid="text-active-tenants">
                  {activeTenants} Active Subdomains
                </span>
              </div>
              <div className="flex justify-between items-center pb-4 border-b">
                <span className="text-sm font-medium">API Gateway Status</span>
                <span className="flex items-center gap-1.5 text-xs text-emerald-600 font-semibold">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" /> GNIL Bridge Connected
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Current Revenue Share Margin</span>
                <span className="text-sm font-bold text-primary" data-testid="text-markup-percent">
                  +{markupPercent}% Agency Markup
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-4">
              <Button
                variant="secondary"
                className="gap-2"
                data-testid="button-force-sync"
                onClick={() => toast({ title: 'Sync Complete', description: `Successfully synchronized data stream for ${module.name}` })}
              >
                <RefreshCw className="w-4 h-4" /> Force Sync Gateway
              </Button>
              <Button
                variant="secondary"
                className="gap-2"
                data-testid="button-export-ledger"
                onClick={() => toast({ title: 'Export Generated', description: `Generated compliance export report for ${module.name}` })}
              >
                <FileText className="w-4 h-4" /> Export Ledger Data
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 border-none shadow-md">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Users className="w-5 h-5 text-primary" /> Subscribed Tenants
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingSubscribers ? (
              <div className="space-y-3">
                <Skeleton className="h-12 w-full rounded-lg" />
                <Skeleton className="h-12 w-full rounded-lg" />
              </div>
            ) : !subscribers || subscribers.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-subscribers">
                No tenants are subscribed to this module yet.
              </p>
            ) : (
              <div className="divide-y" data-testid="list-module-subscribers">
                {subscribers.map((s) => (
                  <Link
                    key={s.tenantId}
                    href={`/tenants/${s.tenantId}`}
                    className="flex items-center justify-between gap-4 py-3 px-2 -mx-2 rounded-lg hover:bg-muted/50 transition-colors"
                    data-testid={`link-subscriber-${s.tenantId}`}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{s.brandName}</div>
                      <div className="text-xs text-muted-foreground font-mono truncate">{s.subdomain}</div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <Badge variant="outline" className="text-[9px] uppercase" data-testid={`badge-cadence-${s.tenantId}`}>
                        {s.billingCadence === 'biweekly' ? 'Bi-Weekly' : 'Monthly'}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        Provisioned {new Date(s.provisionedAt).toLocaleDateString()}
                      </span>
                      <Badge
                        variant="outline"
                        className={
                          s.status === 'active'
                            ? 'border-emerald-500/40 text-emerald-600 bg-emerald-500/5'
                            : s.status === 'suspended'
                              ? 'border-red-500/40 text-red-600 bg-red-500/5'
                              : 'border-amber-500/40 text-amber-600 bg-amber-500/5'
                        }
                      >
                        {s.status}
                      </Badge>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-none shadow-md">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Lock className="w-5 h-5 text-emerald-600" /> Unified Ecosystem Guard
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Front-end lead acquisition data flows directly into back-end operational scheduling, staff
              commissions, payroll, and high-margin programmatic media under your brand.
            </p>
            <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl space-y-2">
              <div className="text-xs font-bold text-emerald-600 uppercase tracking-wider">Status: Fully Integrated</div>
              <div className="text-xs text-muted-foreground">Seamless lead-to-payroll pipeline active across all tenants.</div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ProvisionModuleDialog({ moduleId, moduleName }: { moduleId: number; moduleName: string }) {
  const [open, setOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState<string>('');
  const { data: tenants } = useListTenants();
  const { data: pricing } = useGetModulesPricing();
  const simulateCheckout = useSimulateCheckout();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const priceInfo = pricing?.find((p) => p.id === moduleId);

  const handleProvision = () => {
    if (!selectedTenant) return;
    simulateCheckout.mutate(
      {
        data: {
          tenantId: parseInt(selectedTenant),
          moduleIds: [moduleId],
          applyMarkup: true,
        },
      },
      {
        onSuccess: (res) => {
          setOpen(false);
          setSelectedTenant('');
          queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetModuleTenantCountsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetModuleTenantsQueryKey(moduleId) });
          queryClient.invalidateQueries({ queryKey: getGetBillingSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAgencyDashboardQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetTenantActivityQueryKey() });
          toast({
            title: 'Module Provisioned',
            description: `${moduleName} activated — ${res.transactionId} | ${formatCurrency(res.totalResale)}/mo`,
          });
        },
        onError: () => {
          toast({
            title: 'Provisioning failed',
            description: 'The request could not be completed. Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <>
      <Button className="gap-2" onClick={() => setOpen(true)} data-testid="button-provision-module">
        <CreditCard className="w-4 h-4" /> Provision Module
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Provision {moduleName}</DialogTitle>
            <DialogDescription>
              Simulated Stripe checkout — select the tenant that will receive this module.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Target Tenant</label>
              <Select value={selectedTenant} onValueChange={setSelectedTenant}>
                <SelectTrigger data-testid="select-provision-tenant">
                  <SelectValue placeholder="Choose tenant..." />
                </SelectTrigger>
                <SelectContent>
                  {tenants?.map((t) => (
                    <SelectItem key={t.id} value={t.id.toString()}>{t.brandName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="bg-muted/30 p-4 rounded-lg border space-y-2 text-sm">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Wholesale Cost</span>
                <span className="font-mono">{formatCurrency(priceInfo?.wholesalePrice ?? 0)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-emerald-600">Agency Margin</span>
                <span className="font-mono text-emerald-600">+{formatCurrency(priceInfo?.margin ?? 0)}</span>
              </div>
              <div className="flex justify-between items-center pt-2 border-t">
                <span className="font-bold">Monthly Charge</span>
                <span className="font-mono font-bold text-lg" data-testid="text-provision-total">
                  {formatCurrency(priceInfo?.resalePrice ?? 0)}
                </span>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!selectedTenant || simulateCheckout.isPending}
              onClick={handleProvision}
              data-testid="button-confirm-provision"
            >
              {simulateCheckout.isPending ? 'Processing...' : 'Confirm Provisioning'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
