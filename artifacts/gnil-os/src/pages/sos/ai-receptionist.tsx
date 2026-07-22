import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import {
  useListSosCalls, useListSosMessages, useSimulateSosCall, useSendSosMessage,
  useGetSosSettings, useUpdateSosSettings, getGetSosSettingsQueryKey,
  getListSosCallsQueryKey, getListSosMessagesQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Bot, MessageSquare, Phone, Play, Send } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';

/**
 * Unified AI Receptionist view.
 *
 * One place for everything receptionist-related: configuration (enable
 * toggle + service names), the inbound-call simulator, the live call log,
 * and the SMS broadcast history with the manual-send control. Replaces the
 * old split between the Configuration page (setup) and the Marketing &
 * Comms page (live logs).
 */
export function AiReceptionistPage() {
  const { data: settings } = useGetSosSettings({
    query: { queryKey: getGetSosSettingsQueryKey() },
  });

  const update = useUpdateSosSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [aiReceptionistEnabled, setAiReceptionistEnabled] = useState(false);
  const [serviceNames, setServiceNames] = useState('');
  const initialized = useRef(false);

  useEffect(() => {
    if (settings && !initialized.current) {
      setAiReceptionistEnabled(settings.aiReceptionistEnabled);
      setServiceNames(settings.serviceNames || '');
      initialized.current = true;
    }
  }, [settings]);

  const save = (data: { aiReceptionistEnabled: boolean; serviceNames?: string }) => {
    update.mutate(
      { data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetSosSettingsQueryKey() });
          toast({ title: 'AI Receptionist settings saved' });
        },
        onError: () => {
          toast({
            title: "Couldn't save AI Receptionist settings",
            description: 'Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  // Inline enable from the disabled-state banner — no cross-page hop.
  const enableNow = () => {
    setAiReceptionistEnabled(true);
    save({ aiReceptionistEnabled: true });
  };

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6" data-testid="page-ai-receptionist">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">AI Receptionist</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure, test, and monitor the AI Receptionist — settings, call logs, and SMS
          broadcasts, all in one place.
        </p>
      </div>

      {settings && !settings.aiReceptionistEnabled && (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-400"
          data-testid="banner-ai-disabled"
        >
          <span>The AI Receptionist is currently disabled — new calls won't be answered.</span>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={enableNow}
            disabled={update.isPending}
            data-testid="button-enable-ai"
          >
            Enable now
          </Button>
        </div>
      )}

      {/* ── Configuration ─────────────────────────────────────────────── */}
      <Card id="ai-receptionist" className="scroll-mt-6" data-testid="section-ai-receptionist">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-primary" /> Configuration
            </CardTitle>
            <Badge
              variant={settings?.aiReceptionistEnabled ? 'default' : 'secondary'}
              data-testid="badge-ai-receptionist"
            >
              {settings?.aiReceptionistEnabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
          <CardDescription>Autonomous call handling for your business.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div className="space-y-0.5">
              <Label className="text-base">AI Receptionist</Label>
              <p className="text-sm text-muted-foreground">
                Automatically answer calls, take messages, and book appointments.
              </p>
            </div>
            <Switch
              checked={aiReceptionistEnabled}
              onCheckedChange={setAiReceptionistEnabled}
              data-testid="switch-ai-receptionist"
            />
          </div>
          <div className="grid gap-2">
            <Label>Service Names</Label>
            <Input
              value={serviceNames}
              onChange={(e) => setServiceNames(e.target.value)}
              placeholder="e.g. haircut, color, blowout"
              data-testid="input-service-names"
            />
            <p className="text-sm text-muted-foreground">
              Comma-separated list of your services. The receptionist uses these to recognize
              what callers are asking for.
            </p>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() => save({ aiReceptionistEnabled, serviceNames })}
              disabled={update.isPending}
              data-testid="button-save-ai-receptionist"
            >
              Save AI Receptionist
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Call log ──────────────────────────────────────────────────── */}
      <div className="space-y-4" data-testid="section-call-logs">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-semibold">Call Logs</h2>
          <SimulateCallDialog />
        </div>
        <CallLogList />
      </div>

      {/* ── SMS broadcast history ─────────────────────────────────────── */}
      <div className="space-y-4" data-testid="section-sms-history">
        {settings && settings.smsMode !== 'live' && (
          <div
            className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-400"
            data-testid="banner-sms-simulated"
          >
            <span>SMS is in simulated mode — messages are logged but not actually sent.</span>
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link href="/settings#sms">Go live in Configuration</Link>
            </Button>
          </div>
        )}
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-primary" /> SMS Broadcast History
          </h2>
          <SendSmsDialog />
        </div>
        <MessageLogList />
      </div>
    </div>
  );
}

function CallLogList() {
  const { data: calls } = useListSosCalls();

  return (
    <div className="space-y-3">
      {calls?.map(call => (
        <Card key={call.id} className="shadow-sm">
          <CardContent className="p-4 flex gap-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Phone className="h-5 w-5" />
            </div>
            <div className="flex-1 space-y-1">
              <div className="flex justify-between">
                <span className="font-semibold">{call.callerName || call.fromNumber}</span>
                <Badge variant={call.outcome === 'booked' ? 'default' : 'secondary'} className="capitalize">
                  {call.outcome.replace('_', ' ')}
                </Badge>
              </div>
              <div className="text-sm font-medium">Intent: {call.intent}</div>
              {call.transcriptSummary && (
                <div className="text-sm text-muted-foreground bg-muted p-2 rounded mt-2">
                  <span className="font-semibold text-foreground/70">Summary: </span>
                  {call.transcriptSummary}
                </div>
              )}
              <div className="text-xs text-muted-foreground mt-2">
                {new Date(call.createdAt).toLocaleString()}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
      {calls?.length === 0 && <div className="text-center py-12 text-muted-foreground">No calls logged.</div>}
    </div>
  );
}

function SimulateCallDialog() {
  const [open, setOpen] = useState(false);
  const [fromNumber, setFrom] = useState("+15550001111");
  const [callerName, setName] = useState("Jane Doe");
  const [inquiry, setInquiry] = useState("I'd like to book an appointment for tomorrow at 2pm.");
  const [result, setResult] = useState<any>(null);

  const simulate = useSimulateSosCall();
  const queryClient = useQueryClient();

  const handleRun = () => {
    simulate.mutate(
      { data: { fromNumber, callerName, inquiry } },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({ queryKey: getListSosCallsQueryKey() });
          setResult(res);
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if(!o) setResult(null); }}>
      <DialogTrigger asChild>
        <Button variant="outline"><Play className="w-4 h-4 mr-2"/> Simulate Inbound Call</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Simulate AI Call</DialogTitle>
          <DialogDescription>Test how the AI Receptionist handles specific inquiries.</DialogDescription>
        </DialogHeader>
        {!result ? (
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Caller Name</Label>
                <Input value={callerName} onChange={e => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Phone Number</Label>
                <Input value={fromNumber} onChange={e => setFrom(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Spoken Inquiry</Label>
              <Textarea rows={3} value={inquiry} onChange={e => setInquiry(e.target.value)} />
            </div>
            <Button className="w-full" onClick={handleRun} disabled={simulate.isPending}>
              {simulate.isPending ? 'Simulating...' : 'Run Simulation'}
            </Button>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <div className="bg-primary/5 border border-primary/20 p-4 rounded-lg space-y-3">
              <div className="flex justify-between items-center">
                <span className="font-semibold text-primary">Simulation Complete</span>
                <Badge>{result.outcome.replace('_', ' ')}</Badge>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Detected Intent</Label>
                <div className="text-sm font-medium">{result.intent}</div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">AI Transcript Summary</Label>
                <div className="text-sm italic text-foreground/80">{result.transcriptSummary}</div>
              </div>
            </div>
            <Button className="w-full" onClick={() => setOpen(false)}>Done</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MessageLogList() {
  // Poll while any outbound message is still awaiting a final delivery
  // status (Twilio confirms via status callback), so "sent" flips to
  // "delivered"/"failed" without a page reload.
  const { data: messages } = useListSosMessages(
    { limit: 50 },
    {
      query: {
        queryKey: getListSosMessagesQueryKey({ limit: 50 }),
        refetchInterval: (query) => {
          const rows = query.state.data;
          const hasNonFinal = rows?.some(
            (m) =>
              m.direction === 'outbound' &&
              (m.deliveryStatus === 'pending' || m.deliveryStatus === 'sent'),
          );
          return hasNonFinal ? 5000 : false;
        },
      },
    },
  );

  return (
    <div className="border rounded-lg overflow-x-auto">
      <table className="w-full text-sm text-left">
        <thead className="bg-muted/50 text-muted-foreground sticky top-0">
          <tr>
            <th className="px-4 py-3 font-medium">Direction</th>
            <th className="px-4 py-3 font-medium">Contact</th>
            <th className="px-4 py-3 font-medium">Message</th>
            <th className="px-4 py-3 font-medium">Type</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {messages?.map(msg => (
            <tr key={msg.id} className="hover:bg-muted/30">
              <td className="px-4 py-3">
                <Badge variant={msg.direction === 'inbound' ? 'default' : 'secondary'} className="text-[10px] capitalize">
                  {msg.direction === 'inbound' ? 'Inbound' : 'Outbound'}
                </Badge>
              </td>
              <td className="px-4 py-3 font-medium">{msg.customerName || msg.toNumber}</td>
              <td className="px-4 py-3 max-w-xs truncate" title={msg.body}>{msg.body}</td>
              <td className="px-4 py-3">
                <Badge variant="outline" className="text-[10px] capitalize">{msg.kind.replace('_', ' ')}</Badge>
              </td>
              <td className="px-4 py-3">
                <span
                  className={`text-xs ${msg.deliveryStatus === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
                  title={msg.deliveryStatus === 'failed' && msg.errorMessage ? `${msg.errorCode ? `[${msg.errorCode}] ` : ''}${msg.errorMessage}` : undefined}
                >
                  {msg.deliveryStatus}
                  {msg.deliveryStatus === 'failed' && msg.errorMessage && (
                    <span className="block max-w-[200px] truncate text-[10px] text-destructive/80">{msg.errorMessage}</span>
                  )}
                </span>
              </td>
              <td className="px-4 py-3 text-muted-foreground text-xs">
                {new Date(msg.createdAt).toLocaleString()}
              </td>
            </tr>
          ))}
          {messages?.length === 0 && (
            <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">No messages yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SendSmsDialog() {
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("1");
  const [body, setBody] = useState("");

  const send = useSendSosMessage();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSend = () => {
    send.mutate(
      { data: { customerId: parseInt(customerId), body, kind: 'manual' } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosMessagesQueryKey() });
          setOpen(false);
          toast({ title: 'Message queued for delivery' });
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Send className="w-4 h-4 mr-2"/> Send Manual SMS</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send SMS Message</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Customer ID</Label>
            <Input value={customerId} onChange={e => setCustomerId(e.target.value)} placeholder="e.g. 1" />
          </div>
          <div className="space-y-2">
            <Label>Message Content</Label>
            <Textarea rows={4} value={body} onChange={e => setBody(e.target.value)} placeholder="Type message..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSend} disabled={!body}>Send Message</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
