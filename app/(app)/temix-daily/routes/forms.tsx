'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addTemixRouteMapAction, retireTemixRouteMapAction } from '@/services/temix-daily-routes';

type Result = { ok: boolean; text: string } | null;

const failText = (res: { message: string; fields?: Record<string, string> }) =>
  res.fields ? Object.values(res.fields).join(' ') : res.message;

/** Add a route-map entry: the Temix code, the CRM route, and where it comes from. */
export function AddRouteMapEntryForm({ routes }: { routes: Array<{ id: string; label: string }> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setResult(null);
    start(async () => {
      const res = await addTemixRouteMapAction(fd);
      if (!res.ok) return setResult({ ok: false, text: failText(res) });
      setResult({ ok: true, text: `Added: ${res.data.code}. Open a file's check again to see it used.` });
      form.reset();
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2 text-sm">
      <label className="block">
        <span className="text-xs font-medium text-slate-700">Temix route code</span>
        <input name="code" required maxLength={40} className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-slate-700">CRM route</span>
        <select name="routeId" required defaultValue="" className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5">
          <option value="" disabled>
            Pick a route
          </option>
          {routes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-xs font-medium text-slate-700">Reason (where this comes from)</span>
        <input name="reason" required minLength={3} maxLength={300} className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5" />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300"
      >
        {pending ? 'Adding…' : 'Add the entry'}
      </button>
      {result && (
        <p role={result.ok ? 'status' : 'alert'} className={`text-xs font-medium ${result.ok ? 'text-emerald-700' : 'text-red-600'}`}>
          {result.text}
        </p>
      )}
    </form>
  );
}

/** Retire one entry, with a reason. */
export function RetireRouteMapEntryForm({ id, code }: { id: string; code: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setResult(null);
    start(async () => {
      const res = await retireTemixRouteMapAction(fd);
      if (!res.ok) return setResult({ ok: false, text: failText(res) });
      setResult({ ok: true, text: 'Retired.' });
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-1 text-xs">
      <input type="hidden" name="id" value={id} />
      <input
        name="reason"
        required
        minLength={3}
        maxLength={300}
        placeholder="Reason"
        aria-label={`Reason to retire the entry for ${code}`}
        className="w-36 rounded border border-slate-300 px-1.5 py-1"
      />
      <button type="submit" disabled={pending} className="rounded border border-slate-300 px-2 py-1 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
        {pending ? '…' : 'Retire'}
      </button>
      {result && (
        <span role={result.ok ? 'status' : 'alert'} className={result.ok ? 'text-emerald-700' : 'text-red-600'}>
          {result.text}
        </span>
      )}
    </form>
  );
}
