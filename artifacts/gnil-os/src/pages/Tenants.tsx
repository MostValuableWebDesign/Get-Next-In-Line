import { useState } from 'react';
import { useLocation } from 'wouter';
import { useListTenants, useUpdateTenant, useDeleteTenant, useCreateTenant, getListTenantsQueryKey, useGetTenant } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { MoreHorizontal, Plus, Power, Trash2, Edit2 } from 'lucide-react';
import { formatCurrency } from '@/lib/format';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { useSessionRole } from '@/hooks/useAuth';

export default function Tenants() {
  const { data: tenants, isLoading } = useListTenants();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [, navigate] = useLocation();
  const role = useSessionRole();
  // Only super-admins provision new tenants; staff are read-only.
  const canProvision = role === 'super_admin';
  const canManage = role !== 'staff';

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Tenant Operations</h1>
          <p className="text-muted-foreground mt-1">Manage client environments and subscription status.</p>
        </div>
        {canProvision && (
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="w-4 h-4" /> Provision Tenant
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Provision New Tenant</DialogTitle>
                <DialogDescription>Setup a new client environment and configure basic details.</DialogDescription>
              </DialogHeader>
              <CreateTenantForm onSuccess={() => setIsCreateOpen(false)} />
            </DialogContent>
          </Dialog>
        )}
      </div>

      <Card className="border-none shadow-md">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 space-y-4">
              {[1,2,3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : !tenants?.length ? (
            <div className="p-12 text-center text-muted-foreground">
              <p>No tenants provisioned yet.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>Brand Name / Subdomain</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">MRR</TableHead>
                  <TableHead className="text-center">Modules</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.map(tenant => (
                  <TableRow
                    key={tenant.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/tenants/${tenant.id}`)}
                    data-testid={`row-tenant-${tenant.id}`}
                  >
                    <TableCell>
                      <div className="font-semibold">{tenant.brandName}</div>
                      <div className="text-xs font-mono text-muted-foreground">{tenant.subdomain}.gnil.os</div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{tenant.contactName || 'N/A'}</div>
                      <div className="text-xs text-muted-foreground">{tenant.contactEmail || 'N/A'}</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={tenant.status} />
                    </TableCell>
                    <TableCell className="text-right font-mono font-medium">
                      {formatCurrency(tenant.mrr)}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="outline" className="font-mono">{tenant.modulesEnabled}</Badge>
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {canManage && <TenantActions tenant={tenant} canDelete={role === 'super_admin'} />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TenantActions({ tenant, canDelete }: { tenant: any; canDelete: boolean }) {
  const updateTenant = useUpdateTenant();
  const deleteTenant = useDeleteTenant();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isEditOpen, setIsEditOpen] = useState(false);

  const handleToggleStatus = () => {
    const newStatus = tenant.status === 'active' ? 'suspended' : 'active';
    updateTenant.mutate(
      { id: tenant.id, data: { status: newStatus as any } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() });
          toast({ title: `Tenant ${newStatus}`, description: `${tenant.brandName} is now ${newStatus}.` });
        }
      }
    );
  };

  const handleDelete = () => {
    if (!confirm(`Are you sure you want to delete ${tenant.brandName}? This cannot be undone.`)) return;
    deleteTenant.mutate(
      { id: tenant.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() });
          toast({ title: 'Tenant Deleted', description: `${tenant.brandName} removed.` });
        }
      }
    );
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setIsEditOpen(true)} className="gap-2 cursor-pointer">
            <Edit2 className="h-4 w-4" /> Edit Tenant
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleToggleStatus} className="gap-2 cursor-pointer">
            <Power className="h-4 w-4" /> {tenant.status === 'active' ? 'Suspend' : 'Activate'}
          </DropdownMenuItem>
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleDelete} className="text-destructive focus:text-destructive gap-2 cursor-pointer">
                <Trash2 className="h-4 w-4" /> Terminate
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Tenant: {tenant.brandName}</DialogTitle>
            <DialogDescription>Update the details for this tenant.</DialogDescription>
          </DialogHeader>
          <EditTenantForm tenantId={tenant.id} onSuccess={() => setIsEditOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function EditTenantForm({ tenantId, onSuccess }: { tenantId: number, onSuccess: () => void }) {
  const { data: tenant, isLoading } = useGetTenant(tenantId);
  const updateTenant = useUpdateTenant();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  if (isLoading || !tenant) return <div className="py-4"><Skeleton className="h-32" /></div>;

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    updateTenant.mutate(
      {
        id: tenantId,
        data: {
          brandName: fd.get('brandName') as string,
          contactName: fd.get('contactName') as string,
          contactEmail: fd.get('contactEmail') as string,
        }
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() });
          toast({ title: 'Tenant Updated', description: 'Changes saved successfully.' });
          onSuccess();
        }
      }
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 mt-4">
      <div className="space-y-2">
        <Label htmlFor="edit-brandName">Brand Name</Label>
        <Input id="edit-brandName" name="brandName" required defaultValue={tenant.brandName} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="edit-contactName">Contact Name</Label>
          <Input id="edit-contactName" name="contactName" defaultValue={tenant.contactName || ''} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-contactEmail">Contact Email</Label>
          <Input id="edit-contactEmail" name="contactEmail" type="email" defaultValue={tenant.contactEmail || ''} />
        </div>
      </div>
      <div className="pt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onSuccess}>Cancel</Button>
        <Button type="submit" disabled={updateTenant.isPending}>
          {updateTenant.isPending ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    </form>
  );
}

function CreateTenantForm({ onSuccess }: { onSuccess: () => void }) {
  const createTenant = useCreateTenant();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    createTenant.mutate(
      {
        data: {
          brandName: fd.get('brandName') as string,
          subdomain: fd.get('subdomain') as string,
          contactName: fd.get('contactName') as string,
          contactEmail: fd.get('contactEmail') as string,
        }
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() });
          toast({ title: 'Tenant Provisioned', description: 'Environment is spinning up.' });
          onSuccess();
        }
      }
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 mt-4">
      <div className="space-y-2">
        <Label htmlFor="brandName">Brand Name</Label>
        <Input id="brandName" name="brandName" required placeholder="Acme Corp" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="subdomain">Subdomain</Label>
        <div className="flex items-center gap-2">
          <Input id="subdomain" name="subdomain" required placeholder="acme" className="flex-1" />
          <span className="text-sm font-mono text-muted-foreground bg-muted px-3 py-2 rounded border">.gnil.os</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="contactName">Contact Name</Label>
          <Input id="contactName" name="contactName" placeholder="Jane Doe" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="contactEmail">Contact Email</Label>
          <Input id="contactEmail" name="contactEmail" type="email" placeholder="jane@acme.com" />
        </div>
      </div>
      <div className="pt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onSuccess}>Cancel</Button>
        <Button type="submit" disabled={createTenant.isPending}>
          {createTenant.isPending ? 'Provisioning...' : 'Provision Tenant'}
        </Button>
      </div>
    </form>
  );
}
