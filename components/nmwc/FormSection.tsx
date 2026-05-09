import { ChevronDown, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

export function FormSection({
  title,
  description,
  locked,
  children,
  defaultOpen = true,
}: {
  title: string;
  description?: string;
  locked?: boolean;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      open={defaultOpen}
      className="group overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200"
    >
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 border-b border-transparent px-5 py-3 group-open:border-slate-200">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            {locked && <Lock className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />}
            {title}
          </h3>
          {description && <p className="text-xs text-slate-500">{description}</p>}
        </div>
        <ChevronDown className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className={cn('p-5', locked && 'bg-slate-50')}>{children}</div>
    </details>
  );
}
