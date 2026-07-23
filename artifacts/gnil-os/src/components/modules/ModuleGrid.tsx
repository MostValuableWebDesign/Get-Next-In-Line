import { useListModules, useGetModulesPricing } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/format';
import { Server, ShieldCheck } from 'lucide-react';
import { Link } from 'wouter';

export function ModuleGrid({ categorySlug, title, description }: { categorySlug: string, title: string, description: string }) {
  const { data: modules, isLoading: isLoadingModules, isError: isModulesError, refetch: refetchModules } = useListModules();
  const { data: pricing, isLoading: isLoadingPricing, isError: isPricingError, refetch: refetchPricing } = useGetModulesPricing();

  if (isModulesError || isPricingError) {
    return (
      <div className="space-y-6 animate-in fade-in">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          <p className="text-muted-foreground mt-1">{description}</p>
        </div>
        <Card className="border-dashed bg-transparent shadow-none" data-testid="module-grid-error">
          <CardContent className="p-12 text-center space-y-4">
            <div className="font-semibold">Couldn&apos;t load modules</div>
            <p className="text-muted-foreground text-sm">
              Something went wrong while loading this category. Please try again.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                if (isModulesError) refetchModules();
                if (isPricingError) refetchPricing();
              }}
              data-testid="button-retry-modules"
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoadingModules || isLoadingPricing) {
    return (
      <div className="space-y-6 animate-in fade-in">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          <p className="text-muted-foreground mt-1">{description}</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1,2,3,4,5,6].map(i => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      </div>
    );
  }

  const categoryModules = modules?.filter(m => m.categorySlug === categorySlug) || [];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="text-muted-foreground mt-1">{description}</p>
      </div>

      {!categoryModules.length ? (
        <Card className="border-dashed bg-transparent shadow-none">
          <CardContent className="p-12 text-center text-muted-foreground">
            No modules found in this category.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {categoryModules.map(module => {
            const priceInfo = pricing?.find(p => p.id === module.id);
            const isPartner = categorySlug === 'partners';

            return (
              <Link
                key={module.id}
                href={`/modules/${module.id}`}
                className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                data-testid={`link-module-console-${module.id}`}
              >
              <Card className="h-full border-none shadow-md flex flex-col relative overflow-hidden group cursor-pointer transition-shadow hover:shadow-lg">
                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                  {isPartner ? <ShieldCheck className="w-24 h-24" /> : <Server className="w-24 h-24" />}
                </div>
                <CardHeader>
                  <div className="flex justify-between items-start mb-2">
                    <Badge variant={module.isActive ? "default" : "secondary"} className="uppercase text-[10px] tracking-wider">
                      {module.isActive ? 'Available' : 'Coming Soon'}
                    </Badge>
                  </div>
                  <CardTitle className="leading-tight">{module.name}</CardTitle>
                  <CardDescription className="line-clamp-2 mt-2">{module.description}</CardDescription>
                </CardHeader>
                <CardContent className="flex-1" />
                {!isPartner && (
                <CardFooter className="border-t bg-muted/20 p-4 flex flex-col items-start gap-1">
                  <div className="flex justify-between w-full items-end">
                    <div>
                      <div className="text-xs text-muted-foreground uppercase tracking-wider font-bold mb-1">Retail Price</div>
                      <div className="text-2xl font-mono font-bold text-foreground">
                        {formatCurrency(priceInfo?.resalePrice ?? 0)}<span className="text-sm font-sans font-normal text-muted-foreground">/mo</span>
                      </div>
                    </div>
                    {priceInfo && (
                      <div className="text-right">
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Profit Margin</div>
                        <div className="text-sm font-mono font-bold text-emerald-600" data-testid={`margin-${module.id}`}>
                          +{formatCurrency(priceInfo.margin)}/mo
                          {priceInfo.resalePrice > 0 && (
                            <span className="font-normal text-emerald-600/80"> ({Math.round((priceInfo.margin / priceInfo.resalePrice) * 100)}%)</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {priceInfo?.resalePriceBiweekly != null && (
                    <div className="w-full mt-2 pt-2 border-t border-dashed border-border/50 space-y-1" data-testid={`biweekly-pricing-${module.id}`}>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Bi-Weekly Option</div>
                      <div className="flex justify-between items-center text-xs">
                        <span className="font-mono font-bold">{formatCurrency(priceInfo.resalePriceBiweekly)}<span className="font-sans font-normal text-muted-foreground">/2wk</span></span>
                        {priceInfo.marginBiweekly != null && (
                          <span className="font-mono font-bold text-emerald-600">+{formatCurrency(priceInfo.marginBiweekly)} margin</span>
                        )}
                      </div>
                    </div>
                  )}
                </CardFooter>
                )}
              </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
