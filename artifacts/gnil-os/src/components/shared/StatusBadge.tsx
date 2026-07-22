import { Badge } from '@/components/ui/badge';

/** Solid pastel style used on tenant tables and tenant headers. */
const SOLID_STYLES: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200',
  suspended: 'bg-destructive/10 text-destructive hover:bg-destructive/10 border-destructive/20',
  pending: 'bg-amber-100 text-amber-800 hover:bg-amber-100 border-amber-200',
};

/** Tinted outline style used on module subscriber lists and connector mapping. */
const OUTLINE_STYLES: Record<string, string> = {
  active: 'border-emerald-500/40 text-emerald-600 bg-emerald-500/5',
  suspended: 'border-red-500/40 text-red-600 bg-red-500/5',
  inactive: 'border-red-500/40 text-red-600 bg-red-500/5',
  pending: 'border-amber-500/40 text-amber-600 bg-amber-500/5',
};

interface StatusBadgeProps {
  status: string;
  /** 'solid' — pastel tenant style (uppercase, bold); 'outline' — tinted outline. */
  variant?: 'solid' | 'outline';
  className?: string;
  'data-testid'?: string;
}

/**
 * Shared status badge for tenant/module subscription status
 * (active / suspended / pending / inactive). One source of truth for the
 * status→color mapping so styling can't drift between pages.
 */
export function StatusBadge({ status, variant = 'solid', className, 'data-testid': testId }: StatusBadgeProps) {
  if (variant === 'outline') {
    return (
      <Badge
        variant="outline"
        className={`${OUTLINE_STYLES[status] ?? OUTLINE_STYLES.pending}${className ? ` ${className}` : ''}`}
        data-testid={testId}
      >
        {status}
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className={`uppercase tracking-wider text-[10px] font-bold ${SOLID_STYLES[status] ?? ''}${className ? ` ${className}` : ''}`}
      data-testid={testId}
    >
      {status}
    </Badge>
  );
}
