import { cn } from '@/lib/utils';
import type { PaymentTerms } from '@prisma/client';

export function PaymentTermsPill({
  terms,
  className,
}: {
  terms: PaymentTerms;
  className?: string;
}) {
  const isCash = terms === 'CASH';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset',
        isCash
          ? 'bg-slate-100 text-slate-700 ring-slate-200'
          : 'bg-violet-50 text-violet-700 ring-violet-200',
        className
      )}
      title={isCash ? 'Cash customer — fully editable' : 'Credit customer — name and CR locked'}
    >
      {isCash ? 'Cash' : 'Credit'}
    </span>
  );
}
