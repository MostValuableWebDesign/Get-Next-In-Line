import { useMemo, useState } from 'react';
import {
  useListSafetyIncidents, getListSafetyIncidentsQueryKey,
  useCreateSafetyIncident, useCreateSafetyIncidentUpdate,
  useAcknowledgeSafetyIncident, useResolveSafetyIncident,
  useGetSafetyIncidentTimeline, getGetSafetyIncidentTimelineQueryKey,
  useListSafetyContacts, getListSafetyContactsQueryKey,
  useCreateSafetyContact, useUpdateSafetyContact, useDeleteSafetyContact,
  useListSafetyTemplates, getListSafetyTemplatesQueryKey,
  useCreateSafetyTemplate, useUpdateSafetyTemplate, useDeleteSafetyTemplate,
  type SafetyIncident, type SafetyEmergencyContact, type SafetyBroadcastTemplate,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  AlertTriangle, Check, CheckCircle2, Clock, History, MapPin, MessageSquarePlus,
  Pencil, Phone, Plus, ShieldAlert, Siren, Trash2, X,
} from 'lucide-react';

/**
 * Safety Alerts — Co-Op Emergency & Safety Alert Network (Business Bookings tab).
 *
 * Silent by design: no sounds or flashing animations. A raised alert is
 * broadcast to every accepted, active co-op partner; partners see it here via
 * fast polling and get an SMS notification (simulated without Twilio).
 */

const INCIDENT_TYPES = [
  { value: 'silent_panic', label: 'Silent panic' },
  { value: 'suspicious_activity', label: 'Suspicious activity' },
  { value: 'safety_hazard', label: 'Safety hazard' },
  { value: 'medical_emergency', label: 'Medical emergency' },
  { value: 'severe_weather', label: 'Severe weather' },
] as const;

const typeLabel = (v: string) => INCIDENT_TYPES.find(t => t.value === v)?.label ?? v;

const CONTACT_CATEGORIES = [
  { value: 'law_enforcement', label: 'Law enforcement' },
  { value: 'medical', label: 'Medical' },
  { value: 'property_management', label: 'Property management' },
  { value: 'other', label: 'Other' },
] as const;

// Partners must see new incidents "within seconds" — poll fast while mounted.
const POLL_MS = 5000;

export function SafetyAlertsContent({ tenantId }: { tenantId: number | null }) {
  if (tenantId == null) {
    return (
      <Card className="border-dashed shadow-none">
        <CardContent className="p-10 text-center text-muted-foreground" data-testid="text-safety-pick-business">
          Select a specific business above to use Safety Alerts.
        </CardContent>
      </Card>
    );
  }
  return <SafetyAlertsInner key={tenantId} tenantId={tenantId} />;
}

function SafetyAlertsInner({ tenantId }: { tenantId: number }) {
  const { data: incidents, isLoading } = useListSafetyIncidents({
    query: {
      queryKey: getListSafetyIncidentsQueryKey(),
      refetchInterval: POLL_MS,
    },
  });

  const active = (incidents ?? []).filter(i => i.status === 'active');
  const resolved = (incidents ?? []).filter(i => i.status === 'resolved');

  return (
    <div className="space-y-6" data-testid="safety-alerts-hub">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-destructive" /> Safety Alerts
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Silently alert your accepted co-op partners to emergencies and local safety incidents.
            Partners are notified in-app and by text.
          </p>
        </div>
        <RaiseAlertDialog tenantId={tenantId} />
      </div>

      {isLoading ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : (
        <div className="grid lg:grid-cols-2 gap-6 items-start">
          <div className="space-y-6">
            <Card data-testid="card-safety-active-incidents">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-destructive" /> Active Incidents
                  {active.length > 0 && <Badge variant="destructive" data-testid="badge-active-incident-count">{active.length}</Badge>}
                </CardTitle>
                <CardDescription>Raised by you or received from co-op partners. Updates refresh automatically.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {active.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="text-no-active-incidents">
                    No active incidents. Stay safe out there.
                  </p>
                ) : (
                  active.map(i => <IncidentRow key={i.id} incident={i} />)
                )}
              </CardContent>
            </Card>

            <Card data-testid="card-safety-incident-history">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2 text-muted-foreground">
                  <History className="w-4 h-4" /> Incident History
                </CardTitle>
                <CardDescription>Resolved incidents with their full audit trail.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {resolved.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="text-no-incident-history">
                    No resolved incidents yet.
                  </p>
                ) : (
                  resolved.slice(0, 25).map(i => <IncidentRow key={i.id} incident={i} muted />)
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <EmergencyContactsPanel />
            <TemplatesPanel />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Raise alert composer ─────────────────────────────────────────────────────

function RaiseAlertDialog({ tenantId: _tenantId }: { tenantId: number }) {
  const [open, setOpen] = useState(false);
  const [incidentType, setIncidentType] = useState<string>('silent_panic');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [templateId, setTemplateId] = useState<string>('none');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateSafetyIncident();
  const { data: templates } = useListSafetyTemplates({
    query: { queryKey: getListSafetyTemplatesQueryKey(), enabled: open },
  });

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    if (id === 'none') return;
    const t = (templates ?? []).find(x => String(x.id) === id);
    if (t) {
      setIncidentType(t.incidentType);
      setDescription(t.body);
    }
  };

  const reset = () => {
    setIncidentType('silent_panic');
    setDescription('');
    setLocation('');
    setTemplateId('none');
  };

  const submit = () => {
    create.mutate(
      { data: { incidentType: incidentType as never, description: description.trim(), location: location.trim() || null } },
      {
        onSuccess: (created) => {
          queryClient.invalidateQueries({ queryKey: getListSafetyIncidentsQueryKey() });
          setOpen(false);
          reset();
          toast({
            title: 'Alert broadcast',
            description: created.recipientCount > 0
              ? `Silently notified ${created.recipientCount} partner business${created.recipientCount === 1 ? '' : 'es'}.`
              : 'No accepted co-op partners to notify yet — the incident is still logged.',
          });
        },
        onError: (err: unknown) => {
          const e = err as { data?: { message?: string }; message?: string };
          toast({ title: 'Could not raise the alert', description: e?.data?.message ?? e?.message ?? 'Please try again.', variant: 'destructive' });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) reset(); }}>
      <Button
        variant="destructive"
        size="lg"
        className="gap-2 font-semibold"
        onClick={() => setOpen(true)}
        data-testid="button-raise-safety-alert"
      >
        <Siren className="w-5 h-5" /> Raise Safety Alert
      </Button>
      <DialogContent data-testid="dialog-raise-safety-alert">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-destructive" /> Raise a Safety Alert
          </DialogTitle>
          <DialogDescription>
            Broadcast silently to all accepted co-op partners. No sounds, no sirens — partners see it
            in their Safety Alerts view and get a discreet text.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Start from a template (optional)</Label>
            <Select value={templateId} onValueChange={applyTemplate}>
              <SelectTrigger data-testid="select-alert-template">
                <SelectValue placeholder="No template" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No template</SelectItem>
                {(templates ?? []).map(t => (
                  <SelectItem key={t.id} value={String(t.id)} data-testid={`option-alert-template-${t.id}`}>
                    {t.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Incident type</Label>
            <Select value={incidentType} onValueChange={setIncidentType}>
              <SelectTrigger data-testid="select-incident-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INCIDENT_TYPES.map(t => (
                  <SelectItem key={t.value} value={t.value} data-testid={`option-incident-type-${t.value}`}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>What's happening?</Label>
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Brief description partners will see (encrypted at rest)…"
              rows={3}
              data-testid="input-incident-description"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Location (optional)</Label>
            <Input
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="e.g. Front entrance, 4th & Main"
              data-testid="input-incident-location"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} data-testid="button-cancel-alert">Cancel</Button>
          <Button
            variant="destructive"
            className="gap-1.5"
            disabled={create.isPending || description.trim().length === 0}
            onClick={submit}
            data-testid="button-broadcast-alert"
          >
            <Siren className="w-4 h-4" /> Broadcast Alert
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Incident row + actions ───────────────────────────────────────────────────

function IncidentRow({ incident, muted = false }: { incident: SafetyIncident; muted?: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const acknowledge = useAcknowledgeSafetyIncident();
  const resolve = useResolveSafetyIncident();
  const [updateOpen, setUpdateOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListSafetyIncidentsQueryKey() });
  const onError = (title: string) => (err: unknown) => {
    const e = err as { data?: { message?: string }; message?: string };
    toast({ title, description: e?.data?.message ?? e?.message ?? 'Please try again.', variant: 'destructive' });
  };

  const isRaised = incident.direction === 'raised';
  const activeIncident = incident.status === 'active';

  return (
    <div
      className={`border rounded-lg p-3 space-y-2 ${muted ? 'opacity-70' : ''} ${activeIncident && !isRaised ? 'border-destructive/40 bg-destructive/5' : ''}`}
      data-testid={`row-safety-incident-${incident.id}`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant={activeIncident ? 'destructive' : 'outline'} data-testid={`badge-incident-type-${incident.id}`}>
          {typeLabel(incident.incidentType)}
        </Badge>
        <Badge variant="secondary">{isRaised ? 'Raised by you' : `From ${incident.tenantName}`}</Badge>
        {incident.status === 'resolved' ? (
          <Badge variant="outline" className="ml-auto gap-1"><CheckCircle2 className="w-3 h-3" /> Resolved</Badge>
        ) : (
          <Badge variant="outline" className="ml-auto gap-1 border-amber-500/50 text-amber-600"><Clock className="w-3 h-3" /> Active</Badge>
        )}
      </div>
      <p className="text-sm" data-testid={`text-incident-description-${incident.id}`}>{incident.description}</p>
      {incident.location && (
        <div className="text-xs text-muted-foreground flex items-center gap-1" data-testid={`text-incident-location-${incident.id}`}>
          <MapPin className="w-3 h-3" /> {incident.location}
        </div>
      )}
      <div className="text-xs text-muted-foreground">
        {new Date(incident.createdAt).toLocaleString()}
        {isRaised && incident.recipientCount > 0 && (
          <> · {incident.acknowledgedCount}/{incident.recipientCount} partner{incident.recipientCount === 1 ? '' : 's'} acknowledged</>
        )}
        {!isRaised && incident.acknowledgedAt && <> · acknowledged</>}
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        {!isRaised && activeIncident && !incident.acknowledgedAt && (
          <Button
            size="sm"
            className="gap-1.5"
            disabled={acknowledge.isPending}
            onClick={() => acknowledge.mutate({ id: incident.id }, { onSuccess: refresh, onError: onError('Could not acknowledge') })}
            data-testid={`button-acknowledge-incident-${incident.id}`}
          >
            <Check className="w-3.5 h-3.5" /> Acknowledge
          </Button>
        )}
        {isRaised && activeIncident && (
          <>
            <PostUpdateDialog incidentId={incident.id} open={updateOpen} setOpen={setUpdateOpen} />
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ id: incident.id }, {
                onSuccess: () => { refresh(); toast({ title: 'Incident resolved', description: 'Partners will see the all-clear.' }); },
                onError: onError('Could not resolve'),
              })}
              data-testid={`button-resolve-incident-${incident.id}`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" /> Mark Resolved
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5"
          onClick={() => setTimelineOpen(true)}
          data-testid={`button-incident-timeline-${incident.id}`}
        >
          <History className="w-3.5 h-3.5" /> Audit Trail
        </Button>
      </div>
      <TimelineDialog incidentId={incident.id} open={timelineOpen} setOpen={setTimelineOpen} />
    </div>
  );
}

function PostUpdateDialog({ incidentId, open, setOpen }: { incidentId: number; open: boolean; setOpen: (o: boolean) => void }) {
  const [body, setBody] = useState('');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const post = useCreateSafetyIncidentUpdate();

  const submit = () => {
    post.mutate(
      { id: incidentId, data: { body: body.trim() } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSafetyIncidentsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetSafetyIncidentTimelineQueryKey(incidentId) });
          setOpen(false);
          setBody('');
          toast({ title: 'Update posted', description: 'Partners will see it on their next refresh.' });
        },
        onError: (err: unknown) => {
          const e = err as { data?: { message?: string }; message?: string };
          toast({ title: 'Could not post update', description: e?.data?.message ?? e?.message ?? 'Please try again.', variant: 'destructive' });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setOpen(true)} data-testid={`button-post-update-${incidentId}`}>
        <MessageSquarePlus className="w-3.5 h-3.5" /> Post Update
      </Button>
      <DialogContent data-testid="dialog-post-incident-update">
        <DialogHeader>
          <DialogTitle>Post a Status Update</DialogTitle>
          <DialogDescription>Partners watching this incident will see it in the feed and audit trail.</DialogDescription>
        </DialogHeader>
        <Textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="e.g. Police have arrived, situation contained…"
          rows={3}
          data-testid="input-update-body"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={post.isPending || body.trim().length === 0} onClick={submit} data-testid="button-submit-update">
            Post Update
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TimelineDialog({ incidentId, open, setOpen }: { incidentId: number; open: boolean; setOpen: (o: boolean) => void }) {
  const { data: timeline, isLoading } = useGetSafetyIncidentTimeline(incidentId, {
    query: { queryKey: getGetSafetyIncidentTimelineQueryKey(incidentId), enabled: open },
  });
  const kindLabel: Record<string, string> = {
    broadcast: 'Alert broadcast',
    update: 'Status update',
    acknowledgment: 'Acknowledged',
    resolution: 'Resolved',
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-testid="dialog-incident-timeline">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><History className="w-4 h-4" /> Incident Audit Trail</DialogTitle>
          <DialogDescription>Every broadcast, update, acknowledgment, and resolution with timestamps.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
            {(timeline ?? []).map(e => (
              <div key={e.id} className="border-l-2 pl-3 space-y-0.5" data-testid={`timeline-entry-${e.id}`}>
                <div className="text-sm font-medium">
                  {kindLabel[e.kind] ?? e.kind} — {e.actorTenantName}
                </div>
                {e.body && <div className="text-sm text-muted-foreground">{e.body}</div>}
                <div className="text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Emergency contacts panel ─────────────────────────────────────────────────

function EmergencyContactsPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: contacts, isLoading } = useListSafetyContacts({
    query: { queryKey: getListSafetyContactsQueryKey() },
  });
  const createContact = useCreateSafetyContact();
  const updateContact = useUpdateSafetyContact();
  const deleteContact = useDeleteSafetyContact();
  const [editing, setEditing] = useState<SafetyEmergencyContact | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [phone, setPhone] = useState('');
  const [category, setCategory] = useState('other');

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListSafetyContactsQueryKey() });
  const openEditor = (c: SafetyEmergencyContact | null) => {
    setEditing(c);
    setAdding(c == null);
    setLabel(c?.label ?? '');
    setPhone(c?.phone ?? '');
    setCategory(c?.category ?? 'other');
  };
  const closeEditor = () => { setEditing(null); setAdding(false); };

  const save = () => {
    const onError = (err: unknown) => {
      const e = err as { data?: { message?: string }; message?: string };
      toast({ title: 'Could not save contact', description: e?.data?.message ?? e?.message ?? 'Please try again.', variant: 'destructive' });
    };
    if (editing) {
      updateContact.mutate(
        { id: editing.id, data: { label: label.trim(), phone: phone.trim(), category: category as never } },
        { onSuccess: () => { refresh(); closeEditor(); }, onError },
      );
    } else {
      createContact.mutate(
        { data: { label: label.trim(), phone: phone.trim(), category: category as never } },
        { onSuccess: () => { refresh(); closeEditor(); }, onError },
      );
    }
  };

  return (
    <Card data-testid="card-emergency-contacts">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Phone className="w-4 h-4 text-primary" /> Emergency Contacts
        </CardTitle>
        <CardDescription>One-touch dialing for the numbers that matter in a crisis.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          (contacts ?? []).map(c => (
            <div key={c.id} className="border rounded-lg p-3 flex items-center gap-3" data-testid={`row-emergency-contact-${c.id}`}>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{c.label}</div>
                <div className="text-xs text-muted-foreground">
                  {CONTACT_CATEGORIES.find(x => x.value === c.category)?.label ?? c.category}
                </div>
              </div>
              {c.phone ? (
                <Button asChild size="sm" className="gap-1.5 shrink-0" data-testid={`button-dial-contact-${c.id}`}>
                  <a href={`tel:${c.phone}`}><Phone className="w-3.5 h-3.5" /> {c.phone}</a>
                </Button>
              ) : (
                <Badge variant="outline" className="shrink-0">No number yet</Badge>
              )}
              <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => openEditor(c)} data-testid={`button-edit-contact-${c.id}`}>
                <Pencil className="w-3.5 h-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0 text-destructive"
                onClick={() => deleteContact.mutate({ id: c.id }, { onSuccess: refresh })}
                data-testid={`button-delete-contact-${c.id}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))
        )}
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => openEditor(null)} data-testid="button-add-contact">
          <Plus className="w-3.5 h-3.5" /> Add Contact
        </Button>

        <Dialog open={adding || editing != null} onOpenChange={o => { if (!o) closeEditor(); }}>
          <DialogContent data-testid="dialog-edit-contact">
            <DialogHeader>
              <DialogTitle>{editing ? 'Edit Contact' : 'Add Emergency Contact'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Label</Label>
                <Input value={label} onChange={e => setLabel(e.target.value)} data-testid="input-contact-label" />
              </div>
              <div className="space-y-1.5">
                <Label>Phone</Label>
                <Input value={phone} onChange={e => setPhone(e.target.value)} placeholder="e.g. 911 or (555) 123-4567" data-testid="input-contact-phone" />
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger data-testid="select-contact-category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONTACT_CATEGORIES.map(c => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={closeEditor}>Cancel</Button>
              <Button
                disabled={label.trim().length === 0 || phone.trim().length === 0 || createContact.isPending || updateContact.isPending}
                onClick={save}
                data-testid="button-save-contact"
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

// ── Broadcast templates panel ────────────────────────────────────────────────

function TemplatesPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: templates, isLoading } = useListSafetyTemplates({
    query: { queryKey: getListSafetyTemplatesQueryKey() },
  });
  const createTemplate = useCreateSafetyTemplate();
  const updateTemplate = useUpdateSafetyTemplate();
  const deleteTemplate = useDeleteSafetyTemplate();
  const [editing, setEditing] = useState<SafetyBroadcastTemplate | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [incidentType, setIncidentType] = useState('silent_panic');
  const [body, setBody] = useState('');

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListSafetyTemplatesQueryKey() });
  const openEditor = (t: SafetyBroadcastTemplate | null) => {
    setEditing(t);
    setAdding(t == null);
    setTitle(t?.title ?? '');
    setIncidentType(t?.incidentType ?? 'silent_panic');
    setBody(t?.body ?? '');
  };
  const closeEditor = () => { setEditing(null); setAdding(false); };

  const save = () => {
    const onError = (err: unknown) => {
      const e = err as { data?: { message?: string }; message?: string };
      toast({ title: 'Could not save template', description: e?.data?.message ?? e?.message ?? 'Please try again.', variant: 'destructive' });
    };
    if (editing) {
      updateTemplate.mutate(
        { id: editing.id, data: { title: title.trim(), incidentType: incidentType as never, body: body.trim() } },
        { onSuccess: () => { refresh(); closeEditor(); }, onError },
      );
    } else {
      createTemplate.mutate(
        { data: { title: title.trim(), incidentType: incidentType as never, body: body.trim() } },
        { onSuccess: () => { refresh(); closeEditor(); }, onError },
      );
    }
  };

  return (
    <Card data-testid="card-broadcast-templates">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquarePlus className="w-4 h-4 text-primary" /> Broadcast Templates
        </CardTitle>
        <CardDescription>Pre-written messages that pre-fill the alert composer.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          (templates ?? []).map(t => (
            <div key={t.id} className="border rounded-lg p-3 flex items-start gap-3" data-testid={`row-broadcast-template-${t.id}`}>
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="text-sm font-medium truncate">{t.title}</div>
                <Badge variant="outline" className="text-[10px]">{typeLabel(t.incidentType)}</Badge>
                <p className="text-xs text-muted-foreground line-clamp-2">{t.body}</p>
              </div>
              <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => openEditor(t)} data-testid={`button-edit-template-${t.id}`}>
                <Pencil className="w-3.5 h-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0 text-destructive"
                onClick={() => deleteTemplate.mutate({ id: t.id }, { onSuccess: refresh })}
                data-testid={`button-delete-template-${t.id}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))
        )}
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => openEditor(null)} data-testid="button-add-template">
          <Plus className="w-3.5 h-3.5" /> Add Template
        </Button>

        <Dialog open={adding || editing != null} onOpenChange={o => { if (!o) closeEditor(); }}>
          <DialogContent data-testid="dialog-edit-template">
            <DialogHeader>
              <DialogTitle>{editing ? 'Edit Template' : 'Add Broadcast Template'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Title</Label>
                <Input value={title} onChange={e => setTitle(e.target.value)} data-testid="input-template-title" />
              </div>
              <div className="space-y-1.5">
                <Label>Incident type</Label>
                <Select value={incidentType} onValueChange={setIncidentType}>
                  <SelectTrigger data-testid="select-template-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {INCIDENT_TYPES.map(t => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Message</Label>
                <Textarea value={body} onChange={e => setBody(e.target.value)} rows={3} data-testid="input-template-body" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={closeEditor}>Cancel</Button>
              <Button
                disabled={title.trim().length === 0 || body.trim().length === 0 || createTemplate.isPending || updateTemplate.isPending}
                onClick={save}
                data-testid="button-save-template"
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
