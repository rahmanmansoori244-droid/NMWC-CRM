'use client';

/**
 * UAT-07: the two `Field` helpers, merged, with the label actually associated
 * with its control.
 *
 * Both forms rendered `<label>Text</label>` followed by an `<input>` with nothing
 * tying them together. Visually identical, and two real losses: tapping the label
 * did not focus its field, which is a smaller one-handed target on every field of
 * the two forms salesmen use all day, and assistive technology or voice control
 * could not name a single field on either form.
 *
 * `htmlFor` + `id` rather than wrapping the control in the label, on purpose. It
 * fixes the association identically, but it leaves the label as the control's
 * immediately-preceding SIBLING — and `tests/e2e/golive-update-flow.spec.ts`
 * finds fields with `label:text-is("...") + input`, so wrapping would silently
 * break the go-live browser walk.
 *
 * `useId` rather than a slug of the label: the branch rows render the same
 * labels once per branch, and a label-derived id would collide across them.
 */
import { useId } from 'react';

export function LabeledField({
  label,
  value,
  onChange,
  placeholder,
  error,
  disabled,
  textarea,
  mono,
  inputMode,
  maxLength,
  type,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  textarea?: boolean;
  /** Monospace, for codes read back character by character. */
  mono?: boolean;
  inputMode?: 'decimal' | 'numeric';
  maxLength?: number;
  /**
   * 'tel' opens the phone keypad — digits and '+', which is everything
   * lib/phone.ts accepts. Never 'number': it drops the '+' and leading zeros.
   * Benchmark item 36: every phone field opened the full QWERTY keyboard.
   */
  type?: 'text' | 'tel';
  /**
   * The customer phone fields pass 'off'. 'tel' would offer the DEVICE OWNER's
   * number — the salesman's own — as a one-tap fill for a customer's phone.
   */
  autoComplete?: string;
}) {
  const id = useId();
  const cls = `block w-full rounded-md border-slate-300 px-3 py-2.5 text-base shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500 ${mono ? 'font-mono text-[15px]' : ''} ${disabled ? 'cursor-not-allowed bg-slate-100' : ''}`;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {textarea ? (
        <textarea
          id={id}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          maxLength={maxLength}
          onChange={(e) => onChange(e.currentTarget.value)}
          rows={2}
          className={cls}
        />
      ) : (
        <input
          id={id}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          type={type}
          inputMode={inputMode}
          autoComplete={autoComplete}
          maxLength={maxLength}
          onChange={(e) => onChange(e.currentTarget.value)}
          className={cls}
        />
      )}
      {error && <p className="mt-0.5 text-xs font-medium text-red-600">{error}</p>}
    </div>
  );
}
