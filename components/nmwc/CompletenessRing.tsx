import { cn } from '@/lib/utils';
import { completenessBand, completenessPct } from '@/lib/completeness';

/** The ring's stroke (a graphic: 3:1 against white is enough, WCAG 1.4.11). */
const STROKE_COLOR: Record<'high' | 'medium' | 'low', string> = {
  high: 'text-emerald-600',
  medium: 'text-amber-500',
  low: 'text-red-600',
};

/** The number inside (text: 4.5:1 against white, WCAG 1.4.3). */
const TEXT_COLOR: Record<'high' | 'medium' | 'low', string> = {
  high: 'text-emerald-700',
  medium: 'text-amber-700',
  low: 'text-red-700',
};

export function CompletenessRing({
  value,
  max = 100,
  size = 40,
  strokeWidth = 4,
  className,
  label,
}: {
  value: number;
  /** Scale ceiling for `value`: 100 for a customer score, 60 for a branch score. */
  max?: number;
  size?: number;
  strokeWidth?: number;
  className?: string;
  label?: string;
}) {
  // final-hunt #13: normalize to a 0-100 percentage against the correct scale max
  // so a branch (0-60) can reach 'high'/green, not just customers (0-100).
  const pct = completenessPct(value, max);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;
  const band = completenessBand(pct);

  return (
    <div
      className={cn('relative inline-flex items-center justify-center', className)}
      style={{ width: size, height: size }}
      aria-label={label ?? `Completeness ${pct}%`}
      role="img"
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-slate-200"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={cn('transition-[stroke-dashoffset] duration-500', STROKE_COLOR[band])}
        />
      </svg>
      <span className={cn('absolute text-xs font-semibold', TEXT_COLOR[band])}>{pct}</span>
    </div>
  );
}
