import { useState } from 'react';
import {
  useListGovernanceUsers,
  useCreateGovernanceUser,
  useUpdateGovernanceUser,
  useDeleteGovernanceUser,
  useRotateGovernanceUserToken,
  useListCoopApplications,
  useReviewCoopApplication,
  useListTenants,
  getListGovernanceUsersQueryKey,
  getListCoopApplicationsQueryKey,
  getListTenantsQueryKey,
  type GovernanceUser,
  type CoopApplicationRecord,
  type NetworkRole,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useSessionRole } from '@/hooks/useAuth';
import { Plus, KeyRound, Trash2, ShieldCheck, ClipboardCheck, Copy } from 'lucide-react';

const ROLE_LABELS: Record<NetworkRole, string> = {
  super_admin: 'Network Super-Admin',
  district_manager: 'District Co-Op Manager',
  merchant: 'Single-Store Merchant',
  staff: 'Staff Member',
};

const ROLE_BADGE: Record<NetworkRole, string> = {
  super_admin: 'bg-indigo-100 text-indigo-800',
  district_manager: 'bg-amber-100 text-amber-800',
  merchant: 'bg-emerald-100 text-emerald-800',
  staff: 'bg-slate-100 text-slate-700',
};

const APP_STATUS_BADGE: Record<string, string> = {
  submitted: 'bg-blue-100 text-blue-800',
  under_review: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-red-100 text-red-700',
};

export default function Governance() {
  const role = useSessionRole();

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500" data-testid="page-governance">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Network Governance</h1>
        <p className="text-muted-foreground mt-1">
          Roles and access across the co-op network, plus the join-application review queue.
        </p>
      </div>
      {role === 'super_admin' && <UsersSection />}
      <ApplicationsSection />
    </div>
  );
}

// ── Users & roles ────────────────────────────────────────────────────────────

function UsersSection() {
  const { data: users, isLoading } = useListGovernanceUsers();
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  return (
    <Card className="border-none shadow-md" data-testid="section-governance-users">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-muted-foreground" /> Network Users
          </CardTitle>
          <CardDescription>
            Create accounts and assign hierarchical roles. Scope controls which businesses each user can touch.
          </CardDescription>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2" data-testid="button-create-user">
              <Plus className="w-4 h-4" /> Create User
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Network User</DialogTitle>
              <DialogDescription>
                The login token is shown once — copy it and hand it to the user securely.
              </DialogDescription>
            </DialogHeader>
            <CreateUserForm onClose={() => setIsCreateOpen(false)} />
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-8 space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : !users?.length ? (
          <div className="p-10 text-center text-muted-foreground">No user accounts yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <UserRow key={u.id} user={u} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function UserRow({ user }: { user: GovernanceUser }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const deleteUser = useDeleteGovernanceUser();
  const rotateToken = useRotateGovernanceUserToken();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const isBootstrap = user.username === 'operator';

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListGovernanceUsersQueryKey() });

  return (
    <TableRow data-testid={`row-user-${user.id}`}>
      <TableCell>
        <div className="font-semibold">{user.username}</div>
        {isBootstrap && <div className="text-xs text-muted-foreground">Bootstrap operator (password login)</div>}
      </TableCell>
      <TableCell>
        <Badge className={`${ROLE_BADGE[user.role]} border-none`}>{ROLE_LABELS[user.role]}</Badge>
      </TableCell>
      <TableCell>
        {user.role === 'super_admin' ? (
          <span className="text-sm text-muted-foreground">All businesses</span>
        ) : user.tenants.length === 0 ? (
          <span className="text-sm text-muted-foreground">Unassigned</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {user.tenants.map((t) => (
              <Badge key={t.id} variant="outline">{t.name}</Badge>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell className="text-right space-x-1 whitespace-nowrap">
        {!isBootstrap && (
          <>
            <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" data-testid={`button-edit-user-${user.id}`}>Edit</Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Edit {user.username}</DialogTitle>
                  <DialogDescription>Change role or reassign scope.</DialogDescription>
                </DialogHeader>
                <EditUserForm user={user} onClose={() => setIsEditOpen(false)} />
              </DialogContent>
            </Dialog>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1"
              onClick={() =>
                rotateToken.mutate(
                  { id: user.id },
                  {
                    onSuccess: (res) => {
                      navigator.clipboard?.writeText(res.loginToken).catch(() => {});
                      toast({
                        title: 'New login token issued',
                        description: `${res.loginToken} (copied to clipboard — the old token no longer works)`,
                      });
                      invalidate();
                    },
                  },
                )
              }
              data-testid={`button-rotate-token-${user.id}`}
            >
              <KeyRound className="w-4 h-4" /> New token
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={() => {
                if (!confirm(`Delete ${user.username}? They will no longer be able to sign in.`)) return;
                deleteUser.mutate(
                  { id: user.id },
                  {
                    onSuccess: () => {
                      toast({ title: 'User deleted' });
                      invalidate();
                    },
                  },
                );
              }}
              data-testid={`button-delete-user-${user.id}`}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </>
        )}
      </TableCell>
    </TableRow>
  );
}

function TenantScopePicker({
  role,
  selected,
  onChange,
}: {
  role: NetworkRole;
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  const { data: tenants } = useListTenants({ query: { queryKey: getListTenantsQueryKey() } });
  if (role === 'super_admin') {
    return <p className="text-sm text-muted-foreground">Super-admins manage every business — no scope needed.</p>;
  }
  const single = role !== 'district_manager';
  return (
    <div className="space-y-2">
      <Label>{single ? 'Business' : 'Assigned businesses'}</Label>
      {single ? (
        <Select
          value={selected[0] != null ? String(selected[0]) : undefined}
          onValueChange={(v) => onChange([Number(v)])}
        >
          <SelectTrigger data-testid="select-scope-tenant">
            <SelectValue placeholder="Pick a business" />
          </SelectTrigger>
          <SelectContent>
            {(tenants ?? []).map((t) => (
              <SelectItem key={t.id} value={String(t.id)}>{t.brandName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className="max-h-48 overflow-y-auto rounded border p-2 space-y-1">
          {(tenants ?? []).map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(t.id)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...selected, t.id] : selected.filter((id) => id !== t.id))
                }
                data-testid={`checkbox-scope-tenant-${t.id}`}
              />
              {t.brandName}
            </label>
          ))}
          {!tenants?.length && <p className="text-sm text-muted-foreground p-2">No businesses yet.</p>}
        </div>
      )}
    </div>
  );
}

function CreateUserForm({ onClose }: { onClose: () => void }) {
  const createUser = useCreateGovernanceUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<NetworkRole>('merchant');
  const [tenantIds, setTenantIds] = useState<number[]>([]);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  if (issuedToken) {
    return (
      <div className="space-y-4 mt-2" data-testid="created-user-token">
        <p className="text-sm">
          Account created. This login token is shown <strong>only once</strong>:
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 bg-muted rounded px-3 py-2 text-xs break-all">{issuedToken}</code>
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              navigator.clipboard?.writeText(issuedToken).catch(() => {});
              toast({ title: 'Copied' });
            }}
          >
            <Copy className="w-4 h-4" />
          </Button>
        </div>
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-4 mt-2"
      onSubmit={(e) => {
        e.preventDefault();
        createUser.mutate(
          { data: { username, role, tenantIds } },
          {
            onSuccess: (res) => {
              queryClient.invalidateQueries({ queryKey: getListGovernanceUsersQueryKey() });
              setIssuedToken(res.loginToken);
            },
            onError: (err: unknown) => {
              const msg = (err as { data?: { error?: string } })?.data?.error ?? 'Could not create the user.';
              toast({ title: 'Create failed', description: msg, variant: 'destructive' });
            },
          },
        );
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="gov-username">Username</Label>
        <Input
          id="gov-username"
          required
          minLength={2}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="jane.doe"
          data-testid="input-username"
        />
      </div>
      <div className="space-y-2">
        <Label>Role</Label>
        <Select value={role} onValueChange={(v) => { setRole(v as NetworkRole); setTenantIds([]); }}>
          <SelectTrigger data-testid="select-role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ROLE_LABELS) as NetworkRole[]).map((r) => (
              <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <TenantScopePicker role={role} selected={tenantIds} onChange={setTenantIds} />
      <div className="pt-2 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={createUser.isPending} data-testid="button-submit-create-user">
          {createUser.isPending ? 'Creating…' : 'Create User'}
        </Button>
      </div>
    </form>
  );
}

function EditUserForm({ user, onClose }: { user: GovernanceUser; onClose: () => void }) {
  const updateUser = useUpdateGovernanceUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [role, setRole] = useState<NetworkRole>(user.role);
  const [tenantIds, setTenantIds] = useState<number[]>(user.tenants.map((t) => t.id));

  return (
    <form
      className="space-y-4 mt-2"
      onSubmit={(e) => {
        e.preventDefault();
        updateUser.mutate(
          { id: user.id, data: { role, tenantIds } },
          {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: getListGovernanceUsersQueryKey() });
              toast({ title: 'User updated' });
              onClose();
            },
            onError: (err: unknown) => {
              const msg = (err as { data?: { error?: string } })?.data?.error ?? 'Could not update the user.';
              toast({ title: 'Update failed', description: msg, variant: 'destructive' });
            },
          },
        );
      }}
    >
      <div className="space-y-2">
        <Label>Role</Label>
        <Select value={role} onValueChange={(v) => setRole(v as NetworkRole)}>
          <SelectTrigger data-testid="select-edit-role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ROLE_LABELS) as NetworkRole[]).map((r) => (
              <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <TenantScopePicker role={role} selected={tenantIds} onChange={setTenantIds} />
      <div className="pt-2 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={updateUser.isPending} data-testid="button-submit-edit-user">
          {updateUser.isPending ? 'Saving…' : 'Save Changes'}
        </Button>
      </div>
    </form>
  );
}

// ── Application review queue ─────────────────────────────────────────────────

function ApplicationsSection() {
  const { data: applications, isLoading } = useListCoopApplications();

  return (
    <Card className="border-none shadow-md" data-testid="section-applications">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardCheck className="w-5 h-5 text-muted-foreground" /> Join Applications
        </CardTitle>
        <CardDescription>
          Businesses applying to join the co-op network. Approving an application provisions the tenant automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-8 space-y-3">{[1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : !applications?.length ? (
          <div className="p-10 text-center text-muted-foreground" data-testid="empty-applications">
            No applications yet. Send businesses to the public application page: <code>/apply</code>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>Business</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {applications.map((a) => (
                <ApplicationRow key={a.id} app={a} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ApplicationRow({ app }: { app: CoopApplicationRecord }) {
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const decided = app.status === 'approved' || app.status === 'rejected';

  return (
    <TableRow data-testid={`row-application-${app.id}`}>
      <TableCell>
        <div className="font-semibold">{app.businessName}</div>
        <div className="text-xs font-mono text-muted-foreground">{app.subdomain}.gnil.os</div>
      </TableCell>
      <TableCell>
        <div className="text-sm">{app.contactName || 'N/A'}</div>
        <div className="text-xs text-muted-foreground">{app.contactEmail || 'N/A'}</div>
      </TableCell>
      <TableCell className="text-sm">{app.category || '—'}</TableCell>
      <TableCell>
        <Badge className={`${APP_STATUS_BADGE[app.status]} border-none capitalize`} data-testid={`status-application-${app.id}`}>
          {app.status.replace('_', ' ')}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        <Dialog open={isReviewOpen} onOpenChange={setIsReviewOpen}>
          <DialogTrigger asChild>
            <Button variant={decided ? 'ghost' : 'outline'} size="sm" data-testid={`button-review-application-${app.id}`}>
              {decided ? 'View' : 'Review'}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{app.businessName}</DialogTitle>
              <DialogDescription>Applied {new Date(app.createdAt).toLocaleDateString()}</DialogDescription>
            </DialogHeader>
            <ReviewApplicationForm app={app} onClose={() => setIsReviewOpen(false)} />
          </DialogContent>
        </Dialog>
      </TableCell>
    </TableRow>
  );
}

function ReviewApplicationForm({ app, onClose }: { app: CoopApplicationRecord; onClose: () => void }) {
  const review = useReviewCoopApplication();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [notes, setNotes] = useState(app.reviewNotes ?? '');
  const [rejectionReason, setRejectionReason] = useState(app.rejectionReason ?? '');
  const decided = app.status === 'approved' || app.status === 'rejected';

  const submit = (status?: 'under_review' | 'approved' | 'rejected') => {
    review.mutate(
      {
        id: app.id,
        data: {
          ...(status ? { status } : {}),
          reviewNotes: notes,
          ...(status === 'rejected' ? { rejectionReason } : {}),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCoopApplicationsQueryKey() });
          if (status === 'approved') {
            queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() });
            toast({ title: 'Application approved', description: `${app.businessName} has been provisioned as a tenant.` });
          } else if (status === 'rejected') {
            toast({ title: 'Application rejected' });
          } else {
            toast({ title: 'Saved' });
          }
          onClose();
        },
        onError: (err: unknown) => {
          const msg = (err as { data?: { error?: string } })?.data?.error ?? 'Could not update the application.';
          toast({ title: 'Update failed', description: msg, variant: 'destructive' });
        },
      },
    );
  };

  return (
    <div className="space-y-4 mt-2">
      {app.pitch && (
        <div className="space-y-1">
          <Label>Applicant's pitch</Label>
          <p className="text-sm bg-muted rounded p-3 whitespace-pre-wrap">{app.pitch}</p>
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="review-notes">Verification / vetting notes (internal)</Label>
        <Textarea
          id="review-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          disabled={decided}
          placeholder="License checked, storefront verified…"
          data-testid="input-review-notes"
        />
      </div>
      {!decided && (
        <div className="space-y-2">
          <Label htmlFor="rejection-reason">Rejection reason (shown to the applicant if rejected)</Label>
          <Textarea
            id="rejection-reason"
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value)}
            rows={2}
            data-testid="input-rejection-reason"
          />
        </div>
      )}
      {decided ? (
        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      ) : (
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          {app.status === 'submitted' && (
            <Button variant="outline" disabled={review.isPending} onClick={() => submit('under_review')} data-testid="button-mark-under-review">
              Mark Under Review
            </Button>
          )}
          <Button
            variant="outline"
            className="text-destructive"
            disabled={review.isPending || !rejectionReason.trim()}
            onClick={() => submit('rejected')}
            data-testid="button-reject-application"
          >
            Reject
          </Button>
          <Button disabled={review.isPending} onClick={() => submit('approved')} data-testid="button-approve-application">
            {review.isPending ? 'Working…' : 'Approve & Provision'}
          </Button>
        </div>
      )}
    </div>
  );
}
