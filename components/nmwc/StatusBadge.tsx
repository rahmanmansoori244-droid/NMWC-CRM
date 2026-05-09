import { cn } from '@/lib/utils';
import type { CustomerStatus, EditState } from '@prisma/client';

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  CLOSED: 'bg-red-50 text-red-700 ring-red-200',
  SUSPENDED: 'bg-amber-50 text-amber-700 ring-amber-200',
  DRAFT: 'bg-slate-50 text-slate-700 ring-slate-200',
  SUBMITTED: 'bg-blue-50 text-blue-700 ring-blue-200',
  APPROVED: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  REJECTED: 'bg-red-50 text-red-700 ring-red-200',
  NEEDS_CORRECTION: 'bg-amber-50 text-amber-700 ring-amber-200',
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  SUSPENDED: 'Suspended',
  DRAFT: 'Draft',
  SUBMITTED: 'Pending review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  NEEDS_CORRECTION: 'Needs correction',
};

export function StatusBadge({
  status,
  className,
}: {
  status: CustomerStatus | EditState | string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        STATUS_STYLES[status] ?? 'bg-slate-50 text-slate-700 ring-slate-200',
        className
      )}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
