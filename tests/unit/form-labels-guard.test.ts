/**
 * Every <label> on the forms a salesman, a manager or an approver uses names a
 * control (launch browser suite follow-up, 8 Oct).
 *
 * The suite found labels that named nothing: a bare <label> beside a bare
 * <select> or <textarea> on the reject form, every field of Create user, the
 * reason box of a close request, and captions over photo slots and the GPS
 * capture written as <label>s with no control to point at. Each was fixed in
 * place (htmlFor + useId, or a caption that names its role=group). This keeps
 * them fixed: a label here either points at its control (htmlFor) or wraps it.
 * A caption over a group of controls is not a <label> (LabeledField.tsx
 * groupNamedBy).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const FILES = [
  // Approvals and reactivation decisions.
  'app/(app)/approvals/[id]/ApproveRejectActions.tsx',
  'app/(app)/approvals/BulkApprovalQueue.tsx',
  'app/(app)/reactivations/ReactivationDecisionForm.tsx',
  // New customer, update (enrich), close / reactivation, archive.
  'app/(app)/customers/new/CreateCustomerForm.tsx',
  'app/(app)/customers/[id]/edit/EnrichmentForm.tsx',
  'app/(app)/customers/[id]/ArchiveCustomerButton.tsx',
  'components/nmwc/BranchStatusActions.tsx',
  'components/nmwc/LabeledField.tsx',
  'components/nmwc/GpsCaptureButton.tsx',
  'components/nmwc/PhotoCaptureSlot.tsx',
  'components/nmwc/StepperInput.tsx',
  // The customers list's filters.
  'app/(app)/customers/CustomerFiltersClient.tsx',
  'components/nmwc/MultiSelectFilter.tsx',
  // Profile, sign-in, and the users page a Manager works on.
  'app/(app)/profile/change-password/ChangePasswordForm.tsx',
  'components/nmwc/LoginForm.tsx',
  'app/(app)/users/CreateUserForm.tsx',
  'app/(app)/users/EditAccount.tsx',
  'app/(app)/users/UserRowActions.tsx',
];

const CONTROLS = new Set(['input', 'select', 'textarea']);

/** Each <label> of the source that neither points at a control nor wraps one. */
function labelsNamingNothing(src: string, file: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const tagOf = (n: ts.Node): string | null =>
    ts.isJsxElement(n)
      ? n.openingElement.tagName.getText(sf)
      : ts.isJsxSelfClosingElement(n)
        ? n.tagName.getText(sf)
        : null;
  const wrapsControl = (n: ts.Node): boolean => {
    let found = false;
    const visit = (c: ts.Node) => {
      if (found) return;
      if (CONTROLS.has(tagOf(c) ?? '')) found = true;
      else ts.forEachChild(c, visit);
    };
    ts.forEachChild(n, visit);
    return found;
  };
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (tagOf(n) === 'label') {
      const attrs = ts.isJsxElement(n) ? n.openingElement.attributes : (n as ts.JsxSelfClosingElement).attributes;
      const pointsAt = attrs.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'htmlFor');
      if (!pointsAt && !wrapsControl(n)) {
        out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('the measure', () => {
  it('finds a bare label beside its control, and passes one tied to it or wrapping it', () => {
    const page = (body: string) => `export const F = () => (<div>${body}</div>);`;
    expect(labelsNamingNothing(page('<label>Category</label><select />'), 'bare.tsx')).toEqual(['bare.tsx:1']);
    expect(labelsNamingNothing(page('<label>Photos</label><Slot />'), 'caption.tsx')).toEqual(['caption.tsx:1']);
    expect(labelsNamingNothing(page('<label htmlFor={id}>Category</label><select id={id} />'), 'tied.tsx')).toEqual([]);
    expect(labelsNamingNothing(page('<label>Reason<span>*</span><textarea /></label>'), 'wraps.tsx')).toEqual([]);
  });
});

describe('every label on these forms names a control', () => {
  it.each(FILES)('%s', (file) => {
    expect(labelsNamingNothing(readFileSync(file, 'utf8'), file)).toEqual([]);
  });
});
