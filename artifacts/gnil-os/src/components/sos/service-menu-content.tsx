import React, { useMemo, useState } from 'react';
import {
  useListSosServices, useCreateSosService, useUpdateSosService,
  useDeleteSosService, useReorderSosServices, getListSosServicesQueryKey,
  type SosService,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { ArrowDown, ArrowUp, Clock, Pencil, Plus, Trash2, UtensilsCrossed } from 'lucide-react';

/**
 * Service Menu editor — the structured, per-business service catalog
 * (categories, descriptions, flat-rate prices, estimated durations) that
 * replaced the legacy comma-separated service-names setting. The AI
 * receptionist and every staff booking form suggest from this same catalog.
 */

const formatPrice = (p: number | null) => (p == null ? '—' : `$${p.toFixed(2)}`);
const formatDuration = (m: number | null) =>
  m == null ? null : m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m} min`;

interface ServiceFormState {
  name: string;
  category: string;
  description: string;
  price: string;
  durationMinutes: string;
}

const emptyForm: ServiceFormState = { name: '', category: '', description: '', price: '', durationMinutes: '' };

function formFrom(s: SosService): ServiceFormState {
  return {
    name: s.name,
    category: s.category ?? '',
    description: s.description ?? '',
    price: s.price == null ? '' : String(s.price),
    durationMinutes: s.durationMinutes == null ? '' : String(s.durationMinutes),
  };
}

export function ServiceMenuContent() {
  const { data: services, isLoading } = useListSosServices({
    query: { queryKey: getListSosServicesQueryKey() },
  });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListSosServicesQueryKey() });

  const create = useCreateSosService();
  const update = useUpdateSosService();
  const remove = useDeleteSosService();
  const reorder = useReorderSosServices();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SosService | null>(null);
  const [form, setForm] = useState<ServiceFormState>(emptyForm);
  const [deleting, setDeleting] = useState<SosService | null>(null);

  const openAdd = () => { setEditing(null); setForm(emptyForm); setDialogOpen(true); };
  const openEdit = (s: SosService) => { setEditing(s); setForm(formFrom(s)); setDialogOpen(true); };

  const priceNum = form.price.trim() === '' ? null : Number(form.price);
  const durationNum = form.durationMinutes.trim() === '' ? null : Number(form.durationMinutes);
  const formValid =
    form.name.trim().length > 0 &&
    (priceNum == null || (Number.isFinite(priceNum) && priceNum >= 0)) &&
    (durationNum == null || (Number.isInteger(durationNum) && durationNum >= 1));

  const handleSave = () => {
    const data = {
      name: form.name.trim(),
      category: form.category.trim() || null,
      description: form.description.trim() || null,
      price: priceNum,
      durationMinutes: durationNum,
    };
    const opts = {
      onSuccess: () => {
        invalidate();
        setDialogOpen(false);
        toast({ title: editing ? 'Service updated' : 'Service added' });
      },
      onError: (err: unknown) => {
        const status = (err as { status?: number })?.status;
        toast({
          title: editing ? "Couldn't update service" : "Couldn't add service",
          description: status === 409 ? 'A service with that name already exists.' : 'Please try again.',
          variant: 'destructive' as const,
        });
      },
    };
    if (editing) update.mutate({ id: editing.id, data }, opts);
    else create.mutate({ data }, opts);
  };

  const toggleActive = (s: SosService) => {
    update.mutate(
      { id: s.id, data: { isActive: !s.isActive } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: s.isActive ? `${s.name} hidden from suggestions` : `${s.name} is active again` });
        },
        onError: () => toast({ title: "Couldn't update service", variant: 'destructive' }),
      },
    );
  };

  const move = (s: SosService, dir: -1 | 1) => {
    if (!services) return;
    const ids = services.map((x) => x.id);
    const i = ids.indexOf(s.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate(
      { data: { orderedIds: ids } },
      {
        onSuccess: () => invalidate(),
        onError: () => toast({ title: "Couldn't reorder services", variant: 'destructive' }),
      },
    );
  };

  const handleDelete = () => {
    if (!deleting) return;
    remove.mutate(
      { id: deleting.id },
      {
        onSuccess: () => {
          invalidate();
          setDeleting(null);
          toast({ title: 'Service removed' });
        },
        onError: () => toast({ title: "Couldn't remove service", variant: 'destructive' }),
      },
    );
  };

  // Group by category, preserving overall sort order; uncategorized last.
  const groups = useMemo(() => {
    const map = new Map<string, SosService[]>();
    for (const s of services ?? []) {
      const key = s.category?.trim() || '';
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    const named = [...map.entries()].filter(([k]) => k !== '');
    const uncategorized = map.get('');
    return uncategorized ? [...named, ['', uncategorized] as const] : named;
  }, [services]);

  return (
    <Card data-testid="section-service-menu">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <UtensilsCrossed className="w-5 h-5 text-primary" /> Service Menu
          </CardTitle>
          <Button onClick={openAdd} data-testid="button-add-service">
            <Plus className="w-4 h-4 mr-1.5" /> Add Service
          </Button>
        </div>
        <CardDescription>
          Your structured service catalog — transparent flat-rate prices and estimated durations.
          The AI Receptionist and staff booking forms suggest from this list.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="space-y-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
        ) : (services ?? []).length === 0 ? (
          <div className="text-center py-10 text-muted-foreground text-sm" data-testid="text-services-empty">
            No services yet. Add your first service so callers and staff can book by name.
          </div>
        ) : (
          groups.map(([category, rows]) => (
            <div key={category || '__uncategorized'} className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {category || 'Uncategorized'}
              </div>
              {rows.map((s) => (
                <div
                  key={s.id}
                  className={`flex items-center gap-3 p-3 border rounded-lg ${s.isActive ? '' : 'opacity-60'}`}
                  data-testid={`row-service-${s.id}`}
                >
                  <div className="flex flex-col shrink-0">
                    <Button
                      variant="ghost" size="icon" className="h-6 w-6"
                      onClick={() => move(s, -1)}
                      disabled={reorder.isPending || services!.indexOf(s) === 0}
                      data-testid={`button-move-up-${s.id}`}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost" size="icon" className="h-6 w-6"
                      onClick={() => move(s, 1)}
                      disabled={reorder.isPending || services!.indexOf(s) === services!.length - 1}
                      data-testid={`button-move-down-${s.id}`}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate" data-testid={`text-service-name-${s.id}`}>{s.name}</span>
                      {!s.isActive && <Badge variant="secondary" className="text-[10px]">Hidden</Badge>}
                    </div>
                    {s.description && (
                      <div className="text-xs text-muted-foreground truncate">{s.description}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {formatDuration(s.durationMinutes) && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" /> {formatDuration(s.durationMinutes)}
                      </span>
                    )}
                    <span className="text-sm font-semibold w-16 text-right" data-testid={`text-service-price-${s.id}`}>
                      {formatPrice(s.price)}
                    </span>
                    <Switch
                      checked={s.isActive}
                      onCheckedChange={() => toggleActive(s)}
                      data-testid={`switch-service-active-${s.id}`}
                    />
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(s)} data-testid={`button-edit-service-${s.id}`}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => setDeleting(s)} data-testid={`button-delete-service-${s.id}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </CardContent>

      {/* Add / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent data-testid="dialog-service-form">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Service' : 'Add Service'}</DialogTitle>
            <DialogDescription>
              Flat-rate pricing only — the price a client pays for this service.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Haircut"
                  data-testid="input-service-name"
                />
              </div>
              <div className="space-y-2">
                <Label>Category</Label>
                <Input
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="e.g. Hair"
                  data-testid="input-service-category"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What's included, who it's for…"
                data-testid="input-service-description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Price ($)</Label>
                <Input
                  type="number" min="0" step="0.01"
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                  placeholder="e.g. 45.00"
                  data-testid="input-service-price"
                />
              </div>
              <div className="space-y-2">
                <Label>Duration (minutes)</Label>
                <Input
                  type="number" min="1" step="5"
                  value={form.durationMinutes}
                  onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
                  placeholder="e.g. 60"
                  data-testid="input-service-duration"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={handleSave}
              disabled={!formValid || create.isPending || update.isPending}
              data-testid="button-save-service"
            >
              {editing ? 'Save Changes' : 'Add Service'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleting != null} onOpenChange={(o) => { if (!o) setDeleting(null); }}>
        <DialogContent data-testid="dialog-delete-service">
          <DialogHeader>
            <DialogTitle>Remove {deleting?.name}?</DialogTitle>
            <DialogDescription>
              It disappears from booking suggestions immediately. Past appointments keep their
              service name. To keep it on file but hide it, toggle it inactive instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={remove.isPending} data-testid="button-confirm-delete-service">
              Remove Service
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
