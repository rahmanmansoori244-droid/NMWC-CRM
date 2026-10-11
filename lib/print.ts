/**
 * The two printouts (owner decisions 2026-10-11, part C of the credit flow), as
 * rules: who may print, which printout is offered when, what the customer
 * declares, which signature boxes a form carries, and what the PRINT audit row
 * records. Pure — no database, no session — so the pages, the loaders
 * (lib/print-load.ts) and the action that records a print (services/prints.ts)
 * read one answer.
 *
 *   - The CREDIT APPLICATION: a credit new-customer request, printed for the
 *     customer to sign and stamp, from the Sales Director's approval until the
 *     salesman uploads the signed form — that is, while the request waits at the
 *     signed-application step (creditApplicationAvailable).
 *   - The FINAL CUSTOMER FORM: any live customer, with both codes, every detail,
 *     photo and document, the approval trail and the approvers' signature boxes.
 *
 * Printed from the browser (Print → Save as PDF), A4 portrait, in English.
 * Every print writes one PRINT audit row first; a print that cannot be recorded
 * is not started (components/print/PrintButton.tsx).
 */
import type { PaymentTerms, Role } from '@prisma/client';
import { isSignedFormStep, parseChain } from './approval-chains';

/**
 * Who may print (owner decisions 2026-10-11): every role except the salesman,
 * each within the scope it already reads in (lib/access.ts canSeeCustomer). The
 * salesman's own page says his supervisor prints the credit application.
 * A Record, so a new role must be decided here before the code compiles
 * (fail-closed by construction).
 */
export const PRINT_ALLOWED: Record<Role, boolean> = {
  SALESMAN: false,
  SUPERVISOR: true,
  ACCOUNTANT: true,
  FINANCE_MANAGER: true,
  GM: true,
  SALES_DIRECTOR: true,
  MANAGER: true,
  STEWARD: true,
  VIEWER: true,
};

export function canPrint(role: Role): boolean {
  return PRINT_ALLOWED[role] === true;
}

export const PRINTOUTS = ['CREDIT_APPLICATION', 'CUSTOMER_FORM'] as const;
export type Printout = (typeof PRINTOUTS)[number];

export const PRINTOUT_TITLES: Record<Printout, string> = {
  CREDIT_APPLICATION: 'Credit Application',
  CUSTOMER_FORM: 'Customer Form',
};

/**
 * The tab title of one printout, which a browser's "Save as PDF" also takes as
 * the file name (review, 2026-10-11): one constant title gave every saved PDF the
 * same name. The record's reference, never the customer's name: the customer
 * form by its NMWC code, the application by its request reference — both
 * already printed in the sheet's header. Without one (a page about to 404, a
 * request that cannot be printed now) the plain title.
 */
export function printoutDocumentTitle(printout: Printout, ref: string | null | undefined): string {
  const name = printout === 'CUSTOMER_FORM' ? 'Customer form' : 'Credit application';
  return ref ? `${name} ${ref} · NMWC` : `${name} · NMWC`;
}

/**
 * The customer form's Temix code when none is recorded (review, 2026-10-11). A
 * customer made through a CRM request gets its Temix code from the Accountant at
 * the last approval, so none on record means none was typed. A migrated or seeded
 * customer is in Temix under its NMWC code with no Temix code recorded
 * (prisma/schema.prisma Customer.temixCode; the profile says the same,
 * app/(app)/customers/[id]/page.tsx): a bare "None recorded" on a form the
 * Accountant files would read as "not in Temix". [Default — wording is the
 * owner's to confirm, 04-PENDING A8.]
 */
export const TEMIX_CODE_NONE = 'None recorded';
export const TEMIX_CODE_MIGRATED = 'Not recorded (migrated: in Temix under its NMWC code)';

/**
 * The toolbar's hint (review, 2026-10-11): Chrome's "Headers and footers" is on
 * by default and prints the tab title, the page address (with the record's id),
 * the date and page numbers in the sheet's 12 mm margins.
 */
export const PRINT_DIALOG_HINT = 'In the print dialog choose A4 and untick “Headers and footers” for a clean page.';

/**
 * The company, in text: the owner has not sent a logo (open point, owner
 * decisions 2026-10-11). Replace the text with the logo when it arrives.
 */
export const COMPANY_NAME = 'National Mineral Water Company SAOG';

/**
 * The customer's declaration, verbatim from the owner's paper form (owner
 * decisions 2026-10-11). tests/unit/print.test.ts pins every character: this is
 * what the customer signs, so it is never re-worded in code.
 */
export const CREDIT_DECLARATION =
  "We/I hereby undertake to indemnify M/S: National Mineral Water Company SAOG for any loss suffered or caused to them on non-payment or default in payment for the supplies made to our company/establishment on the basis of LPO's / receipts signed by the above mentioned authorized signatories or any employees of our company/establishment. Any delay in payment shall be liable to 1% per month from the date of payment due.";

/** The customer's boxes on the credit application, in the paper form's order. */
export const CUSTOMER_SIGNATURE_BOXES = ['Name', 'Designation', 'Signature', 'Company stamp'] as const;

/** Each approver's box on the customer form: written in by hand. */
export const APPROVER_BOX_LINES = ['Name', 'Signature', 'Date'] as const;

/**
 * The approvers who sign the final customer form (owner decisions 2026-10-11):
 * a cash customer's chain, a credit customer's chain — the approving roles only,
 * never the salesman's signed-application step.
 */
export function signatureRolesFor(terms: PaymentTerms): Role[] {
  return terms === 'CREDIT'
    ? ['SUPERVISOR', 'SALES_DIRECTOR', 'FINANCE_MANAGER', 'GM', 'ACCOUNTANT']
    : ['SUPERVISOR', 'ACCOUNTANT'];
}

/**
 * Whether the credit application may be printed now: the request waits at the
 * signed-application step — from the Sales Director's approval (or a Finance
 * Manager's send-back to that step) until the salesman uploads the signed form.
 * Read from the chain frozen on the request: one frozen before these decisions
 * has no such step, so it never offers the printout.
 */
export function creditApplicationAvailable(edit: {
  state: string;
  approvalChain: unknown;
  currentStepIndex: number;
}): boolean {
  if (edit.state !== 'SUBMITTED') return false;
  return isSignedFormStep(parseChain(edit.approvalChain)[edit.currentStepIndex]);
}

/**
 * The title of the alert that asks for the credit application to be printed
 * (services/edits.ts notifySignedFormRequested). Recording a print marks the
 * printer's own unread one read (services/prints.ts).
 */
export const PRINT_REQUEST_TITLE = 'Credit application to print';

/** What one print records, before it is reduced to ids. */
export type PrintAuditInput =
  | { printout: 'CREDIT_APPLICATION'; cycle: number; stepIndex: number }
  | { printout: 'CUSTOMER_FORM'; requestId: string | null; branchIds: readonly string[] };

/**
 * The PRINT row's `after`: which printout, and ids and counters only — never a
 * name, a phone, a code or a figure, as for PHOTO_VIEW (owner decision
 * 2026-10-11 a). The entity (the request or the customer) is the row's own
 * entityId. Built field by field, so nothing a caller adds can ride along.
 */
export function printAuditAfter(p: PrintAuditInput): Record<string, string | number | null | string[]> {
  return p.printout === 'CREDIT_APPLICATION'
    ? { printout: p.printout, cycle: p.cycle, stepIndex: p.stepIndex }
    : { printout: p.printout, requestId: p.requestId, branchIds: [...p.branchIds] };
}

/** The reason column of the PRINT row: which printout, in words the audit page shows. */
export const PRINT_AUDIT_REASON: Record<Printout, string> = {
  CREDIT_APPLICATION: 'credit application printed',
  CUSTOMER_FORM: 'customer form printed',
};
