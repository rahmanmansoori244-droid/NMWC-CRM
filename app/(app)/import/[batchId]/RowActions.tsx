'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  correctImportRowAction,
  excludeImportRowsAction,
  includeImportRowAction,
  recheckImportRowAction,
  releaseImportRowPhoneAction,
  withdrawImportRowFixAction,
} from '@/services/import-fixes';
import { CELL_LABEL } from '@/lib/import-row-fix';
import type { ActionResult } from '@/lib/errors';

/**
 * The Data Steward's actions on one held-back or rejected import row (item 20):
 * re-check it, correct the cells its problem names, release a shared phone, or
 * accept it as excluded. What each row offers is worked out on the server page
 * from the same rules the server actions enforce (lib/import-row-fix.ts).
 */
type Result = ActionResult<unknown>;

const text = (r: Result) => (r.ok ? '' : r.fields ? Object.values(r.fields).join(' ') : r.message);

export function RowActions({
  rowId,
  batchId,
  state,
  editable,
  current,
  canRelease,
  canRecheck,
  excluded,
  superseded,
}: {
  rowId: string;
  batchId: string;
  /** CLEAN only for a row fixed in the app and waiting to be promoted. */
  state: 'QUARANTINED' | 'REJECTED' | 'CLEAN';
  /** Cells the row's problem names, in form order. */
  editable: string[];
  /** Each editable cell's value now: corrected if corrected, else as uploaded. */
  current: Record<string, string>;
  canRelease: boolean;
  /** False once the 90-day retention sweep has cleared the row's data. */
  canRecheck: boolean;
  excluded: { by: string; reason: string } | null;
  /**
   * Why a newer upload of the same customer rules out fixing this row (the
   * server refuses it with the same words); only Exclude is offered then.
   */
  superseded?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState<'correct' | 'release' | 'exclude' | null>(null);
  const [cells, setCells] = useState<Record<string, string>>(current);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  function run(
    action: (fd: FormData) => Promise<Result>,
    fd: FormData,
    okText: (r: Result) => string
  ) {
    setMsg(null);
    start(async () => {
      try {
        const res = await action(fd);
        if (!res.ok) {
          setMsg({ tone: 'error', text: text(res) });
          return;
        }
        setMsg({ tone: 'ok', text: okText(res) });
        setOpen(null);
        setReason('');
        router.refresh();
      } catch (err) {
        setMsg({ tone: 'error', text: err instanceof Error ? err.message : 'Failed.' });
      }
    });
  }

  const fixed = (r: Result) => {
    const d = r.ok ? (r.data as { clean?: number; held?: number } | undefined) : undefined;
    if (!d) return 'Done.';
    if (d.held && d.held > 0)
      return `Still held back — see the reasons. ${d.clean ?? 0} row(s) ready to promote.`;
    return `Ready to promote (${d.clean} row${d.clean === 1 ? '' : 's'}). Promote the batch to load it.`;
  };
  const withRow = (extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set('rowId', rowId);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return fd;
  };

  if (state === 'CLEAN') {
    // A fix already made, waiting to be promoted: it can be taken back — before
    // this, a mistyped correction had to be loaded or the batch never promoted.
    return (
      <div className="grid gap-1 text-xs">
        <p className="text-slate-600">Fixed in the app — loads on the next promote.</p>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (!confirm('Withdraw this fix? The row goes back to what it was before you fixed it, and your corrections are dropped.')) return;
            run(withdrawImportRowFixAction, withRow(), () => 'Fix withdrawn.');
          }}
          className="min-h-9 justify-self-start rounded-md border border-slate-300 bg-white px-3 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Withdraw fix
        </button>
        {msg && <Note msg={msg} />}
      </div>
    );
  }

  if (excluded) {
    return (
      <div className="grid gap-1 text-xs">
        <p className="text-slate-600">
          Excluded by {excluded.by}: <span className="italic">{excluded.reason}</span>
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(includeImportRowAction, withRow(), () => 'Included again.')}
          className="min-h-9 justify-self-start rounded-md border border-slate-300 bg-white px-3 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Include again
        </button>
        {msg && <Note msg={msg} />}
      </div>
    );
  }

  return (
    <div className="grid gap-2 text-xs">
      {superseded && <p className="text-slate-600">{superseded}</p>}
      {!canRecheck && (
        <p className="text-slate-500">
          This row&rsquo;s data was cleared by the 90-day retention sweep. Upload the corrected row
          again, or exclude it.
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {canRecheck && !superseded && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(recheckImportRowAction, withRow(), fixed)}
            title={
              state === 'REJECTED'
                ? 'Try this customer again as it stands. Its other rejected rows in this batch go with it.'
                : 'Check this row again against the master as it is now.'
            }
            className="min-h-9 rounded-md border border-slate-300 bg-white px-3 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Re-check
          </button>
        )}
        {editable.length > 0 && !superseded && (
          <button
            type="button"
            disabled={pending}
            aria-expanded={open === 'correct'}
            onClick={() => {
              // Start from the row as it stands now. The form's state outlived
              // router.refresh, so after a partial fix it still held a cell the
              // row no longer names, and every later save was refused for it.
              if (open !== 'correct') setCells(current);
              setOpen(open === 'correct' ? null : 'correct');
            }}
            className="min-h-9 rounded-md border border-slate-300 bg-white px-3 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Correct…
          </button>
        )}
        {canRelease && !superseded && (
          <button
            type="button"
            disabled={pending}
            aria-expanded={open === 'release'}
            onClick={() => setOpen(open === 'release' ? null : 'release')}
            className="min-h-9 rounded-md border border-amber-300 bg-amber-50 px-3 font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            Release shared phone…
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          aria-expanded={open === 'exclude'}
          onClick={() => setOpen(open === 'exclude' ? null : 'exclude')}
          className="min-h-9 rounded-md border border-slate-300 bg-white px-3 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Exclude…
        </button>
      </div>

      {open === 'correct' && (
        <form
          className="grid gap-2 rounded-md bg-slate-50 p-2 ring-1 ring-slate-200"
          onSubmit={(e) => {
            e.preventDefault();
            // Only the cells this row names now, and only those the Steward changed.
            const sent = Object.fromEntries(
              editable
                .filter((c) => (cells[c] ?? '').trim() !== (current[c] ?? '').trim())
                .map((c) => [c, cells[c] ?? ''])
            );
            if (Object.keys(sent).length === 0) {
              setMsg({ tone: 'error', text: 'Nothing changed. Use Re-check to check the row as it stands.' });
              return;
            }
            run(correctImportRowAction, withRow({ cells: JSON.stringify(sent) }), fixed);
          }}
        >
          {editable.map((c) => (
            <label key={c} className="grid gap-0.5">
              <span className="font-medium text-slate-700">{CELL_LABEL[c] ?? c}</span>
              <input
                id={`fix-${rowId}-${c}`}
                value={cells[c] ?? current[c] ?? ''}
                onChange={(e) => setCells({ ...cells, [c]: e.target.value })}
                className="min-h-9 rounded-md border border-slate-300 px-2 text-slate-900"
              />
            </label>
          ))}
          <p className="text-slate-500">
            Only the cells this row&rsquo;s problem names can be changed. Payment terms, credit and
            the Temix code never can.
          </p>
          <button
            type="submit"
            disabled={pending}
            className="min-h-9 justify-self-start rounded-md bg-slate-900 px-3 font-semibold text-white disabled:bg-slate-300"
          >
            {pending ? 'Checking…' : 'Save and re-check'}
          </button>
        </form>
      )}

      {(open === 'release' || open === 'exclude') && (
        <form
          className="grid gap-2 rounded-md bg-slate-50 p-2 ring-1 ring-slate-200"
          onSubmit={(e) => {
            e.preventDefault();
            if (open === 'release') {
              run(releaseImportRowPhoneAction, withRow({ reason }), fixed);
            } else {
              const fd = new FormData();
              fd.set('batchId', batchId);
              fd.set('rowIds', JSON.stringify([rowId]));
              fd.set('reason', reason);
              run(excludeImportRowsAction, fd, () => 'Excluded.');
            }
          }}
        >
          <label className="grid gap-0.5">
            <span className="font-medium text-slate-700">
              {open === 'release'
                ? 'Why may this phone be shared? (for example: same owner, different shop)'
                : 'Why does this row stay out?'}
            </span>
            <input
              id={`${open}-${rowId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="min-h-9 rounded-md border border-slate-300 px-2 text-slate-900"
            />
          </label>
          <button
            type="submit"
            disabled={pending || reason.trim().length < 5}
            className="min-h-9 justify-self-start rounded-md bg-slate-900 px-3 font-semibold text-white disabled:bg-slate-300"
          >
            {open === 'release' ? 'Release and re-check' : 'Exclude this row'}
          </button>
        </form>
      )}

      {msg && <Note msg={msg} />}
    </div>
  );
}

/** Accept every held-back or rejected row still open in this batch as excluded. */
export function ExcludeRemaining({ batchId, count }: { batchId: string; count: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  if (count === 0) return null;
  return (
    <div className="grid gap-2 text-xs">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="min-h-9 justify-self-start rounded-md border border-slate-300 bg-white px-3 font-medium text-slate-700 hover:bg-slate-50"
        >
          Exclude all {count.toLocaleString('en-US')} remaining…
        </button>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (
              !confirm(
                `Accept all ${count} remaining held-back or rejected rows as excluded? They stay out of the master.`
              )
            )
              return;
            const fd = new FormData();
            fd.set('batchId', batchId);
            fd.set('rowIds', 'all');
            fd.set('reason', reason);
            setMsg(null);
            start(async () => {
              const res = await excludeImportRowsAction(fd);
              if (!res.ok) {
                setMsg({ tone: 'error', text: text(res) });
                return;
              }
              setOpen(false);
              router.refresh();
            });
          }}
        >
          <label className="grid gap-0.5">
            <span className="font-medium text-slate-700">Why do they stay out?</span>
            <input
              id={`exclude-all-${batchId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="min-h-9 w-72 max-w-full rounded-md border border-slate-300 px-2 text-slate-900"
            />
          </label>
          <button
            type="submit"
            disabled={pending || reason.trim().length < 5}
            className="min-h-9 rounded-md bg-slate-900 px-3 font-semibold text-white disabled:bg-slate-300"
          >
            Exclude all remaining
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="min-h-9 rounded-md border border-slate-300 bg-white px-3 font-medium text-slate-700"
          >
            Cancel
          </button>
        </form>
      )}
      {msg && <Note msg={msg} />}
    </div>
  );
}

function Note({ msg }: { msg: { tone: 'ok' | 'error'; text: string } }) {
  return (
    <p
      role={msg.tone === 'error' ? 'alert' : 'status'}
      className={msg.tone === 'error' ? 'text-red-700' : 'text-emerald-700'}
    >
      {msg.text}
    </p>
  );
}
