'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { promoteCustomerBatchAction } from '@/services/imports';

/**
 * RK-3: a full customer master is far too large to promote in one request (the
 * serverless function is capped at 60s), so the server promotes a time-boxed slice
 * per call and reports what is left. This button drives those slices in a loop and
 * shows live progress; closing the tab is safe — the batch stays resumable.
 */
// Safety stop so a batch that somehow never completes cannot spin a tab forever.
// Sized for the real master: ~18,000 customers at a conservative 30 per pass is
// 600 passes — well inside this, so a healthy go-live load never pauses. Genuine
// livelock is caught much earlier by the no-progress check in the loop.
const MAX_SLICES = 2000;

export function PromoteButton({
  batchId,
  remainingCount,
  resume = false,
  leaseHeld = false,
}: {
  batchId: string;
  remainingCount: number;
  resume?: boolean;
  leaseHeld?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [tone, setTone] = useState<'ok' | 'warn'>('ok');
  const [live, setLive] = useState<{ promoted: number; failed: number; left: number } | null>(null);

  function say(text: string, t: 'ok' | 'warn' = 'ok') {
    setMsg(text);
    setTone(t);
  }

  function onClick() {
    if (
      !resume &&
      !confirm(
        `Promote ${remainingCount} clean rows to live customer master? This creates customer + branch records.`
      )
    )
      return;

    start(async () => {
      // A fresh run starts from a clean slate — otherwise a resumed promote shows
      // the previous run's totals and its stale warning for the whole first pass.
      setMsg(null);
      setLive(null);
      let promoted = 0;
      let failed = 0;
      // Proves to the server that this run still owns the batch, so it can continue
      // straight into its next slice instead of waiting out its own lease.
      let token = '';
      // Every slice must leave FEWER rows outstanding than it found. Tracking that
      // directly is the reliable stall check: a group that fails AND fails to be
      // marked rejected stays outstanding, and would otherwise be retried forever.
      let lastRemaining = Number.POSITIVE_INFINITY;
      try {
        for (let slice = 0; slice < MAX_SLICES; slice++) {
          const fd = new FormData();
          fd.set('batchId', batchId);
          if (token) fd.set('leaseToken', token);
          // PROD-006: action returns `{ ok, code, message, fields? }` — a batch held
          // by another steward surfaces its real reason, not a generic render error.
          const res = await promoteCustomerBatchAction(fd);
          if (!res.ok) {
            say(res.fields ? Object.values(res.fields).join(' ') : res.message, 'warn');
            router.refresh();
            return;
          }
          promoted += res.data.promoted;
          failed += res.data.failed;
          token = res.data.leaseToken ?? '';
          setLive({ promoted, failed, left: res.data.remaining });

          if (res.data.done) {
            // "in this run" because a RESUMED batch promoted the rest of its rows in
            // an earlier run — the batch total is on the page, not in this counter.
            // `failed` counts CUSTOMERS while `promoted` counts ROWS, so name both.
            say(
              `✓ Done — ${promoted.toLocaleString()} rows promoted in this run${failed ? ` · ${failed} customer(s) failed` : ''}.`
            );
            router.refresh();
            return;
          }
          // The server withholds the token when it no longer owns the batch — that
          // run is over, and carrying on would fight whoever took it over.
          if (!token) {
            say('Another promote took over this batch — refresh to see its progress.', 'warn');
            router.refresh();
            return;
          }
          // A slice that moved nothing would repeat forever — stop and let the
          // steward look at the rejected rows rather than hammering the server.
          if (res.data.remaining >= lastRemaining) {
            say(
              `Stopped — ${res.data.remaining.toLocaleString()} rows made no progress. Review the rejected rows, then resume.`,
              'warn'
            );
            router.refresh();
            return;
          }
          lastRemaining = res.data.remaining;
        }
        say(`Paused after ${MAX_SLICES} passes. Click Resume to continue.`, 'warn');
        router.refresh();
      } catch (err) {
        // A network drop mid-load is expected on a big master: the committed slices
        // are already durable, so the honest message is "resume", not "failed".
        say(
          `${err instanceof Error ? err.message : 'Interrupted'} — progress is saved, click Resume to continue.`,
          'warn'
        );
        router.refresh();
      }
    });
  }

  const label = pending
    ? live
      ? `Promoting… ${live.promoted.toLocaleString()} done, ${live.left.toLocaleString()} left`
      : 'Promoting…'
    : resume
      ? remainingCount === 0
        ? // Every row is dealt with but the batch never got its final status (a slice
          // died right at the end). One more call finalises it — so the button must
          // stay clickable here, or the batch would be stuck in PROMOTING with no
          // way out of the UI.
          'Finish promote'
        : `Resume promote (${remainingCount.toLocaleString()} rows left)`
      : `Promote ${remainingCount.toLocaleString()} clean rows`;

  return (
    <div className="flex items-center gap-3">
      {msg && (
        <span
          className={`text-xs font-medium ${tone === 'warn' ? 'text-amber-700' : 'text-emerald-700'}`}
        >
          {msg}
        </span>
      )}
      {!pending && leaseHeld && (
        <span className="text-xs font-medium text-slate-500">
          Another promote is running — wait for it to finish.
        </span>
      )}
      <button
        type="button"
        disabled={pending || (remainingCount === 0 && !resume)}
        onClick={onClick}
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300"
      >
        {label}
      </button>
    </div>
  );
}
