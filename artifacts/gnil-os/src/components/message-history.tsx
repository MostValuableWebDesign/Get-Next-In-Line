import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RotateCcw } from 'lucide-react';

/**
 * Shared message-history table used by both the tenant Concierge page
 * (engagement message dispatch log) and the SOS AI Receptionist page
 * (SMS broadcast history). Each page maps its own API rows into
 * `MessageHistoryItem`s so the list layout and delivery-status display
 * stay consistent while the data scope stays page-specific.
 */

export interface MessageHistoryItem {
  id: number | string;
  createdAt: string;
  /** Customer/client name, or a phone number fallback. */
  contact: string | null;
  body: string | null;
  /** Message kind / job type (e.g. "manual", "reminder", "rebooking_nudge"). */
  kind: string;
  /** Delivery status (pending, sent, delivered, simulated, failed, skipped…). */
  status: string;
  direction?: 'inbound' | 'outbound';
  errorMessage?: string | null;
  errorCode?: string | null;
  /** Id of a non-failed retry already recorded for this failed message. */
  retriedByMessageId?: number | null;
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  sent: 'default',
  delivered: 'default',
  simulated: 'secondary',
  pending: 'outline',
  queued: 'outline',
  failed: 'destructive',
  skipped: 'destructive',
};

/** Consistent delivery-status badge with inline error details when failed/skipped. */
export function MessageStatusBadge({ item }: { item: MessageHistoryItem }) {
  const isError = item.status === 'failed' || item.status === 'skipped';
  const errorDetail = isError
    ? item.errorMessage
      ? `${item.errorCode ? `[${item.errorCode}] ` : ''}${item.errorMessage}`
      : item.errorCode ?? null
    : null;

  return (
    <div>
      <Badge
        variant={STATUS_VARIANT[item.status] ?? 'outline'}
        className="text-[10px] uppercase"
        title={errorDetail ?? undefined}
        data-testid={`badge-message-status-${item.id}`}
      >
        {item.status}
      </Badge>
      {errorDetail && (
        <span className="block max-w-[200px] truncate text-[10px] text-destructive/80 mt-0.5">
          {errorDetail}
        </span>
      )}
    </div>
  );
}

export function MessageHistoryTable({
  items,
  showDirection = false,
  emptyMessage = 'No messages yet.',
  testId = 'table-message-history',
  onRetry,
  retryingId,
}: {
  items: MessageHistoryItem[] | undefined;
  /** Show the Inbound/Outbound column (SMS histories). */
  showDirection?: boolean;
  emptyMessage?: string;
  testId?: string;
  /** When set, failed outbound messages get a one-click Retry action. */
  onRetry?: (item: MessageHistoryItem) => void;
  /** Id of the message currently being retried (disables its button). */
  retryingId?: number | string | null;
}) {
  const colCount = showDirection ? 6 : 5;

  return (
    <div className="border rounded-lg overflow-x-auto" data-testid={testId}>
      <table className="w-full text-sm text-left">
        <thead className="bg-muted/50 text-muted-foreground sticky top-0">
          <tr>
            {showDirection && <th className="px-4 py-3 font-medium">Direction</th>}
            <th className="px-4 py-3 font-medium">Contact</th>
            <th className="px-4 py-3 font-medium">Message</th>
            <th className="px-4 py-3 font-medium">Type</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {items?.map((item) => (
            <tr key={item.id} className="hover:bg-muted/30" data-testid={`row-message-${item.id}`}>
              {showDirection && (
                <td className="px-4 py-3">
                  <Badge
                    variant={item.direction === 'inbound' ? 'default' : 'secondary'}
                    className="text-[10px] capitalize"
                  >
                    {item.direction === 'inbound' ? 'Inbound' : 'Outbound'}
                  </Badge>
                </td>
              )}
              <td className="px-4 py-3 font-medium">{item.contact ?? '—'}</td>
              <td className="px-4 py-3 max-w-xs truncate" title={item.body ?? undefined}>
                {item.body ?? '—'}
              </td>
              <td className="px-4 py-3">
                <Badge variant="outline" className="text-[10px] capitalize">
                  {item.kind.replace(/_/g, ' ')}
                </Badge>
              </td>
              <td className="px-4 py-3">
                <MessageStatusBadge item={item} />
                {onRetry &&
                  item.status === 'failed' &&
                  item.direction !== 'inbound' &&
                  item.retriedByMessageId != null && (
                    <Badge
                      variant="secondary"
                      className="mt-1 text-[10px] uppercase"
                      data-testid={`badge-message-retried-${item.id}`}
                    >
                      Retried
                    </Badge>
                  )}
                {onRetry &&
                  item.status === 'failed' &&
                  item.direction !== 'inbound' &&
                  item.retriedByMessageId == null && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1 h-6 px-2 text-[10px]"
                      disabled={retryingId != null && retryingId === item.id}
                      onClick={() => onRetry(item)}
                      data-testid={`button-retry-message-${item.id}`}
                    >
                      <RotateCcw className="w-3 h-3 mr-1" />
                      {retryingId === item.id ? 'Retrying…' : 'Retry'}
                    </Button>
                  )}
              </td>
              <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                {new Date(item.createdAt).toLocaleString()}
              </td>
            </tr>
          ))}
          {items?.length === 0 && (
            <tr>
              <td colSpan={colCount} className="p-8 text-center text-muted-foreground">
                {emptyMessage}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
