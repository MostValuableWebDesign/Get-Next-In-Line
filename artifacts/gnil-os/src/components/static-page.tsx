import { useState } from 'react';
import { useListModules } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckoutSimulationDialog } from '@/components/checkout/CheckoutSimulationDialog';
import { PartnerConnectDialog, PartnerStatusBadge } from '@/components/partners/PartnerConnectDialog';
import { Badge } from '@/components/ui/badge';
import { Zap } from 'lucide-react';

interface StaticPageProps {
  title: string;
  description: string;
  partner: string;
  features: string[];
  /**
   * Display name of the marketplace module backing this partner offering
   * (as seeded in the modules table — /api/modules intentionally exposes no
   * machine slug). Activate opens the partner integration workflow when a
   * partnerId is provided, otherwise the shared checkout-simulation flow
   * locked to that module.
   */
  moduleName: string;
  /**
   * When provided, shows an Available / Coming Soon badge driven by the
   * backing module's active state.
   */
  available?: boolean;
  /**
   * Partner connection key (from /api/v1/partners). When set, the Activate
   * CTA launches the connect → authorize → active integration workflow and
   * the card reflects the live connection state.
   */
  partnerId?: string;
  /** Live connection state for this partner (not_connected | pending | active | error). */
  connectionStatus?: string;
}

export function StaticPlaceholderPage({
  title, description, partner, features, moduleName, available, partnerId, connectionStatus,
}: StaticPageProps) {
  const { data: modules, isLoading } = useListModules();
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  const module = modules?.find((m) => m.name === moduleName && m.isActive);
  const testKey = title.toLowerCase().replace(/\s+/g, '-');

  return (
    <div className="p-8 max-w-4xl mx-auto mt-12">
      <Card className="border-muted shadow-sm">
        <CardHeader className="text-center pb-8 pt-12">
          <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4 text-primary">
            <Zap className="h-6 w-6" />
          </div>
          <div className="mx-auto flex items-center gap-2 mb-2">
            {available !== undefined && (
              <Badge
                variant={available ? 'default' : 'secondary'}
                className="uppercase text-[10px] tracking-wider"
                data-testid={`badge-availability-${partner.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {available ? 'Available' : 'Coming Soon'}
              </Badge>
            )}
            {partnerId && connectionStatus && connectionStatus !== 'not_connected' && (
              <PartnerStatusBadge status={connectionStatus} />
            )}
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

          <div className="flex flex-col items-center gap-3">
            <Button
              size="lg"
              disabled={isLoading || !module}
              onClick={() => (partnerId ? setConnectOpen(true) : setCheckoutOpen(true))}
              data-testid={`btn-activate-${testKey}`}
            >
              {isLoading
                ? 'Loading…'
                : !module
                  ? 'Module Unavailable'
                  : partnerId && connectionStatus === 'active'
                    ? 'Manage Connection'
                    : partnerId && connectionStatus === 'pending'
                      ? 'Continue Activation'
                      : 'Activate Module'}
            </Button>
            {partnerId && module && connectionStatus === 'active' && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground"
                onClick={() => setCheckoutOpen(true)}
                data-testid={`btn-provision-${testKey}`}
              >
                Provision for a tenant
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {partnerId && (
        <PartnerConnectDialog
          open={connectOpen}
          onOpenChange={setConnectOpen}
          partnerId={partnerId}
          partnerBrand={partner}
          title={`Activate ${title}`}
        />
      )}
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
