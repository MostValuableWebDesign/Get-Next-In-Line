import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';

export interface ActivityFeedItem {
  id: number | string;
  action: string;
  timestamp: string;
  details?: string | null;
  /** Secondary label (e.g. tenant name); rendered inline for both variants. */
  tenantName?: string | null;
  /** When set, tenantName renders as a link to this href. */
  tenantHref?: string;
}

interface ActivityFeedProps {
  items: ActivityFeedItem[];
  /**
   * 'dots'    — Dashboard-style bullet feed with right-aligned time-of-day.
   * 'divided' — divide-y row list with full date/time (tenant/module detail pages).
   */
  variant: 'dots' | 'divided';
  /** Rendered when items is empty. */
  empty: ReactNode;
  listTestId?: string;
  itemTestIdPrefix?: string;
  /** Extra classes on each 'divided' row (e.g. 'px-6' for edge-to-edge cards). */
  itemClassName?: string;
  /* Optional keyset "Load more" controls */
  hasMore?: boolean;
  isLoadingMore?: boolean;
  loadMoreError?: boolean;
  onLoadMore?: () => void;
  loadMoreTestId?: string;
  loadMoreErrorTestId?: string;
}

/**
 * Shared, presentational activity feed body. Pages own data fetching and
 * pagination state; this component renders the list, empty state, and the
 * optional "Load more" footer identically everywhere.
 */
export function ActivityFeed({
  items,
  variant,
  empty,
  listTestId,
  itemTestIdPrefix,
  itemClassName = '',
  hasMore = false,
  isLoadingMore = false,
  loadMoreError = false,
  onLoadMore,
  loadMoreTestId,
  loadMoreErrorTestId,
}: ActivityFeedProps) {
  if (!items.length) return <>{empty}</>;

  const padTop = variant === 'dots' ? 'pt-4' : 'pt-3';

  return (
    <>
      {variant === 'dots' ? (
        <div className="space-y-4" data-testid={listTestId}>
          {items.map((item) => (
            <div key={item.id} className="flex items-start gap-4 text-sm" data-testid={itemTestIdPrefix ? `${itemTestIdPrefix}${item.id}` : undefined}>
              <div className="w-2 h-2 mt-1.5 rounded-full bg-primary shrink-0" />
              <div className="flex-1">
                <div className="font-medium">{item.action}</div>
                <div className="text-muted-foreground mt-0.5">
                  {item.tenantName} {item.details && `— ${item.details}`}
                </div>
              </div>
              <div className="text-muted-foreground font-mono text-xs whitespace-nowrap">
                {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="divide-y" data-testid={listTestId}>
          {items.map((item) => (
            <div key={item.id} className={`py-3 ${itemClassName}`.trim()} data-testid={itemTestIdPrefix ? `${itemTestIdPrefix}${item.id}` : undefined}>
              <div className="flex items-center justify-between gap-4">
                <div className="text-sm font-medium">{item.action}</div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {new Date(item.timestamp).toLocaleString()}
                </span>
              </div>
              {(item.tenantName || item.details) && (
                <div className="text-xs text-muted-foreground mt-0.5">
                  {item.tenantName &&
                    (item.tenantHref ? (
                      <Link href={item.tenantHref} className="underline-offset-2 hover:underline">
                        {item.tenantName}
                      </Link>
                    ) : (
                      item.tenantName
                    ))}
                  {item.tenantName && item.details ? ` — ${item.details}` : !item.tenantName ? item.details : null}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {loadMoreError && (
        <p className={`${padTop} text-xs text-destructive text-center`} data-testid={loadMoreErrorTestId}>
          Couldn't load more activity. Please try again.
        </p>
      )}
      {hasMore && onLoadMore && (
        <div className={`${padTop} flex justify-center`}>
          <Button
            variant="outline"
            size="sm"
            disabled={isLoadingMore}
            onClick={onLoadMore}
            data-testid={loadMoreTestId}
          >
            {isLoadingMore ? 'Loading…' : loadMoreError ? 'Retry' : 'Load more'}
          </Button>
        </div>
      )}
    </>
  );
}
