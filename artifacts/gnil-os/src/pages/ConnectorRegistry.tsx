import { useState } from 'react';
import { Link } from 'wouter';
import {
  useGetConnectorRegistry,
  type ConnectorRegistryEntry,
} from '@workspace/api-client-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EditConnectorDialog } from '@/components/EditConnectorDialog';
import { ShieldAlert, Cable, Pencil, PanelsTopLeft } from 'lucide-react';

const CATEGORY_ORDER = ['marketing', 'operations', 'partners', 'media'];

export default function ConnectorRegistry() {
  const { data: entries, isLoading } = useGetConnectorRegistry();
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
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Cable className="size-6 text-primary" />
            Connector Registry
          </h1>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            The full white-label proxy map — every module and the upstream vendor connector it
            runs through. Tenants and clients never see any of this.
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
                  {group.items.length} module{group.items.length === 1 ? '' : 's'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {group.items.map((m) => (
                  <div
                    key={m.id}
                    className="px-6 py-4 grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-x-8 gap-y-1.5 items-start"
                    data-testid={`row-module-${m.id}`}
                  >
                    <div className="min-w-0">
                      <div className="font-medium">{m.name}</div>
                      {m.slug ? (
                        <code className="text-xs font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded" data-testid={`text-slug-${m.id}`}>
                          {m.slug}
                        </code>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">no slug</span>
                      )}
                    </div>
                    <div className="min-w-0">
                      {m.hiddenConnector ? (
                        <>
                          <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-0.5">
                            Hidden Connector{m.upstreamVendor ? ` — ${m.upstreamVendor}` : ''}
                          </div>
                          <div className="text-sm" data-testid={`text-connector-${m.id}`}>
                            {m.hiddenConnector}
                          </div>
                          {m.proxyNotes && (
                            <div className="text-xs text-muted-foreground mt-0.5">{m.proxyNotes}</div>
                          )}
                        </>
                      ) : (
                        <div className="text-sm text-muted-foreground italic">
                          Internal — no external connector mapped
                        </div>
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
                        aria-label={`Edit ${m.name} connector`}
                        data-testid={`button-edit-${m.id}`}
                      >
                        <Pencil className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
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
