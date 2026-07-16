'use client';

import { Minus, Plus } from 'lucide-react';

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
    <div className="flex items-center justify-between rounded-md border border-slate-300 bg-white px-3 py-2">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => set(value - 1)}
          disabled={disabled || value <= min}
          className="rounded-md border border-slate-300 p-1 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          aria-label={`Decrease ${label}`}
        >
          <Minus className="h-4 w-4" />
        </button>
        <input
          type="number"
          name={name}
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
          className="w-14 rounded-md border-0 bg-transparent text-center text-lg font-semibold tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <button
          type="button"
          onClick={() => set(value + 1)}
          disabled={disabled || value >= max}
          className="rounded-md border border-slate-300 p-1 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          aria-label={`Increase ${label}`}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
