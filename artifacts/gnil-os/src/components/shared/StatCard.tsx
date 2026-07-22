import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { ComponentType, ReactNode } from 'react';

interface StatCardProps {
  title: string;
  value: ReactNode;
  /** Optional icon — when provided, renders the "dashboard" style card with the
   *  faded icon overlay and mono value; without it, a plain metric card. */
  icon?: ComponentType<{ className?: string }>;
  /** Emerald trend line, e.g. "+12%" — appended with "from last month". */
  trend?: string;
  subtitle?: string;
  loading?: boolean;
}

/**
 * Shared stat/metric card used by the Dashboard and Reports pages.
 * Two visual modes (kept pixel-identical to the previous per-page copies):
 *  - with `icon`: borderless shadow card, mono value, icon overlay (Dashboard)
 *  - without `icon`: plain bordered card with optional loading skeleton (Reports)
 */
export function StatCard({ title, value, icon: Icon, trend, subtitle, loading }: StatCardProps) {
  if (!Icon) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-8 w-20" /> : <div className="text-3xl font-bold">{value ?? 0}</div>}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-none shadow-md overflow-hidden relative group">
      <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
        <Icon className="w-16 h-16" />
      </div>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold font-mono tracking-tight">{value}</div>
        {trend && <p className="text-xs text-emerald-600 font-medium mt-1">{trend} from last month</p>}
        {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}
