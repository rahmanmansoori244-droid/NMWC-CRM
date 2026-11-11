'use client';

import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useDialogFocus } from '@/components/nmwc/useDialogFocus';
import { summariseCustomerBatchAction, type PromoteReview } from '@/services/import-review';
import { setImportOverwriteAction } from '@/services/import-fixes';
import { SHOP_NOT_CHANGED_MEANING } from '@/lib/import-shop-notice';

/**
 * "Before you promote" (code review 2026-11-10, finding 1).
 *
 * A fresh Promote used to ask one native question — "This creates customer +
 * branch records" — and then load the sheet over whatever was on record. The
 * Steward now sees what this sheet would do, counted against the CRM as it is:
 * what is created, which Temix-owned fields are refreshed, which CRM values
 * differ and are KEPT, which credit cells are not applied and why.
 *
 * The batch's one option is here and nowhere else: "Overwrite CRM fields from
 * this sheet". It is off unless the Steward switches it on with a reason, and
 * the summary is checked again under it before Promote can be pressed.
 */
const OPTION = 'Overwrite CRM fields from this sheet';
const MIN_REASON = 10;

const TONE: Record<PromoteReview['lines'][number]['tone'], string> = {
  plain: 'text-slate-700',
  warn: 'text-amber-800',
  danger: 'font-semibold text-red-700',
};

export function PromoteReviewDialog({
  batchId,
  remainingCount,
  canSetOverwrite,
  resume = false,
  onCancel,
  onPromote,
}: {
  batchId: string;
  remainingCount: number;
  /** The batch is ready to promote and nobody is promoting it: the option may change. */
  canSetOverwrite: boolean;
  /** Code review 2026-11-10, finding 6: a promote that stopped part-way is resumed through this review too. */
  resume?: boolean;
  onCancel: () => void;
  /** `skipNewer`: the Steward confirmed leaving out the customers a newer upload has loaded. */
  onPromote: (opts: { skipNewer: boolean }) => void;
}) {
  const router = useRouter();
  const titleId = useId();
  const reasonId = useId();
  const helpId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(dialogRef, { onClose: onCancel, initialFocus: cancelRef });

  const [review, setReview] = useState<PromoteReview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [reason, setReason] = useState('');
  const [optionError, setOptionError] = useState<string | null>(null);
  const [switching, startSwitch] = useTransition();
  // Code review 2026-11-10, finding 28: rows that will load without changing their shop.
  const [ackShops, setAckShops] = useState(false);
  // Finding 6: customers a newer upload has already loaded are left out only on this tick.
  const [skipNewer, setSkipNewer] = useState(false);
  const skipId = useId();
  const ackId = useId();

  const check = useCallback(async () => {
    setChecking(true);
    setFailed(null);
    try {
      const fd = new FormData();
      fd.set('batchId', batchId);
      const res = await summariseCustomerBatchAction(fd);
      if (res.ok) setReview(res.data);
      else setFailed(res.fields ? Object.values(res.fields).join(' ') : res.message);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The check could not be run.');
    } finally {
      setChecking(false);
    }
  }, [batchId]);

  useEffect(() => {
    void check();
  }, [check]);

  const on = review?.overwrite === true;

  function switchOption(next: boolean) {
    setOptionError(null);
    startSwitch(async () => {
      const fd = new FormData();
      fd.set('batchId', batchId);
      fd.set('on', next ? 'on' : 'off');
      if (next) fd.set('reason', reason.trim());
      const res = await setImportOverwriteAction(fd);
      if (!res.ok) {
        setOptionError(res.fields ? Object.values(res.fields).join(' ') : res.message);
        return;
      }
      setReason('');
      // The page's banner follows the batch; the summary is counted again under the new answer.
      router.refresh();
      await check();
    });
  }

  const count = remainingCount.toLocaleString('en-US');
  // Promote waits for the check: it is enabled once the summary is on screen, or
  // the check has failed and its message is — never while the answer is unknown.
  const crm = review?.summary?.crm;
  const notChanged = crm ? crm.linkedShops + crm.linkedNotAdded : 0;
  const routeNotChanged = crm ? crm.linkedRouteNotMoved : 0;
  // Finding 6: too old to promote — the server refuses it, so the button is not offered.
  const expired = review?.staged?.expired === true;
  const newerCount = review?.newer?.customers ?? 0;
  const canPromote =
    !checking &&
    !switching &&
    (review !== null || failed !== null) &&
    (notChanged === 0 || ackShops) &&
    !expired &&
    (newerCount === 0 || skipNewer);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-t-lg bg-white p-5 text-left shadow-xl sm:rounded-lg"
      >
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          {resume ? 'Before you resume' : 'Before you promote'}
        </h2>

        {/* Finding 6: when, by whom, and how old — before what it will do. */}
        {review?.staged && (
          <p data-testid="batch-staged" className="mt-3 text-sm text-slate-700">
            Uploaded {review.staged.uploadedAt} by {review.staged.uploadedBy} ({review.staged.age}).
            {resume ? ' Resuming loads the rows it has not loaded yet, as the lines below say.' : ''}
          </p>
        )}
        {review?.staged?.expired && (
          <p role="alert" className="mt-2 rounded-md bg-red-50 p-3 text-sm font-semibold text-red-700 ring-1 ring-inset ring-red-200">
            {review.staged.expiredMessage}
          </p>
        )}

        <div className="mt-3 text-sm" aria-live="polite">
          {checking && <p className="text-slate-600">Checking what this sheet will change…</p>}
          {!checking && failed && (
            <p role="alert" className="text-red-700">
              The check could not be run: {failed} You can still promote; each row will say what happened to it.
            </p>
          )}
          {!checking && review && (
            <ul className="grid gap-2">
              {review.lines.map((line, i) => (
                <li key={i} className={TONE[line.tone]}>
                  {line.text}
                </li>
              ))}
            </ul>
          )}
        </div>

        {review && !expired && newerCount > 0 && (
          <div
            data-testid="newer-loads"
            className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800 ring-1 ring-inset ring-red-300"
          >
            <p className="font-semibold">{review.newer.refusal}</p>
            <label htmlFor={skipId} className="mt-2 flex items-start gap-2">
              <input
                id={skipId}
                type="checkbox"
                checked={skipNewer}
                onChange={(e) => setSkipNewer(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Leave out these {newerCount.toLocaleString('en-US')} customer(s): their rows in this batch are rejected
                and not loaded, and the rest loads.
              </span>
            </label>
          </div>
        )}

        {review && notChanged > 0 && (
          <div className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
            <label htmlFor={ackId} className="flex items-start gap-2">
              <input
                id={ackId}
                type="checkbox"
                checked={ackShops}
                onChange={(e) => setAckShops(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                I understand that {notChanged.toLocaleString('en-US')} row(s) will be loaded with their shop NOT changed
                {routeNotChanged > 0
                  ? ` — ${routeNotChanged.toLocaleString('en-US')} of them carry a different route, and that route will NOT be applied`
                  : ''}
                . {SHOP_NOT_CHANGED_MEANING} Each such row is listed under &ldquo;Loaded with a warning&rdquo;.
              </span>
            </label>
          </div>
        )}

        {review && (
          <section className="mt-4 rounded-md bg-slate-50 p-3 text-sm ring-1 ring-inset ring-slate-200">
            <p className="font-semibold text-slate-900">
              {OPTION}: <span className={on ? 'text-red-700' : 'text-slate-700'}>{on ? 'ON' : 'off'}</span>
            </p>
            <p id={helpId} className="mt-1 text-xs text-slate-600">
              Off: customers and shops already in the CRM keep their name, phone, CR number, contact person,
              channel, address, visit day and open/closed status; this sheet only fills blanks. On: those values
              are replaced by this sheet&apos;s wherever it gives one — use it only for a deliberate bulk
              correction. Rows that carry the customer&apos;s own Temix code never change CRM fields, on or off.
            </p>
            {canSetOverwrite ? (
              on ? (
                <button
                  type="button"
                  disabled={switching || checking}
                  onClick={() => switchOption(false)}
                  className="mt-3 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:text-slate-400"
                >
                  Switch overwrite off
                </button>
              ) : (
                <div className="mt-3 grid gap-2">
                  <label htmlFor={reasonId} className="text-xs font-medium text-slate-700">
                    Why is this sheet correcting CRM fields? ({MIN_REASON}+ characters)
                  </label>
                  <input
                    id={reasonId}
                    type="text"
                    value={reason}
                    maxLength={500}
                    aria-describedby={helpId}
                    onChange={(e) => setReason(e.target.value)}
                    className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                  />
                  <div>
                    <button
                      type="button"
                      disabled={switching || checking || reason.trim().length < MIN_REASON}
                      onClick={() => switchOption(true)}
                      className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:border-slate-200 disabled:text-slate-400"
                    >
                      Switch on overwrite
                    </button>
                  </div>
                </div>
              )
            ) : (
              <p className="mt-2 text-xs text-slate-600">
                The option can be changed only while the batch is ready to promote and nobody is promoting it.
              </p>
            )}
            {optionError && (
              <p role="alert" className="mt-2 text-xs font-medium text-red-700">
                {optionError}
              </p>
            )}
          </section>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canPromote}
            onClick={() => onPromote({ skipNewer: newerCount > 0 && skipNewer })}
            className={`rounded-md px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300 ${
              on ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-600 hover:bg-brand-700'
            }`}
          >
            {resume ? (remainingCount === 0 ? 'Finish promote now' : `Resume promote now (${count} rows left)`) : `Promote ${count} clean rows now`}
          </button>
        </div>
      </div>
    </div>
  );
}
