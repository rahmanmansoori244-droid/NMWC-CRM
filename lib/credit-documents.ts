/**
 * The documents a CREDIT new-customer request carries (owner decisions
 * 2026-10-11), in one place: which kinds there are, what they are called, how
 * many pages each may have, which of them a decision is bound to, and which a
 * finalize requires.
 *
 *   - the four credit documents the salesman attaches when he submits: the
 *     owner's ID card, the membership certificate, the VAT registration
 *     certificate and the tax card — each mandatory for credit, 1..N pages;
 *   - the signed credit application (CREDIT_FORM): the printed application,
 *     signed and stamped by the customer, uploaded by the salesman at the
 *     signed-application step (services/signed-form.ts);
 *   - the guarantee / security document, which was the credit requirement until
 *     these decisions. The owner switched it off and may bring it back, so it is
 *     a switch (GUARANTEE_REQUIRED_FOR_CREDIT), not a deletion: the kind and every
 *     existing guarantee stay readable and bound.
 *
 * Every one of them is handled like a CR copy: never cached, every view
 * recorded, not served when the view cannot be recorded
 * (app/api/photos/[id]/route.ts reads CONFIDENTIAL_KINDS), and uploaded by a
 * salesman only (lib/permissions.ts canUploadPhoto).
 *
 * Pure: string literals and `import type` only, so a client component can
 * import it without pulling @prisma/client's runtime into the browser.
 */
import type { AttachmentKind } from '@prisma/client';
import type { ApprovalStep } from './approval-chains';

/** The four documents a credit request is submitted with (mandatory for CREDIT). */
export const CREDIT_DOCUMENT_KINDS = ['ID_CARD', 'MEMBERSHIP_CERT', 'VAT_CERT', 'TAX_CARD'] as const satisfies readonly AttachmentKind[];
export type CreditDocumentKind = (typeof CREDIT_DOCUMENT_KINDS)[number];

/** The customer's signed and stamped credit application, uploaded at the signed-application step. */
export const SIGNED_FORM_KIND = 'CREDIT_FORM' as const satisfies AttachmentKind;

/**
 * The documents an approver's decision is bound to (lib/decision-token.ts): the
 * edit-claimed, live attachments of these kinds are digested into the decision
 * token and re-read inside the decision transaction, so a decision lands on
 * exactly the documents the approver's page showed.
 */
export const DECISION_BOUND_KINDS = [
  'GUARANTEE',
  ...CREDIT_DOCUMENT_KINDS,
  SIGNED_FORM_KIND,
] as const satisfies readonly AttachmentKind[];
export type DecisionBoundKind = (typeof DECISION_BOUND_KINDS)[number];

/**
 * Confidential documents: never cached, every view recorded, and not served
 * when the view record cannot be written (owner decisions 2026-10-11 and the
 * photo-view decisions of the same day). The CR copy, and every decision-bound
 * document.
 */
export const CONFIDENTIAL_KINDS = ['CR', ...DECISION_BOUND_KINDS] as const satisfies readonly AttachmentKind[];

/** How each document is named on screens, printouts and refusals. */
export const CREDIT_DOCUMENT_LABELS: Record<DecisionBoundKind, string> = {
  ID_CARD: "Owner's ID card",
  MEMBERSHIP_CERT: 'Membership certificate',
  VAT_CERT: 'VAT registration certificate',
  TAX_CARD: 'Tax card',
  CREDIT_FORM: 'Signed credit application',
  GUARANTEE: 'Guarantee document',
};

/** Pages per credit document (a two-sided ID card, a multi-page certificate). */
export const MAX_PAGES_PER_DOCUMENT = 4;
/** Pages of the signed credit application: the form and its annex pages. */
export const MAX_SIGNED_FORM_PAGES = 6;

/**
 * Owner decisions 2026-10-11: the "at least one guarantee / security document"
 * requirement is switched OFF, and kept so the owner can bring it back. This
 * switch governs only the new-customer form's guarantee slot and its submit
 * gate. Finalize never requires a guarantee on a request frozen with the new
 * chain (requiredAtFinalize), so switching this back on cannot refuse a request
 * already in flight. Typed `boolean`, not the literal `false`, so the code
 * behind it keeps being type-checked while it is off (lib/validation/create.ts,
 * the new-customer form).
 */
export const GUARANTEE_REQUIRED_FOR_CREDIT: boolean = false;

/** Whether a step is the signed-application step (scope SUBMITTER); a local copy of lib/approval-chains.ts isSignedFormStep, kept here so this module stays import-free. */
const isSubmitterStep = (step: Pick<ApprovalStep, 'scope'>) => step.scope === 'SUBMITTER';

/**
 * The documents a credit request must still have, live, when its last step
 * creates the customer — read from the shape of the chain frozen on the request,
 * never from today's switches:
 *   - a chain frozen before these decisions (no signed-application step): at
 *     least one guarantee, exactly as it was submitted;
 *   - the new chain: the four credit documents and the signed application.
 *     Guarantees are bound when present and never required.
 */
export function requiredAtFinalize(chain: ReadonlyArray<Pick<ApprovalStep, 'scope'>>): DecisionBoundKind[] {
  return chain.some(isSubmitterStep) ? [...CREDIT_DOCUMENT_KINDS, SIGNED_FORM_KIND] : ['GUARANTEE'];
}

export function isDecisionBoundKind(kind: string): kind is DecisionBoundKind {
  return (DECISION_BOUND_KINDS as readonly string[]).includes(kind);
}

export function isConfidentialKind(kind: string): boolean {
  return (CONFIDENTIAL_KINDS as readonly string[]).includes(kind);
}
