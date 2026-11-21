import { omanDateTime } from '@/lib/tz';
import type { WaitingRequest } from '@/lib/temix-daily-check';

/**
 * The pilot rule's banner (lib/temix-daily-check.ts pilotGate): while a
 * new-customer request waits at the Accountant, no daily file is applied. It
 * lists the requests; it does not end the rule (when it ends is the owner's).
 */
export function PilotBanner({ gate }: { gate: { stopped: boolean; waiting: WaitingRequest[] } }) {
  if (!gate.stopped) return null;
  const shown = gate.waiting.slice(0, 20);
  return (
    <div role="status" className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
      <p className="font-semibold">
        Pilot rule: {gate.waiting.length === 1 ? '1 new-customer request waits' : `${gate.waiting.length} new-customer requests wait`} at the
        Accountant, so no daily file can be applied until {gate.waiting.length === 1 ? 'it is' : 'they are'} decided.
      </p>
      <ul className="mt-1 space-y-0.5 text-xs">
        {shown.map((w) => (
          <li key={w.id}>
            Request <code>{w.id}</code>, submitted {w.submittedAt ? omanDateTime(w.submittedAt) : '(no date)'}
          </li>
        ))}
        {gate.waiting.length > shown.length && <li>and {gate.waiting.length - shown.length} more</li>}
      </ul>
    </div>
  );
}
