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
 *
 * The follow-up of the same day did the filter and set-up forms: /export (Min
 * and Max completeness, Updated since), /routes (Create region and Create
 * route: Code, Name, Region) and /audit, whose filters had no label at all, only
 * a placeholder or a first option. A form with no <label> passes the first
 * measure, so a second holds every file here: each field a person fills in is
 * named, by a label (pointing at it or wrapping it) or an aria-label(ledby).
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
  // The filter and set-up forms of /export, /routes and /audit.
  'app/(app)/export/ExportFiltersForm.tsx',
  'app/(app)/routes/forms.tsx',
  'app/(app)/audit/page.tsx',
];

const CONTROLS = new Set(['input', 'select', 'textarea']);

const parse = (src: string, file: string) =>
  ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const tagIn = (sf: ts.SourceFile) => (n: ts.Node): string | null =>
  ts.isJsxElement(n)
    ? n.openingElement.tagName.getText(sf)
    : ts.isJsxSelfClosingElement(n)
      ? n.tagName.getText(sf)
      : null;
const attrsOf = (n: ts.JsxElement | ts.JsxSelfClosingElement) =>
  ts.isJsxElement(n) ? n.openingElement.attributes : n.attributes;

/** Each <label> of the source that neither points at a control nor wraps one. */
function labelsNamingNothing(src: string, file: string): string[] {
  const sf = parse(src, file);
  const tagOf = tagIn(sf);
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
      const attrs = attrsOf(n as ts.JsxElement | ts.JsxSelfClosingElement);
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

/**
 * Each field of the source (an input other than a hidden one, a select, a
 * textarea) that nothing names: no label wraps it, no label's htmlFor is written
 * as its id is, and it has no aria-label or aria-labelledby.
 */
function fieldsNamedByNothing(src: string, file: string): string[] {
  const sf = parse(src, file);
  const tagOf = tagIn(sf);
  /** An attribute's value as written: a string's text, or the expression's source. */
  const valueOf = (n: ts.JsxElement | ts.JsxSelfClosingElement, name: string): string | null => {
    const a = attrsOf(n).properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === name) as
      | ts.JsxAttribute
      | undefined;
    if (!a) return null;
    const init = a.initializer;
    if (!init) return 'true';
    const e = ts.isJsxExpression(init) ? init.expression : init;
    if (!e) return '';
    return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? JSON.stringify(e.text) : e.getText(sf);
  };
  const elements: (ts.JsxElement | ts.JsxSelfClosingElement)[] = [];
  const collect = (n: ts.Node): void => {
    if (tagOf(n) !== null) elements.push(n as ts.JsxElement | ts.JsxSelfClosingElement);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const pointedAt = new Set(
    elements.filter((n) => tagOf(n) === 'label').map((n) => valueOf(n, 'htmlFor')).filter((v) => v !== null)
  );
  const insideLabel = (n: ts.Node): boolean => {
    for (let p = n.parent; p; p = p.parent) if (tagOf(p) === 'label') return true;
    return false;
  };
  return elements
    .filter((n) => CONTROLS.has(tagOf(n)!) && valueOf(n, 'type') !== '"hidden"')
    .filter((n) => {
      const id = valueOf(n, 'id');
      const named =
        valueOf(n, 'aria-label') !== null ||
        valueOf(n, 'aria-labelledby') !== null ||
        insideLabel(n) ||
        (id !== null && pointedAt.has(id));
      return !named;
    })
    .map((n) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
}

describe('the measure', () => {
  it('finds a bare label beside its control, and passes one tied to it or wrapping it', () => {
    const page = (body: string) => `export const F = () => (<div>${body}</div>);`;
    expect(labelsNamingNothing(page('<label>Category</label><select />'), 'bare.tsx')).toEqual(['bare.tsx:1']);
    expect(labelsNamingNothing(page('<label>Photos</label><Slot />'), 'caption.tsx')).toEqual(['caption.tsx:1']);
    expect(labelsNamingNothing(page('<label htmlFor={id}>Category</label><select id={id} />'), 'tied.tsx')).toEqual([]);
    expect(labelsNamingNothing(page('<label>Reason<span>*</span><textarea /></label>'), 'wraps.tsx')).toEqual([]);
  });

  it('finds a field with only a placeholder, and passes one a label or an aria-label names', () => {
    const page = (body: string) => `export const F = () => (<form>${body}</form>);`;
    expect(fieldsNamedByNothing(page('<input name="q" placeholder="Search…" />'), 'bare.tsx')).toEqual(['bare.tsx:1']);
    expect(fieldsNamedByNothing(page('<select name="a"><option value="">All</option></select>'), 'sel.tsx')).toEqual([
      'sel.tsx:1',
    ]);
    expect(fieldsNamedByNothing(page('<label htmlFor="x">Other</label><input id="y" />'), 'wrong.tsx')).toEqual([
      'wrong.tsx:1',
    ]);
    expect(fieldsNamedByNothing(page('<label htmlFor="q">Q</label><input id="q" />'), 'tied.tsx')).toEqual([]);
    expect(fieldsNamedByNothing(page("<label htmlFor={`${u}-q`}>Q</label><input id={`${u}-q`} />"), 'uid.tsx')).toEqual([]);
    expect(fieldsNamedByNothing(page('<label>Q <input /></label>'), 'wraps.tsx')).toEqual([]);
    expect(fieldsNamedByNothing(page('<input aria-label="Q" /><textarea aria-labelledby="c" />'), 'aria.tsx')).toEqual([]);
    expect(fieldsNamedByNothing(page('<input type="hidden" name="actor" />'), 'hidden.tsx')).toEqual([]);
  });
});

describe('every label on these forms names a control', () => {
  it.each(FILES)('%s', (file) => {
    expect(labelsNamingNothing(readFileSync(file, 'utf8'), file)).toEqual([]);
  });
});

describe('every field on these forms is named', () => {
  it.each(FILES)('%s', (file) => {
    expect(fieldsNamedByNothing(readFileSync(file, 'utf8'), file)).toEqual([]);
  });
});
