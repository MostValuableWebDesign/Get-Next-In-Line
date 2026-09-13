import React, { useMemo, useState } from 'react';
import {
  useListSosMessages, useSendSosMessage, useListSosCustomers,
  getListSosMessagesQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { MessageStatusBadge } from '@/components/message-history';
import { AlertTriangle, MessageSquare, Send } from 'lucide-react';

/**
 * Two-way SMS conversations, grouped per customer.
 *
 * Turns the flat message log into usable threads: pick a customer on the
 * left, read the inbound/outbound exchange as chat bubbles, and reply in
 * place. Replies go through the existing sendSosMessage flow (kind
 * "manual") and respect the customer's SMS opt-in — the reply box is
 * disabled for opted-out customers and the server enforces it too.
 *
 * Messages that can't be matched to a customer (unknown inbound numbers)
 * are grouped by phone number and shown read-only.
 *
 * Business context is resolved automatically by the API.
 */

const CONVERSATION_FETCH_LIMIT = 200;

interface ThreadMessage {
  id: number;
  direction: 'inbound' | 'outbound';
  body: string;
  kind: string;
  deliveryStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

interface Thread {
  key: string;
  customerId: number | null;
  title: string;
  messages: ThreadMessage[]; // oldest → newest
  lastAt: string;
}

/**
 * A thread needs attention when its most recent outbound text failed or was
 * skipped; a newer successful outbound clears the flag.
 */
function threadNeedsAttention(t: Thread): boolean {
  const lastOutbound = [...t.messages].reverse().find((m) => m.direction === 'outbound');
  return (
    lastOutbound != null &&
    (lastOutbound.deliveryStatus === 'failed' || lastOutbound.deliveryStatus === 'skipped')
  );
}

export function SmsConversations() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: messages } = useListSosMessages({ limit: CONVERSATION_FETCH_LIMIT });
  const { data: customers } = useListSosCustomers();
  const send = useSendSosMessage();

  const threads = useMemo<Thread[]>(() => {
    if (!messages) return [];
    const byKey = new Map<string, Thread>();
    // API returns newest first; walk in reverse so threads read oldest → newest.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const key = m.customerId != null ? `c:${m.customerId}` : `p:${m.toNumber ?? 'unknown'}`;
      let t = byKey.get(key);
      if (!t) {
        t = {
          key,
          customerId: m.customerId ?? null,
          title: m.customerName || m.toNumber || 'Unknown number',
          messages: [],
          lastAt: m.createdAt,
        };
        byKey.set(key, t);
      }
      if (m.customerName) t.title = m.customerName;
      t.messages.push({
        id: m.id,
        direction: m.direction as 'inbound' | 'outbound',
        body: m.body,
        kind: m.kind,
        deliveryStatus: m.deliveryStatus,
        errorCode: m.errorCode ?? null,
        errorMessage: m.errorMessage ?? null,
        createdAt: m.createdAt,
      });
      t.lastAt = m.createdAt;
    }
    return Array.from(byKey.values()).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }, [messages]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // "Needs attention" filter: show only threads whose latest outbound text
  // failed or was skipped, so staff can triage delivery failures instantly.
  const [attentionOnly, setAttentionOnly] = useState(false);
  const attentionCount = useMemo(() => threads.filter(threadNeedsAttention).length, [threads]);
  const visibleThreads = attentionOnly ? threads.filter(threadNeedsAttention) : threads;
  // The selected thread may not be visible under the filter — keep the thread
  // view sane by falling back to the first visible thread.
  const selected =
    visibleThreads.find((t) => t.key === selectedKey) ?? visibleThreads[0] ?? null;

  const selectedCustomer =
    selected?.customerId != null
      ? customers?.find((c) => c.id === selected.customerId) ?? null
      : null;
  const canReply = selected?.customerId != null;
  const optedOut = selectedCustomer != null && !selectedCustomer.smsOptIn;

  const [reply, setReply] = useState('');

  const handleSend = () => {
    if (!selected || selected.customerId == null || !reply.trim()) return;
    send.mutate(
      { data: { customerId: selected.customerId, body: reply.trim(), kind: 'manual' } },
      {
        onSuccess: () => {
          setReply('');
          queryClient.invalidateQueries({ queryKey: getListSosMessagesQueryKey() });
          toast({ title: 'Reply queued for delivery' });
        },
        onError: (err: unknown) => {
          const msg =
            (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
          toast({
            title: "Couldn't send reply",
            description: msg ?? 'Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  if (threads.length === 0) {
    return (
      <div className="border rounded-lg py-12 text-center text-muted-foreground" data-testid="conversations-empty">
        No conversations yet.
      </div>
    );
  }

  return (
    <div className="border rounded-lg grid grid-cols-1 md:grid-cols-[260px_1fr] overflow-hidden" data-testid="sms-conversations">
      {/* Thread list */}
      <div className="border-b md:border-b-0 md:border-r max-h-[420px] overflow-y-auto" data-testid="conversation-list">
        <div className="px-4 py-2 border-b bg-muted/40">
          <button
            type="button"
            onClick={() => setAttentionOnly((v) => !v)}
            aria-pressed={attentionOnly}
            className={`inline-flex items-center gap-1.5 text-xs rounded-full border px-2.5 py-1 transition-colors ${
              attentionOnly
                ? 'bg-destructive text-destructive-foreground border-destructive'
                : 'text-muted-foreground hover:bg-muted'
            }`}
            data-testid="filter-needs-attention"
          >
            <AlertTriangle className="w-3 h-3" />
            Needs attention
            <span data-testid="filter-needs-attention-count">{attentionCount}</span>
          </button>
        </div>
        {visibleThreads.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground" data-testid="conversations-filter-empty">
            No conversations need attention.
          </div>
        )}
        {visibleThreads.map((t) => {
          const last = t.messages[t.messages.length - 1];
          const isActive = selected?.key === t.key;
          const hasUndelivered = threadNeedsAttention(t);
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setSelectedKey(t.key)}
              className={`w-full text-left px-4 py-3 border-b last:border-b-0 hover:bg-muted/60 transition-colors ${isActive ? 'bg-muted' : ''}`}
              data-testid={`conversation-item-${t.key}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate flex items-center gap-1.5">
                  {t.title}
                  {hasUndelivered && (
                    <AlertTriangle
                      className="w-3.5 h-3.5 text-destructive shrink-0"
                      aria-label="Last text not delivered"
                      data-testid={`conversation-failure-${t.key}`}
                    />
                  )}
                </span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {new Date(t.lastAt).toLocaleDateString()}
                </span>
              </div>
              <div className="text-xs text-muted-foreground truncate mt-0.5">
                {last.direction === 'inbound' ? '' : 'You: '}
                {last.body}
              </div>
            </button>
          );
        })}
      </div>

      {/* Thread view */}
      <div className="flex flex-col min-h-[320px]" data-testid="conversation-thread">
        {selected && (
          <>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b">
              <MessageSquare className="w-4 h-4 text-primary" />
              <span className="font-semibold" data-testid="conversation-title">{selected.title}</span>
              {optedOut && (
                <Badge variant="destructive" className="text-[10px] uppercase" data-testid="badge-opted-out">
                  Opted out
                </Badge>
              )}
            </div>
            <div className="flex-1 overflow-y-auto max-h-[300px] p-4 space-y-2">
              {selected.messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                  data-testid={`message-bubble-${m.id}`}
                  data-direction={m.direction}
                >
                  <div
                    className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                      m.direction === 'outbound'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-foreground'
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                    <div
                      className={`text-[10px] mt-1 ${
                        m.direction === 'outbound' ? 'text-primary-foreground/70' : 'text-muted-foreground'
                      }`}
                    >
                      {new Date(m.createdAt).toLocaleString()}
                      {m.direction === 'outbound' && ` · ${m.deliveryStatus}`}
                    </div>
                    {m.direction === 'outbound' &&
                      (m.deliveryStatus === 'failed' || m.deliveryStatus === 'skipped') && (
                        <div className="mt-1" data-testid={`message-delivery-error-${m.id}`}>
                          <MessageStatusBadge
                            item={{
                              id: m.id,
                              createdAt: m.createdAt,
                              contact: null,
                              body: m.body,
                              kind: m.kind,
                              status: m.deliveryStatus,
                              direction: m.direction,
                              errorCode: m.errorCode,
                              errorMessage: m.errorMessage,
                            }}
                          />
                        </div>
                      )}
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t p-3">
              {!canReply ? (
                <p className="text-xs text-muted-foreground" data-testid="text-no-reply">
                  This number isn't linked to a customer, so replies aren't available.
                </p>
              ) : optedOut ? (
                <p className="text-xs text-destructive" data-testid="text-opted-out">
                  This customer has opted out of SMS — replies are disabled.
                </p>
              ) : (
                <div className="flex items-end gap-2">
                  <Textarea
                    rows={2}
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder={`Reply to ${selected.title}…`}
                    className="resize-none"
                    data-testid="input-reply"
                  />
                  <Button
                    onClick={handleSend}
                    disabled={!reply.trim() || send.isPending}
                    data-testid="button-send-reply"
                  >
                    <Send className="w-4 h-4 mr-1.5" /> Send
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
