import type { Route } from 'next';
import Link from 'next/link';
import { CompletenessRing } from './CompletenessRing';
import { StatusBadge } from './StatusBadge';
import { PaymentTermsPill } from './PaymentTermsPill';
import { CallChip, DirectionsChip } from './ContactLinks';
import { directionsHref, telHref } from '@/lib/contact-links';
import { MapPin } from 'lucide-react';
import type { Customer, Branch, CustomerStatus, PaymentTerms } from '@prisma/client';

// Generic over the href, as next/link itself is: `Route<T>` checks the caller's
// literal (`/customers/${id}`) against the app's routes. A plain `string` prop
// would accept anything and then fail at the <Link> inside.
//
// primaryPhone and the branch's GPS are REQUIRED in the picks, so a list that
// renders the card cannot forget to select them: it fails to typecheck instead
// of quietly showing cards without Call and Directions (benchmark item 40b).
type CardProps<T extends string> = {
  customer: Pick<
    Customer,
    'id' | 'nmwcCode' | 'legalName' | 'paymentTerms' | 'status' | 'completenessScore' | 'primaryPhone'
  >;
  primaryBranch?: Pick<Branch, 'branchName' | 'address' | 'gpsLat' | 'gpsLng'> | null;
  href?: Route<T>;
};

export function CustomerCard<T extends string>({ customer, primaryBranch, href }: CardProps<T>) {
  const identity = (
    <div className="flex items-start gap-3 p-4">
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
    </div>
  );

  // Only when there is something to tap: a row of cards with an empty strip on
  // each costs height and payload for nothing.
  const hasActions =
    telHref(customer.primaryPhone) !== null || directionsHref(primaryBranch?.gpsLat, primaryBranch?.gpsLng) !== null;

  return (
    <article className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200 hover:shadow-md focus-within:ring-brand-500">
      {href ? (
        // A link wrapping block content gets NO accessible name from it (name-from-
        // content stops at the structure), so screen readers announced a bare
        // "link" and the browser walk could not address the card by customer name.
        // It stays FIRST in the card, so `getByRole('link', { name }).first()` is it.
        <Link href={href} className="block rounded-lg" aria-label={`${customer.legalName} · ${customer.nmwcCode}`}>
          {identity}
        </Link>
      ) : (
        identity
      )}
      {hasActions && (
        // A sibling of the Link, never inside it: <a> in <a> is invalid HTML, and
        // React 19 reports it as a hydration error.
        <div className="flex flex-wrap gap-2 px-4 pb-4">
          <CallChip phone={customer.primaryPhone} />
          <DirectionsChip lat={primaryBranch?.gpsLat} lng={primaryBranch?.gpsLng} />
        </div>
      )}
    </article>
  );
}
