import { useState } from 'react';
import {
  useListConciergeMessageLogs,
  getListConciergeMessageLogsQueryKey,
  useListSosCalls,
  getListSosCallsQueryKey,
  useListSosMessages,
  getListSosMessagesQueryKey,
} from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageStatusBadge, type MessageHistoryItem } from '@/components/message-history';
import { Bot, MessageSquare, Phone, ScrollText, User } from 'lucide-react';

/**
 * Unified Communications tab on Tenant Detail (/tenants/:id?tab=communications).
 *
 * Merges the former Concierge "Message Log" tab with the AI Receptionist's
 * call and SMS logs into one chronologically ordered stream, filterable by
 * type. Tenant scope: concierge logs are fetched per-tenant by path param;
 * SOS calls/messages carry the tenant context via the `x-tenant-id` header
 * (strict NULL-vs-tenant matching server-side, so other tenants' traffic
 * never appears here).
 */

export type CommType = 'ai_call' | 'ai_sms' | 'concierge' | 'manual';

export interface CommEntry {
  /** Unique across sources — prefixed with the source. */
  key: string;
  type: CommType;
  createdAt: string;
  contact: string | null;
  body: string | null;
  /** Fine-grained kind label (e.g. reminder, rebooking_nudge, booking intent). */
  kind: string;
  direction?: 'inbound' | 'outbound';
  /** Delivery/outcome status; rendered via MessageStatusBadge for messages. */
  status: string;
  errorMessage?: string | null;
  errorCode?: string | null;
}

const FILTERS: { value: CommType | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'ai_call', label: 'AI Calls' },
  { value: 'ai_sms', label: 'AI SMS' },
  { value: 'concierge', label: 'Concierge SMS' },
  { value: 'manual', label: 'Manual' },
];

const TYPE_META: Record<CommType, { label: string; Icon: typeof Phone }> = {
  ai_call: { label: 'AI Call', Icon: Phone },
  ai_sms: { label: 'AI SMS', Icon: Bot },
  concierge: { label: 'Concierge', Icon: ScrollText },
  manual: { label: 'Manual', Icon: User },
};

export function CommunicationsTab({ tenantId }: { tenantId: number }) {
  const [filter, setFilter] = useState<CommType | 'all'>('all');

  const { data: conciergeLogs, isLoading: loadingConcierge } = useListConciergeMessageLogs(
    tenantId,
    { query: { queryKey: getListConciergeMessageLogsQueryKey(tenantId) } },
  );

  // SOS calls/messages are scoped by the x-tenant-id header; include the
  // tenant in the query key so caches never mix scopes.
  const tenantHeaders = { headers: { 'x-tenant-id': String(tenantId) } };
  const { data: calls, isLoading: loadingCalls } = useListSosCalls({
    query: { queryKey: [...getListSosCallsQueryKey(), { tenantId }] },
    request: tenantHeaders,
  });
  const { data: sosMessages, isLoading: loadingSms } = useListSosMessages(
    { limit: 100 },
    {
      query: { queryKey: [...getListSosMessagesQueryKey({ limit: 100 }), { tenantId }] },
      request: tenantHeaders,
    },
  );

  const isLoading = loadingConcierge || loadingCalls || loadingSms;

  const entries: CommEntry[] = [
    ...(conciergeLogs ?? []).map((log): CommEntry => ({
      key: `concierge-${log.id}`,
      type: log.jobType === 'manual' ? 'manual' : 'concierge',
      createdAt: log.createdAt,
      contact: log.clientName ?? null,
      body: log.body ?? null,
      kind: log.jobType,
      status: log.status,
      errorMessage: log.errorMessage ?? null,
      errorCode: log.errorCode ?? null,
    })),
    ...(calls ?? []).map((call): CommEntry => ({
      key: `call-${call.id}`,
      type: 'ai_call',
      createdAt: call.createdAt,
      contact: call.callerName || call.fromNumber,
      body: call.transcriptSummary ?? null,
      kind: call.intent,
      direction: 'inbound',
      status: call.outcome,
    })),
    ...(sosMessages ?? []).map((msg): CommEntry => ({
      key: `sms-${msg.id}`,
      type: msg.kind === 'manual' ? 'manual' : 'ai_sms',
      createdAt: msg.createdAt,
      contact: msg.customerName || msg.toNumber || null,
      body: msg.body,
      kind: msg.kind,
      direction: msg.direction as 'inbound' | 'outbound',
      status: msg.deliveryStatus,
      errorMessage: msg.errorMessage,
      errorCode: msg.errorCode,
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  const visible = filter === 'all' ? entries : entries.filter((e) => e.type === filter);

  return (
    <Card data-testid="tab-content-communications">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-primary" /> Communications
        </CardTitle>
        <CardDescription>
          Every customer contact for this tenant — AI receptionist calls and texts, automated
          concierge messages, and manual sends — in one stream.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2" data-testid="filters-communications">
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              variant={filter === f.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter(f.value)}
              data-testid={`filter-comm-${f.value}`}
            >
              {f.label}
            </Button>
          ))}
        </div>

        {isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground p-4 text-center" data-testid="text-no-communications">
            {entries.length === 0
              ? 'No communications for this tenant yet.'
              : 'No communications match this filter.'}
          </p>
        ) : (
          <div className="border rounded-lg overflow-x-auto" data-testid="table-communications">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted/50 text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Contact</th>
                  <th className="px-4 py-3 font-medium">Message</th>
                  <th className="px-4 py-3 font-medium">Kind</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {visible.map((entry) => {
                  const { label, Icon } = TYPE_META[entry.type];
                  return (
                    <tr key={entry.key} className="hover:bg-muted/30" data-testid={`row-comm-${entry.key}`}>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Badge variant="secondary" className="text-[10px] gap-1">
                          <Icon className="w-3 h-3" /> {label}
                        </Badge>
                        {entry.direction && (
                          <span className="block text-[10px] text-muted-foreground capitalize mt-0.5">
                            {entry.direction}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-medium">{entry.contact ?? '—'}</td>
                      <td className="px-4 py-3 max-w-xs truncate" title={entry.body ?? undefined}>
                        {entry.body ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-[10px] capitalize">
                          {entry.kind.replace(/_/g, ' ')}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        {entry.type === 'ai_call' ? (
                          <Badge
                            variant={entry.status === 'booked' ? 'default' : 'secondary'}
                            className="text-[10px] uppercase"
                            data-testid={`badge-comm-status-${entry.key}`}
                          >
                            {entry.status.replace(/_/g, ' ')}
                          </Badge>
                        ) : (
                          <MessageStatusBadge
                            item={{ id: entry.key, status: entry.status, errorMessage: entry.errorMessage, errorCode: entry.errorCode } as MessageHistoryItem}
                          />
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                        {new Date(entry.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
