import { useState } from 'react';
import { useListModules } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckoutSimulationDialog } from '@/components/checkout/CheckoutSimulationDialog';
import { Zap } from 'lucide-react';

interface StaticPageProps {
  title: string;
  description: string;
  partner: string;
  features: string[];
  /**
   * Display name of the marketplace module backing this partner offering
   * (as seeded in the modules table — /api/modules intentionally exposes no
   * machine slug). Activate opens the shared checkout-simulation flow locked
   * to that module.
   */
  moduleName: string;
}

export function StaticPlaceholderPage({ title, description, partner, features, moduleName }: StaticPageProps) {
  const { data: modules, isLoading } = useListModules();
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  const module = modules?.find((m) => m.name === moduleName && m.isActive);

  return (
    <div className="p-8 max-w-4xl mx-auto mt-12">
      <Card className="border-muted shadow-sm">
        <CardHeader className="text-center pb-8 pt-12">
          <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4 text-primary">
            <Zap className="h-6 w-6" />
          </div>
          <CardTitle className="text-3xl font-bold tracking-tight">{title}</CardTitle>
          <CardDescription className="text-lg mt-2">
            Powered by <span className="font-semibold text-foreground">{partner}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="px-12 pb-12">
          <p className="text-muted-foreground text-center mb-10 max-w-2xl mx-auto">
            {description}
          </p>
          
          <div className="grid sm:grid-cols-2 gap-4 mb-10">
            {features.map((feature, i) => (
              <div key={i} className="flex items-center gap-3 p-4 rounded-lg bg-muted/50 border border-border/50">
                <div className="w-2 h-2 rounded-full bg-primary" />
                <span className="font-medium text-sm">{feature}</span>
              </div>
            ))}
          </div>

          <div className="flex justify-center">
            <Button
              size="lg"
              disabled={isLoading || !module}
              onClick={() => setCheckoutOpen(true)}
              data-testid={`btn-activate-${title.toLowerCase().replace(/\s+/g, '-')}`}
            >
              {isLoading ? 'Loading…' : module ? 'Activate Module' : 'Module Unavailable'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {module && (
        <CheckoutSimulationDialog
          open={checkoutOpen}
          onOpenChange={setCheckoutOpen}
          title={`Activate ${title}`}
          description={`Provision the ${partner} partner module for a tenant via the checkout simulation.`}
          lockedModuleId={module.id}
        />
      )}
    </div>
  );
}
