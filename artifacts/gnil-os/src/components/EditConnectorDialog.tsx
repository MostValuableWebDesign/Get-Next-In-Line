import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useUpdateConnectorRegistryEntry,
  getGetConnectorRegistryQueryKey,
  type ConnectorRegistryEntry,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
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
import { WifiOff } from 'lucide-react';

export function EditConnectorDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry: ConnectorRegistryEntry;
  onClose: () => void;
  /** Optional extra cache invalidation hook for pages beyond the registry. */
  onSaved?: () => void;
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
        onSaved?.();
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
              placeholder="e.g. crm_pipelines"
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
              placeholder="e.g. Upstream CRM Vendor"
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
