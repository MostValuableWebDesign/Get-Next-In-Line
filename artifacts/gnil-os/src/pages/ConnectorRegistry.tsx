import { useState } from 'react';
import { Link } from 'wouter';
import {
  useGetConnectorRegistry,
  useGetModulesPricing,
  type ConnectorRegistryEntry,
} from '@workspace/api-client-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EditConnectorDialog } from '@/components/EditConnectorDialog';
import { formatCurrency } from '@/lib/format';
import { ShieldAlert, Package, Pencil, PanelsTopLeft } from 'lucide-react';

// The former "marketing" group was folded into media (White-Label Resale
// Engines); unknown slugs still render after the known ones.
const CATEGORY_ORDER = ['operations', 'partners', 'media'];

/**
 * Product Catalog, rendered as a section of the Configuration page
 * (/settings#connectors). The former standalone /connectors route
 * redirects there. Presents a clean retail catalog — product names,
 * retail prices, and profit margins only.
 */
export function ConnectorRegistrySection() {
  const { data: entries, isLoading } = useGetConnectorRegistry();
  const { data: pricing } = useGetModulesPricing();
  const [editing, setEditing] = useState<ConnectorRegistryEntry | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const groups = new Map<string, { category: string; items: NonNullable<typeof entries> }>();
  for (const e of entries ?? []) {
    const g = groups.get(e.categorySlug) ?? { category: e.category, items: [] };
    g.items.push(e);
    groups.set(e.categorySlug, g);
  }
  const orderedSlugs = [
    ...CATEGORY_ORDER.filter((s) => groups.has(s)),
    ...[...groups.keys()].filter((s) => !CATEGORY_ORDER.includes(s)),
  ];

  return (
    <div className="space-y-8" data-testid="page-connector-registry">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Package className="size-6 text-primary" />
            Product Catalog
          </h2>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Every product by category with its retail price and profit margin.
          </p>
        </div>
        <Badge variant="destructive" className="shrink-0 gap-1.5 uppercase tracking-wider font-mono">
          <ShieldAlert className="size-3.5" />
          Admin Only
        </Badge>
      </div>

      {orderedSlugs.map((slug) => {
        const group = groups.get(slug)!;
        return (
          <Card key={slug} data-testid={`card-category-${slug}`}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                {group.category}
                <span className="text-xs font-mono font-normal text-muted-foreground">
                  {group.items.length} product{group.items.length === 1 ? '' : 's'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {group.items.map((m) => {
                  const price = pricing?.find((p) => p.id === m.id);
                  const isPartner = m.categorySlug === 'partners';
                  return (
                    <div
                      key={m.id}
                      className="px-6 py-4 grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-x-8 gap-y-1.5 items-center"
                      data-testid={`row-module-${m.id}`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium">{m.name}</div>
                      </div>
                      <div className="min-w-0">
                        {isPartner ? (
                          <span className="text-sm text-muted-foreground" data-testid={`text-pricing-${m.id}`}>
                            Partner billed
                          </span>
                        ) : price && price.wholesalePrice === 0 ? (
                          // $0-wholesale modules carry no meaningful markup
                          <span className="text-sm text-muted-foreground" data-testid={`text-pricing-${m.id}`}>
                            Included
                          </span>
                        ) : price ? (
                          <span className="text-sm font-mono" data-testid={`text-pricing-${m.id}`}>
                            {formatCurrency(price.resalePrice)}/mo
                            <span className="text-emerald-600">
                              {' '}· +{formatCurrency(price.margin)} margin
                              {price.resalePrice > 0
                                ? ` (${Math.round((price.margin / price.resalePrice) * 100)}%)`
                                : ''}
                            </span>
                          </span>
                        ) : (
                          <span className="text-sm text-muted-foreground italic">—</span>
                        )}
                      </div>
                      <div className="flex md:justify-end gap-1">
                        <Button
                          asChild
                          variant="ghost"
                          size="icon"
                          aria-label={`Open ${m.name} module console`}
                          data-testid={`link-module-console-${m.id}`}
                        >
                          <Link href={`/modules/${m.id}`}>
                            <PanelsTopLeft className="size-4" />
                          </Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditing(m)}
                          aria-label={`Edit ${m.name}`}
                          data-testid={`button-edit-${m.id}`}
                        >
                          <Pencil className="size-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}

      {editing && (
        <EditConnectorDialog key={editing.id} entry={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
