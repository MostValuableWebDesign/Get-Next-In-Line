import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetConnectorRegistry,
  useUpdateConnectorRegistryEntry,
  getGetConnectorRegistryQueryKey,
  type ConnectorRegistryEntry,
} from '@workspace/api-client-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useIsOffline } from '@/hooks/use-online';
import { ShieldAlert, Cable, Pencil, WifiOff } from 'lucide-react';

const CATEGORY_ORDER = ['marketing', 'operations', 'partners', 'media'];

function EditConnectorDialog({
  entry,
  onClose,
}: {
  entry: ConnectorRegistryEntry;
  onClose: () => void;
}) {
  const [slug, setSlug] = useState(entry.slug ?? '');
  const [upstreamVendor, setUpstreamVendor] = useState(entry.upstreamVendor ?? '');
  const [hiddenConnector, setHiddenConnector] = useState(entry.hiddenConnector ?? '');
  const [proxyNotes, setProxyNotes] = useState(entry.proxyNotes ?? '');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isOffline = useIsOffline();

  const mutation = useUpdateConnectorRegistryEntry({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetConnectorRegistryQueryKey() });
        toast({ title: 'Connector updated', description: `${entry.name} saved.` });
        onClose();
      },
      onError: () => {
        toast({
          title: 'Update failed',
          description: 'Could not save connector details. Please try again.',
          variant: 'destructive',
        });
      },
    },
  });

  const toNullable = (v: string) => {
    const t = v.trim();
    return t === '' ? null : t;
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="dialog-edit-connector">
        <DialogHeader>
          <DialogTitle>Edit Connector — {entry.name}</DialogTitle>
          <DialogDescription>
            Update the hidden connector mapping. These details are admin-only and never shown to
            tenants.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-slug">Slug</Label>
            <Input
              id="edit-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="e.g. ghl_crm_pipelines"
              className="font-mono"
              data-testid="input-slug"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-vendor">Upstream Vendor</Label>
            <Input
              id="edit-vendor"
              value={upstreamVendor}
              onChange={(e) => setUpstreamVendor(e.target.value)}
              placeholder="e.g. GoHighLevel"
              data-testid="input-upstream-vendor"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-connector">Hidden Connector</Label>
            <Input
              id="edit-connector"
              value={hiddenConnector}
              onChange={(e) => setHiddenConnector(e.target.value)}
              placeholder="Connector description"
              data-testid="input-hidden-connector"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-notes">Proxy Notes</Label>
            <Textarea
              id="edit-notes"
              value={proxyNotes}
              onChange={(e) => setProxyNotes(e.target.value)}
              placeholder="Routing / white-label notes"
              rows={3}
              data-testid="input-proxy-notes"
            />
          </div>
        </div>
        {isOffline && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
            data-testid="alert-offline-connector"
          >
            <WifiOff className="size-4 shrink-0" />
            You're offline — saving is disabled until the connection is restored. Keep this dialog
            open to avoid losing your edits.
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-edit">
            Cancel
          </Button>
          <Button
            onClick={() =>
              mutation.mutate({
                id: entry.id,
                data: {
                  slug: toNullable(slug),
                  upstreamVendor: toNullable(upstreamVendor),
                  hiddenConnector: toNullable(hiddenConnector),
                  proxyNotes: toNullable(proxyNotes),
                },
              })
            }
            disabled={mutation.isPending || isOffline}
            data-testid="button-save-connector"
          >
            {mutation.isPending ? 'Saving…' : isOffline ? 'Offline — can’t save' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
                    <div className="flex md:justify-end">
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
