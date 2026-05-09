import { cn } from '@/lib/utils';
import { completenessBand } from '@/lib/completeness';

const BAND_COLOR: Record<'high' | 'medium' | 'low', string> = {
  high: 'text-emerald-600',
  medium: 'text-amber-500',
  low: 'text-red-600',
};

export function CompletenessRing({
  value,
  size = 40,
  strokeWidth = 4,
  className,
  label,
}: {
  value: number;
  size?: number;
  strokeWidth?: number;
  className?: string;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
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
          className={cn('transition-[stroke-dashoffset] duration-500', BAND_COLOR[band])}
        />
      </svg>
      <span className={cn('absolute text-xs font-semibold', BAND_COLOR[band])}>{pct}</span>
    </div>
  );
}
