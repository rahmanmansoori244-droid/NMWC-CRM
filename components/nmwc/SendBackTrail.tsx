/**
 * Code review 2026-11-10, finding 18 — who sent a request back, at which step and
 * when, and the earlier send-backs of the same round.
 *
 * The salesman cannot open the approver's page, the only place the per-step
 * trail was shown, so he read only the last approver's words: an Accountant's
 * precise reason, relayed by a Manager as "Please re-verify and resubmit", never
 * reached him. His own pages now show the whole round, read from the decision
 * rows (EditApproval) through lib/request-reasons.ts.
 *
 * These render the ADDED lines only. Each page keeps its own headline sentence
 * (the reason itself), so the words a salesman already knows — and the launch
 * e2e matches on — are unchanged.
 *
 * Plain markup, no hooks: rendered by server pages. `when` is each page's own
 * Oman-clock formatter (lib/tz.ts), so a date reads the same as beside it.
 */
import type { SendBack } from '@/lib/request-reasons';

type When = (at: Date) => string;

/**
 * "Sent back by {name} at the {Step} step, {when}." — with whatever is on
 * record. An older row has no step ("Sent back by {name}, {when}."), and one
 * with no reviewer only the time ("Sent back {when}."). Null when nothing is.
 */
export function sendBackWhoText(entry: SendBack, when: When): string | null {
  const by = entry.by ? ` by ${entry.by}` : '';
  const step = entry.step ? ` at the ${entry.step} step` : '';
  const at = entry.at ? `${by || step ? ',' : ''} ${when(entry.at)}` : '';
  if (!by && !step && !at) return null;
  return `Sent back${by}${step}${at}.`;
}

/** "{Step} step — {name}, {when}: {reason}" — one earlier send-back of the round. */
export function earlierSendBackText(entry: SendBack, when: When): string {
  const who = [entry.by, entry.at ? when(entry.at) : null].filter(Boolean).join(', ');
  return `${entry.step ?? 'Earlier'} step${who ? ` — ${who}` : ''}: ${entry.reason ?? 'no reason on record'}`;
}

/** "At the {Step} step" — for a page whose own sentence already says who and when. Null on an older row. */
export function atStepText(entry: SendBack): string | null {
  return entry.step ? `At the ${entry.step} step` : null;
}

export function SendBackWho({ entry, when, className }: { entry: SendBack; when: When; className?: string }) {
  const text = sendBackWhoText(entry, when);
  return text ? <p className={className}>{text}</p> : null;
}

export function EarlierSendBacks({
  earlier,
  when,
  heading = 'Earlier in this round:',
  className,
}: {
  /** Oldest first, as lib/request-reasons.ts returns them. */
  earlier: readonly SendBack[];
  when: When;
  heading?: string;
  className?: string;
}) {
  if (earlier.length === 0) return null;
  return (
    <div className={className}>
      <p className="font-semibold">{heading}</p>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
        {earlier.map((e, i) => (
          <li key={i}>{earlierSendBackText(e, when)}</li>
        ))}
      </ul>
    </div>
  );
}
