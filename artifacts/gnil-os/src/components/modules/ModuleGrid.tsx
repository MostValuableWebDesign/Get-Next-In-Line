import { useListModules, useGetModulesPricing } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/format';
import { Server, ShieldCheck, Zap } from 'lucide-react';

export function ModuleGrid({ categorySlug, title, description }: { categorySlug: string, title: string, description: string }) {
  const { data: modules, isLoading: isLoadingModules } = useListModules();
  const { data: pricing, isLoading: isLoadingPricing } = useGetModulesPricing();

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
              <Card key={module.id} className="border-none shadow-md flex flex-col relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                  {isPartner ? <ShieldCheck className="w-24 h-24" /> : <Server className="w-24 h-24" />}
                </div>
                <CardHeader>
                  <div className="flex justify-between items-start mb-2">
                    <Badge variant={module.isActive ? "default" : "secondary"} className="uppercase text-[10px] tracking-wider">
                      {module.isActive ? 'Available' : 'Coming Soon'}
                    </Badge>
                    {isPartner && <Badge variant="outline" className="border-primary text-primary bg-primary/5 uppercase text-[10px]">0% Markup</Badge>}
                  </div>
                  <CardTitle className="leading-tight">{module.name}</CardTitle>
                  <CardDescription className="line-clamp-2 mt-2">{module.description}</CardDescription>
                </CardHeader>
                <CardContent className="flex-1" />
                <CardFooter className="border-t bg-muted/20 p-4 flex flex-col items-start gap-1">
                  <div className="flex justify-between w-full items-end">
                    <div>
                      <div className="text-xs text-muted-foreground uppercase tracking-wider font-bold mb-1">Resale</div>
                      <div className="text-2xl font-mono font-bold text-foreground">
                        {formatCurrency(priceInfo?.resalePrice || module.wholesalePrice)}<span className="text-sm font-sans font-normal text-muted-foreground">/mo</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Wholesale Cost</div>
                      <div className="text-sm font-mono text-muted-foreground">
                        {formatCurrency(module.wholesalePrice)}/mo
                      </div>
                    </div>
                  </div>
                  
                  {!isPartner && priceInfo && (
                    <div className="w-full mt-3 pt-3 border-t border-border/50 flex justify-between items-center text-xs">
                      <span className="text-muted-foreground">Agency Margin</span>
                      <span className="font-mono font-bold text-emerald-600">
                        {formatCurrency(priceInfo.margin)}/mo
                      </span>
                    </div>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
