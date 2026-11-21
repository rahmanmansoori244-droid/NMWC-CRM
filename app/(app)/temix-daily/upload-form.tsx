'use client';

import { useState, useTransition } from 'react';
import { uploadTemixDailyFileAction } from '@/services/temix-daily';
import { MAX_IMPORT_BYTES, importFileTooLarge } from '@/lib/import-file-size';
import { DAILY_FILE_ACCEPT, uploadMessage, type UploadTone } from '@/lib/temix-daily-upload';

const TONE_CLASS: Record<UploadTone, string> = {
  ok: 'text-emerald-700',
  warn: 'text-amber-700',
  fail: 'text-red-600',
};

export function TemixDailyUploadForm() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ tone: UploadTone; lines: string[] } | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setResult(null);
    const form = e.currentTarget;
    const input = form.elements.namedItem('file');
    const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
    // The same cap and words as the server (lib/import-file-size.ts).
    if (file && file.size > MAX_IMPORT_BYTES) {
      setResult({ tone: 'fail', lines: [importFileTooLarge(file.size)] });
      return;
    }
    const fd = new FormData(form);
    start(async () => {
      try {
        const res = await uploadTemixDailyFileAction(fd);
        if (!res.ok) {
          setResult({ tone: 'fail', lines: [res.fields ? Object.values(res.fields).join(', ') : res.message] });
          return;
        }
        setResult(uploadMessage(res.data));
        form.reset();
      } catch (err) {
        setResult({ tone: 'fail', lines: [err instanceof Error ? err.message : 'Upload failed.'] });
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input
        type="file"
        name="file"
        accept={DAILY_FILE_ACCEPT}
        required
        aria-label="Temix daily file (.xlsx or .csv)"
        className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-brand-700 hover:file:bg-brand-100"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300"
      >
        {pending ? 'Uploading…' : 'Upload the daily file'}
      </button>
      {result && (
        <div role={result.tone === 'fail' ? 'alert' : 'status'} className={`space-y-1 text-xs font-medium ${TONE_CLASS[result.tone]}`}>
          {result.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      )}
    </form>
  );
}
