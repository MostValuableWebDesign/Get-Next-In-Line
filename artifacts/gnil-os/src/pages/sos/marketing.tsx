import React, { useState } from 'react';
import { 
  useListSosCalls, useListSosMessages, useSimulateSosCall, useSendSosMessage,
  getListSosCallsQueryKey, getListSosMessagesQueryKey
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Phone, MessageSquare, Bot, Play, Send } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from '@/components/ui/dialog';

export function MarketingPage() {
  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 h-full flex flex-col">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Communications</h1>
        <p className="text-muted-foreground text-sm mt-1">AI Receptionist logs and SMS Broadcasts.</p>
      </div>

      <Tabs defaultValue="receptionist" className="flex-1 flex flex-col min-h-0">
        <TabsList className="w-[400px]">
          <TabsTrigger value="receptionist" className="flex-1"><Bot className="w-4 h-4 mr-2"/> AI Receptionist</TabsTrigger>
          <TabsTrigger value="sms" className="flex-1"><MessageSquare className="w-4 h-4 mr-2"/> SMS Broadcasts</TabsTrigger>
        </TabsList>
        
        <TabsContent value="receptionist" className="flex-1 flex flex-col min-h-0 mt-4 space-y-4">
          <div className="flex justify-between items-center shrink-0">
            <h2 className="text-xl font-semibold">Call Logs</h2>
            <SimulateCallDialog />
          </div>
          <CallLogList />
        </TabsContent>

        <TabsContent value="sms" className="flex-1 flex flex-col min-h-0 mt-4 space-y-4">
          <div className="flex justify-between items-center shrink-0">
            <h2 className="text-xl font-semibold">Message History</h2>
            <SendSmsDialog />
          </div>
          <MessageLogList />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CallLogList() {
  const { data: calls } = useListSosCalls();

  return (
    <div className="flex-1 overflow-y-auto space-y-3">
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
  const { data: messages } = useListSosMessages({ limit: 50 });

  return (
    <div className="flex-1 overflow-y-auto border rounded-lg">
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
