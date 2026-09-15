/**
 * UAT-07 — the label is attached to its control, and still sits next to it.
 *
 * Two things had to be true at once, and only one of them is about accessibility:
 *
 *   1. `getByLabelText` must find the control. That is the fix — tapping the
 *      label focuses the field, and assistive technology can name it. Both forms
 *      previously rendered a bare `<label>` beside a bare `<input>`.
 *   2. The label must remain the control's immediately-preceding SIBLING.
 *      `tests/e2e/golive-update-flow.spec.ts` finds fields with
 *      `label:text-is("...") + input`, so wrapping the control inside the label —
 *      the other obvious way to associate them — would have silently broken the
 *      go-live browser walk, which is the one test that has caught the failures
 *      the unit suite could not see.
 *
 * The second is why the adjacency assertion is here rather than left implicit.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { LabeledField } from '@/components/nmwc/LabeledField';

afterEach(cleanup);

describe('LabeledField', () => {
  it('associates the label with an input', () => {
    render(<LabeledField label="Contact person" value="Ali" onChange={() => {}} />);
    const el = screen.getByLabelText('Contact person');
    expect(el.tagName).toBe('INPUT');
    expect((el as HTMLInputElement).value).toBe('Ali');
  });

  it('associates the label with a textarea', () => {
    render(<LabeledField label="Notes" value="" onChange={() => {}} textarea />);
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA');
  });

  it('keeps the label as the control immediately-preceding sibling', () => {
    // The e2e contract. `label + input` must still match.
    const { container } = render(
      <LabeledField label="Primary phone" value="" onChange={() => {}} />
    );
    expect(container.querySelector('label + input')).not.toBeNull();
    // And the control is NOT nested inside the label.
    expect(container.querySelector('label input')).toBeNull();
  });

  it('gives two fields on the same page different ids', () => {
    // The branch rows render the same labels once per branch. An id derived from
    // the label text would collide, and a duplicate id silently points every
    // label at the first control.
    const { container } = render(
      <>
        <LabeledField label="Day of visit" value="" onChange={() => {}} />
        <LabeledField label="Day of visit" value="" onChange={() => {}} />
      </>
    );
    const ids = [...container.querySelectorAll('input')].map((i) => i.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(new Set(ids).size).toBe(2);
  });

  it('carries the props both original helpers had', () => {
    // Merged from two local copies: only the edit form passed `mono`, only the
    // create form passed `inputMode` and `maxLength`. Losing either silently
    // changes how a field behaves on a phone keypad.
    const { container } = render(
      <LabeledField
        label="Credit limit"
        value=""
        onChange={() => {}}
        inputMode="decimal"
        maxLength={12}
        mono
        error="Required"
      />
    );
    const input = container.querySelector('input')!;
    expect(input.getAttribute('inputmode')).toBe('decimal');
    expect(input.getAttribute('maxlength')).toBe('12');
    expect(input.className).toContain('font-mono');
    expect(screen.getByText('Required')).toBeTruthy();
  });

  it('marks a disabled field disabled, not merely grey', () => {
    const { container } = render(
      <LabeledField label="Locked" value="x" onChange={() => {}} disabled />
    );
    expect(container.querySelector('input')!.disabled).toBe(true);
  });
});
