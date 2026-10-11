import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { omanDateTime } from '@/lib/tz';
import { PRINTOUT_TITLES } from '@/lib/print';
import { loadCreditApplicationPrint } from '@/lib/print-load';
import { PrintFrame, PrintUnavailable } from '@/components/print/PrintFrame';
import {
  DeclarationBlock,
  InfoGrid,
  LocationBlock,
  PhotoGrid,
  PrintSection,
  PrintSheet,
} from '@/components/print/PrintSheet';

export const metadata = { title: 'Credit application · NMWC' };
// Never cached: who may print, and whether the request is still at its step, are read per request.
export const dynamic = 'force-dynamic';

/**
 * Owner decisions 2026-10-11 (part C): the CREDIT APPLICATION of a credit
 * new-customer request, printed for the customer to sign and stamp. Offered from
 * the Sales Director's approval until the salesman uploads the signed form;
 * outside that window the page says where the request is instead.
 *
 * Every role but the salesman may print it, within the scope its documents are
 * opened in (lib/print-load.ts); anyone else, and any id he cannot see, gets a
 * 404. Rendering writes nothing: the print is recorded by the Print button.
 */
export default async function CreditApplicationPrintPage({ params }: { params: Promise<{ editId: string }> }) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const { editId } = await params;
  const user = { id: session.user.id, role: session.user.role, username: session.user.username };
  const loaded = await loadCreditApplicationPrint(user, editId);
  if (!loaded) notFound();
  const backHref = `/approvals/${editId}`;
  if (loaded.kind === 'unavailable') {
    return (
      <PrintUnavailable
        title={PRINTOUT_TITLES.CREDIT_APPLICATION}
        subject={loaded.legalName}
        message={loaded.message}
        backHref={backHref}
        alternative={
          loaded.customerId
            ? { href: `/print/customer/${loaded.customerId}`, label: 'Open the customer form to print' }
            : undefined
        }
      />
    );
  }
  const p = loaded.print;
  return (
    <PrintFrame printout="CREDIT_APPLICATION" id={p.editId} backHref={backHref}>
      <PrintSheet
        title={PRINTOUT_TITLES.CREDIT_APPLICATION}
        subject={p.legalName}
        codes={[
          { label: 'Request ref.', value: p.editId, mono: true },
          { label: 'NMWC code', value: 'Assigned on approval', muted: true },
        ]}
        status="Awaiting customer signature"
        printedBy={session.user.name ?? session.user.username}
        printedAt={new Date()}
        meta={
          <>
            Submitted by {p.submittedBy}
            {p.submittedAt ? ` · ${omanDateTime(p.submittedAt)}` : ''}
            {p.dueAt ? ` · signed copy due back ${omanDateTime(p.dueAt)}` : ''}
          </>
        }
      >
        <PrintSection title="Customer Information">
          <InfoGrid rows={p.customer} />
        </PrintSection>
        <PrintSection title="Credit Terms Requested">
          <InfoGrid rows={p.credit} />
        </PrintSection>
        {p.branches.map((b) => (
          <PrintSection key={b.title} title={b.title}>
            <InfoGrid rows={b.rows} />
            <LocationBlock location={b.location} />
          </PrintSection>
        ))}
        <DeclarationBlock />
        <PrintSection title="Photos & documents" keepTogether={false} newPage>
          <PhotoGrid figures={p.figures} />
        </PrintSection>
      </PrintSheet>
    </PrintFrame>
  );
}
