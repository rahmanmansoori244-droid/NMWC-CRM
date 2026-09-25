'use client';

import { Minus, Plus } from 'lucide-react';

/**
 * 44×44 CSS px, the minimum tap target (WCAG 2.5.5, Apple HIG; docs/UX-SPEC.md).
 * Benchmark item 39: the buttons were `p-1` around a 16px icon inside a 1px
 * border — 26×26 — and a salesman counting coolers one-handed missed them.
 * tests/unit/mobile-quick-wins.test.tsx measures the compiled CSS.
 */
const STEP_BUTTON =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-40';

export function StepperInput({
  name,
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  disabled,
}: {
  name: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  /** Read-only rendering — all three controls inert. */
  disabled?: boolean;
}) {
  function set(v: number) {
    if (disabled) return;
    if (v < min) v = min;
    if (v > max) v = max;
    onChange(v);
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-slate-300 bg-white px-3 py-2">
      <span className="flex-1 text-sm font-medium text-slate-700">{label}</span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => set(value - 1)}
          disabled={disabled || value <= min}
          className={STEP_BUTTON}
          aria-label={`Decrease ${label}`}
        >
          <Minus className="h-5 w-5" />
        </button>
        <input
          type="number"
          name={name}
          // The caption beside this control is a <span>, not a <label>, so the
          // field itself had no accessible name: three of these per branch were
          // announced as an unnamed spin button with a number in it. Naming the
          // input directly rather than converting the span, because the two
          // buttons flanking it already take their names the same way.
          aria-label={label}
          value={value}
          min={min}
          max={max}
          // UXI-013: Android `type=number` allows comma decimals which silently
          // produced NaN under `Number(...)`. Clamp inputMode to numeric keypad,
          // strip non-digits, and parse safely to avoid the NaN→empty bug.
          inputMode="numeric"
          pattern="[0-9]*"
          disabled={disabled}
          onChange={(e) => {
            const raw = e.currentTarget.value.replace(/[^0-9]/g, '');
            if (!raw) {
              set(min);
              return;
            }
            const n = parseInt(raw, 10);
            if (Number.isFinite(n)) set(n);
          }}
          className="h-11 w-14 rounded-md border-0 bg-transparent text-center text-lg font-semibold tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <button
          type="button"
          onClick={() => set(value + 1)}
          disabled={disabled || value >= max}
          className={STEP_BUTTON}
          aria-label={`Increase ${label}`}
        >
          <Plus className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
