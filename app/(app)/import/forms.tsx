'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { uploadAccountMasterAction, uploadCustomerMasterAction } from '@/services/imports';
import type { ActionResult } from '@/lib/errors';
import { MAX_IMPORT_BYTES, importFileTooLarge } from '@/lib/import-file-size';

type UploadOk = Record<string, string | number>;

type Tone = 'ok' | 'warn' | 'fail';
const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-emerald-700',
  warn: 'text-amber-700',
  fail: 'text-red-600',
};

/**
 * Launch fix: every upload the server accepted read as a green "Uploaded — 0
 * clean · 7 issues", with no way to the batch, so a Steward could believe the
 * accounts or customers existed when every row had been held back. Nothing
 * loaded is a failure, some rows held back is a warning, and both link the
 * batch, where each held-back row says why. Both actions return `clean` and the
 * held-back count (`issues` for accounts, `quarantined` for customers).
 */
function uploadOutcome(data: UploadOk): { tone: Tone; message: string } {
  const summary = Object.entries(data)
    .filter(([k]) => k !== 'batchId')
    .map(([k, v]) => `${v} ${k}`)
    .join(' · ');
  const clean = Number(data.clean ?? 0);
  const held = Number(data.issues ?? data.quarantined ?? 0);
  if (clean === 0) {
    return {
      tone: 'fail',
      message:
        held > 0
          ? `Nothing was loaded: every row was held back (${summary}). Open the batch to see why.`
          : `Nothing was loaded: the file had no rows this import reads (${summary}).`,
    };
  }
  if (held > 0) {
    return { tone: 'warn', message: `Uploaded — ${summary}. Some rows were held back: open the batch to see why.` };
  }
  return { tone: 'ok', message: `Uploaded — ${summary}` };
}

function UploadForm({
  label,
  action,
}: {
  label: string;
  action: (formData: FormData) => Promise<ActionResult<UploadOk>>;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ message: string; tone: Tone; batchId?: string } | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setResult(null);
    const input = e.currentTarget.elements.namedItem('file');
    const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
    // A workbook over the cap would be refused by Vercel (4.5 MB request body)
    // before the importer runs, and the Steward would see Next's generic "An error
    // occurred in the Server Components render…": say so here, in the importer's
    // words, and send nothing. The importer keeps its own check (lib/import-file-size.ts).
    if (file && file.size > MAX_IMPORT_BYTES) {
      setResult({ tone: 'fail', message: importFileTooLarge(file.size) });
      return;
    }
    const fd = new FormData(e.currentTarget);
    start(async () => {
      try {
        // PROD-006: action returns `{ ok, code, message, fields? }` shape —
        // Steward sees real upload errors (file too big, oversize formula
        // payload, P2002 phone collision) instead of an SC-render generic.
        const res = await action(fd);
        if (!res.ok) {
          setResult({
            tone: 'fail',
            message: res.fields
              ? Object.values(res.fields).join(', ')
              : res.message,
          });
          return;
        }
        const batchId = typeof res.data.batchId === 'string' ? res.data.batchId : undefined;
        setResult({ ...uploadOutcome(res.data), batchId });
        (e.target as HTMLFormElement).reset();
      } catch (err) {
        setResult({
          tone: 'fail',
          message: err instanceof Error ? err.message : 'Upload failed.',
        });
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input
        type="file"
        name="file"
        accept=".xlsx"
        required
        className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-brand-700 hover:file:bg-brand-100"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300"
      >
        {pending ? 'Uploading…' : label}
      </button>
      {result && (
        <p
          role={result.tone === 'fail' ? 'alert' : 'status'}
          className={`text-xs font-medium ${TONE_CLASS[result.tone]}`}
        >
          {result.message}
          {result.batchId && (
            <>
              {' '}
              <Link href={`/import/${result.batchId}`} className="underline underline-offset-2">
                Open the batch
              </Link>
            </>
          )}
        </p>
      )}
    </form>
  );
}

export function UploadAccountForm() {
  return (
    <UploadForm
      label="Upload account master"
      action={uploadAccountMasterAction as (fd: FormData) => Promise<ActionResult<UploadOk>>}
    />
  );
}

export function UploadCustomerForm() {
  return (
    <UploadForm
      label="Upload customer master"
      action={uploadCustomerMasterAction as (fd: FormData) => Promise<ActionResult<UploadOk>>}
    />
  );
}
