'use client';

import { useState, useTransition } from 'react';
import { uploadAccountMasterAction, uploadCustomerMasterAction } from '@/services/imports';
import type { ActionResult } from '@/lib/errors';

type UploadOk = Record<string, string | number>;

function UploadForm({
  label,
  action,
}: {
  label: string;
  action: (formData: FormData) => Promise<ActionResult<UploadOk>>;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ message: string; ok: boolean } | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setResult(null);
    const fd = new FormData(e.currentTarget);
    start(async () => {
      try {
        // PROD-006: action returns `{ ok, code, message, fields? }` shape —
        // Steward sees real upload errors (file too big, oversize formula
        // payload, P2002 phone collision) instead of an SC-render generic.
        const res = await action(fd);
        if (!res.ok) {
          setResult({
            ok: false,
            message: res.fields
              ? Object.values(res.fields).join(', ')
              : res.message,
          });
          return;
        }
        const summary = Object.entries(res.data)
          .filter(([k]) => k !== 'batchId')
          .map(([k, v]) => `${v} ${k}`)
          .join(' · ');
        setResult({ ok: true, message: `Uploaded — ${summary}` });
        (e.target as HTMLFormElement).reset();
      } catch (err) {
        setResult({
          ok: false,
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
          className={`text-xs font-medium ${result.ok ? 'text-emerald-700' : 'text-red-600'}`}
        >
          {result.message}
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
