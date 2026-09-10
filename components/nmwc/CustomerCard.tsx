import Link from 'next/link';
import { CompletenessRing } from './CompletenessRing';
import { StatusBadge } from './StatusBadge';
import { PaymentTermsPill } from './PaymentTermsPill';
import { MapPin } from 'lucide-react';
import type { Customer, Branch, CustomerStatus, PaymentTerms } from '@prisma/client';

type CardProps = {
  customer: Pick<Customer, 'id' | 'nmwcCode' | 'legalName' | 'paymentTerms' | 'status' | 'completenessScore'>;
  primaryBranch?: Pick<Branch, 'branchName' | 'address'> | null;
  href?: string;
};

export function CustomerCard({ customer, primaryBranch, href }: CardProps) {
  const inner = (
    <article className="flex items-start gap-3 rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200 hover:shadow-md focus-within:ring-brand-500">
      <CompletenessRing value={customer.completenessScore} size={44} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-slate-900">{customer.legalName}</h3>
            <p className="truncate text-sm text-slate-500">{customer.nmwcCode}</p>
          </div>
          <PaymentTermsPill terms={customer.paymentTerms as PaymentTerms} />
        </div>
        {primaryBranch && (
          <div className="mt-1.5 flex items-start gap-1.5 text-sm text-slate-600">
            <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
            <span className="line-clamp-1">{primaryBranch.address}</span>
          </div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <StatusBadge status={customer.status as CustomerStatus} />
        </div>
      </div>
    </article>
  );
  if (!href) return inner;
  return (
    // A link wrapping an <article> gets NO accessible name from its content
    // (name-from-content stops at article), so screen readers announced a bare
    // "link" and the browser walk could not address the card by customer name.
    <Link href={href} className="block" aria-label={`${customer.legalName} · ${customer.nmwcCode}`}>
      {inner}
    </Link>
  );
}
