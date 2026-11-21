'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { discardTemixDailyFileAction, runTemixDailySliceAction, startTemixDailyApplyAction } from '@/services/temix-daily-apply';
import { APPLY_FIELDS, type ApplyFigures } from '@/lib/temix-daily-apply';

type Tone = 'ok' | 'warn' | 'fail';
const TONE: Record<Tone, string> = { ok: 'text-emerald-700', warn: 'text-amber-700', fail: 'text-red-600' };

const n = (x: number) => x.toLocaleString('en-US');

const why = (r: { ok: false; message: string; fields?: Record<string, string> }) => (r.fields ? Object.values(r.fields).join(' ') : r.message);

/**
 * Runs slices until the load is done, stopped or refused. Each slice is one
 * short request (one customer per transaction inside it), so closing the tab or
 * the end of the sign-in loses nothing: Resume carries on from the rows left.
 */
async function runSlices(fileId: string, token: string | undefined, say: (tone: Tone, text: string) => void): Promise<void> {
  let lease = token;
  let applied = 0;
  let noChange = 0;
  let held = 0;
  for (let i = 0; i < 10_000; i++) {
    const fd = new FormData();
    fd.set(APPLY_FIELDS.fileId, fileId);
    if (lease) fd.set(APPLY_FIELDS.leaseToken, lease);
    const res = await runTemixDailySliceAction(fd);
    if (!res.ok) {
      say('fail', why(res));
      return;
    }
    const d = res.data;
    applied += d.applied;
    noChange += d.noChange;
    held += d.held;
    if (d.stopped === 'PILOT') {
      say('warn', 'Stopped by the pilot rule: a new-customer request waits at the Accountant. Resume once it is decided.');
      return;
    }
    if (d.done) {
      say('ok', `Loaded. This run: ${n(applied)} shops moved, ${n(noChange)} rows changed nothing, ${n(held)} held.`);
      return;
    }
    say('ok', `Applying: ${n(applied)} shops moved so far, ${n(d.remaining)} rows to go.`);
    if (d.conflicts + d.failed > 0 && d.applied + d.noChange + d.held === 0) {
      say('warn', `${n(d.conflicts + d.failed)} customers could not be applied just now. Their rows wait: press Resume to try them again.`);
      return;
    }
    lease = d.leaseToken;
  }
}

export function TemixDailyApplyForm({
  fileId,
  figures,
  sameBytes,
}: {
  fileId: string;
  figures: ApplyFigures;
  sameBytes: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null);
  const say = (tone: Tone, text: string) => setMsg({ tone, text });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const res = await startTemixDailyApplyAction(fd);
      if (!res.ok) {
        say('fail', why(res));
        return;
      }
      await runSlices(fileId, res.data.leaseToken, say);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 text-sm">
      <input type="hidden" name={APPLY_FIELDS.fileId} value={fileId} />
      <input type="hidden" name={APPLY_FIELDS.moves} value={figures.moves} />
      <input type="hidden" name={APPLY_FIELDS.crossRegion} value={figures.crossRegion} />
      <input type="hidden" name={APPLY_FIELDS.reversals} value={figures.reversals} />
      <label className="flex items-start gap-2">
        <input type="checkbox" name={APPLY_FIELDS.confirmed} value="1" required className="mt-1" />
        <span>
          I have checked the figures: {n(figures.moves)} shops move ({n(figures.crossRegion)} into another region),{' '}
          {n(figures.held)} rows are held, {n(figures.missing)} customers are not in the file. Changes are dated the load day.
        </span>
      </label>
      {figures.reversals > 0 && (
        <label className="flex items-start gap-2 rounded-md bg-red-50 p-3 text-red-800 ring-1 ring-red-200">
          <input type="checkbox" name={APPLY_FIELDS.reversalTick} value="1" required className="mt-1" />
          <span>
            {n(figures.reversals)} move{figures.reversals === 1 ? '' : 's'} put shops back on the route an earlier file moved
            them from. This may be an old file. I have checked it and want to apply them.
          </span>
        </label>
      )}
      {sameBytes && (
        <label className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-amber-900 ring-1 ring-amber-200">
          <input type="checkbox" name={APPLY_FIELDS.sameBytesTick} value="1" required className="mt-1" />
          <span>This file is exactly the same as an earlier day&apos;s. I want to apply it all the same.</span>
        </label>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300"
      >
        {pending ? 'Applying…' : 'Apply the route moves'}
      </button>
      {msg && (
        <p role={msg.tone === 'fail' ? 'alert' : 'status'} className={`text-xs font-medium ${TONE[msg.tone]}`}>
          {msg.text}
        </p>
      )}
    </form>
  );
}

export function TemixDailyResumeButton({ fileId }: { fileId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await runSlices(fileId, undefined, (tone, text) => setMsg({ tone, text }));
            router.refresh();
          })
        }
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300"
      >
        {pending ? 'Applying…' : 'Resume'}
      </button>
      {msg && (
        <p role={msg.tone === 'fail' ? 'alert' : 'status'} className={`text-xs font-medium ${TONE[msg.tone]}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

export function TemixDailyDiscardForm({ fileId }: { fileId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start(async () => {
          const res = await discardTemixDailyFileAction(fd);
          if (!res.ok) {
            setMsg(why(res));
            return;
          }
          router.refresh();
        });
      }}
      className="space-y-2 text-sm"
    >
      <input type="hidden" name={APPLY_FIELDS.fileId} value={fileId} />
      <label className="block text-xs font-medium text-slate-700" htmlFor={`discard-${fileId}`}>
        Reason for discarding (kept with the file)
      </label>
      <input
        id={`discard-${fileId}`}
        name={APPLY_FIELDS.reason}
        required
        minLength={3}
        maxLength={500}
        className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-red-700 ring-1 ring-red-300 hover:bg-red-50 disabled:text-slate-400"
      >
        {pending ? 'Discarding…' : 'Discard this file'}
      </button>
      {msg && (
        <p role="alert" className="text-xs font-medium text-red-600">
          {msg}
        </p>
      )}
    </form>
  );
}
