import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { PRINTOUT_TITLES, TEMIX_CODE_MIGRATED, TEMIX_CODE_NONE, printoutDocumentTitle } from '@/lib/print';
import { STATUS_LABEL, loadCustomerFormPrint } from '@/lib/print-load';
import { PrintFrame } from '@/components/print/PrintFrame';
import {
  ApprovalTrail,
  ApproverSignatureBoxes,
  InfoGrid,
  LocationBlock,
  PhotoGrid,
  PrintSection,
  PrintSheet,
} from '@/components/print/PrintSheet';

// Never cached: scope and the customer as it stands are read per request.
export const dynamic = 'force-dynamic';

/**
 * The printout for whoever is signed in, read once per request: the page and its
 * title (generateMetadata) share it (React cache). Null when signed out.
 */
const loadForViewer = cache(async (customerId: string) => {
  const session = await auth();
  if (!session?.user) return null;
  const user = { id: session.user.id, role: session.user.role, username: session.user.username };
  return { session, print: await loadCustomerFormPrint(user, customerId) };
});

/**
 * Review (2026-10-11): titled by the customer's NMWC code, so a saved PDF is
 * named after its customer — only once the viewer may print it.
 */
export async function generateMetadata({ params }: { params: Promise<{ customerId: string }> }): Promise<Metadata> {
  const { customerId } = await params;
  const loaded = await loadForViewer(customerId);
  return { title: printoutDocumentTitle('CUSTOMER_FORM', loaded?.print?.nmwcCode) };
}

/**
 * Owner decisions 2026-10-11 (part C): the FINAL CUSTOMER FORM, for every live
 * customer (mostly printed for new ones): both codes, every customer and shop
 * detail with the location, every photo and document, the approval trail, and
 * the approvers' signature boxes — cash: Supervisor and Accountant; credit:
 * Supervisor, Sales Director, Finance Manager, GM and Accountant.
 *
 * Every role but the salesman may print it, for a customer it can open and with
 * only the branches it can see (lib/print-load.ts); anyone else gets a 404.
 * Rendering writes nothing: the print is recorded by the Print button.
 */
export default async function CustomerFormPrintPage({ params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await params;
  const loaded = await loadForViewer(customerId);
  if (!loaded) redirect('/login');
  const { session, print: p } = loaded;
  if (!p) notFound();
  return (
    <PrintFrame printout="CUSTOMER_FORM" id={p.customerId} backHref={`/customers/${p.customerId}`}>
      <PrintSheet
        title={PRINTOUT_TITLES.CUSTOMER_FORM}
        subject={p.legalName}
        codes={[
          { label: 'NMWC code', value: p.nmwcCode, mono: true },
          p.temixCode
            ? { label: 'Temix code', value: p.temixCode, mono: true }
            : {
                label: 'Temix code',
                // Not made through a CRM request (imported or seeded): in Temix under its NMWC code.
                value: p.trail.kind === 'request' ? TEMIX_CODE_NONE : TEMIX_CODE_MIGRATED,
                muted: true,
              },
        ]}
        status={`${STATUS_LABEL[p.status]} · ${p.paymentTerms === 'CREDIT' ? 'Credit' : 'Cash'}`}
        printedBy={session.user.name ?? session.user.username}
        printedAt={new Date()}
      >
        <PrintSection title="Customer Information">
          <InfoGrid rows={p.customer} />
        </PrintSection>
        {p.credit && (
          <PrintSection title="Credit Terms">
            <InfoGrid rows={p.credit} />
          </PrintSection>
        )}
        {p.branches.map((b) => (
          <PrintSection key={b.title} title={b.title}>
            <InfoGrid rows={b.rows} />
            <LocationBlock location={b.location} />
          </PrintSection>
        ))}
        <PrintSection title="Photos & documents" keepTogether={false}>
          <PhotoGrid figures={p.figures} />
        </PrintSection>
        <PrintSection title="Approval trail">
          <ApprovalTrail trail={p.trail} />
        </PrintSection>
        <ApproverSignatureBoxes signatures={p.signatures} />
      </PrintSheet>
    </PrintFrame>
  );
}
