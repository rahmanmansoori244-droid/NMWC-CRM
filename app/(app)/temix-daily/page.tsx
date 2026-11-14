import { redirect } from 'next/navigation';
import { Prisma, Role } from '@prisma/client';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { omanDateTime } from '@/lib/tz';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { TableScroll } from '@/components/nmwc/TableScroll';
import {
  TEMIX_DAILY_NOTE_LABEL,
  TEMIX_DAILY_OPTIONAL,
  TEMIX_DAILY_REQUIRED,
  TEMIX_DAILY_UPLOAD_NOTES,
  type TemixDailyUploadNote,
} from '@/lib/temix-daily-file';
import { applyBlockedBy, dateColumnDay, overtakenBy, type DailyFileForOrder } from '@/lib/temix-daily-order';
import { TemixDailyUploadForm } from './upload-form';

export const metadata = { title: 'Temix daily file · NMWC' };

/** The files listed, newest first. */
const LIST_SIZE = 60;

const STATE_LABEL: Record<DailyFileForOrder['state'], string> = {
  STAGED: 'Staged',
  CHECKED: 'Checked',
  APPLYING: 'Applying',
  FINALIZING: 'Finishing',
  LOADED: 'Loaded',
  DISCARDED: 'Discarded',
};

/**
 * The daily Temix import, stage 3: the Data Steward's list of daily files and
 * the upload. Data Steward only (the plan: every action of the daily import is
 * his; the others see only its effects). Upload stages a file; nothing on this
 * page changes a customer.
 */
export default async function TemixDailyPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.STEWARD) redirect('/home');

  const files = await prisma.temixDailyFile.findMany({
    orderBy: [{ loadDay: 'desc' }, { uploadedAt: 'desc' }],
    take: LIST_SIZE,
    include: {
      uploadedBy: { select: { fullName: true } },
      sameBytesAs: { select: { loadDay: true, filename: true } },
    },
  });
  // The order rule reads every unfinished file, listed or not.
  const unfinished = await prisma.temixDailyFile.findMany({
    where: { state: { notIn: ['LOADED', 'DISCARDED'] } },
    select: { id: true, filename: true, loadDay: true, uploadedAt: true, state: true, fileSha256: true },
  });
  const inFlightOrLoaded = await prisma.temixDailyFile.findMany({
    where: { state: { in: ['APPLYING', 'FINALIZING', 'LOADED'] } },
    orderBy: { loadDay: 'desc' },
    take: 1,
    select: { id: true, filename: true, loadDay: true, uploadedAt: true, state: true, fileSha256: true },
  });
  const order: DailyFileForOrder[] = [...unfinished, ...inFlightOrLoaded].map((f) => ({ ...f, loadDay: dateColumnDay(f.loadDay) }));

  const ids = files.map((f) => f.id);
  const noteCounts =
    ids.length === 0
      ? []
      : await prisma.$queryRaw<Array<{ fileId: string; note: string; n: bigint }>>`
          SELECT r."fileId", x.note, count(*) AS n
            FROM "TemixDailyRow" r, unnest(r."holdReasons") AS x(note)
           WHERE r."fileId" IN (${Prisma.join(ids)}) AND r."outcome" = 'PENDING'
           GROUP BY r."fileId", x.note`;
  const rowsWithNotes =
    ids.length === 0
      ? []
      : await prisma.temixDailyRow.groupBy({
          by: ['fileId'],
          where: { fileId: { in: ids }, outcome: 'PENDING', NOT: { holdReasons: { isEmpty: true } } },
          _count: { _all: true },
        });
  const notesOf = (fileId: string) =>
    TEMIX_DAILY_UPLOAD_NOTES.map((note) => ({
      note,
      n: Number(noteCounts.find((c) => c.fileId === fileId && c.note === note)?.n ?? 0),
    })).filter((x) => x.n > 0);
  const withNotes = (fileId: string) => rowsWithNotes.find((r) => r.fileId === fileId)?._count._all ?? 0;

  return (
    <main>
      <PageHeader
        title="Temix daily file"
        subtitle="Upload the day's customer export from Temix (.xlsx or .csv). Upload stages the file only: nothing in it is applied to customers yet."
      />

      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-2">
        <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <header className="mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Upload</h2>
            <p className="mt-1 text-xs text-slate-600">
              First sheet only. The same file is taken once per day. Files are taken in the order of
              their day: a newer file waits while an older one is neither loaded nor discarded.
            </p>
            <details className="mt-2 rounded bg-slate-50 p-3 text-xs text-slate-700">
              <summary className="cursor-pointer select-none font-medium">Expected columns</summary>
              <div className="mt-2 space-y-2">
                <p>
                  {TEMIX_DAILY_REQUIRED.map((c, i) => (
                    <span key={c}>
                      {i > 0 && ', '}
                      <code>{c}</code>
                    </span>
                  ))}
                  , and optionally{' '}
                  {TEMIX_DAILY_OPTIONAL.map((c, i) => (
                    <span key={c}>
                      {i > 0 && ', '}
                      <code>{c}</code>
                    </span>
                  ))}
                  .
                </p>
                <p className="text-[11px] text-slate-500">
                  Headings are matched whatever their capitals, spaces or underscores. Codes are read
                  in capital letters. <code>status</code> is A or I. A customer master (with{' '}
                  <code>temix_code</code>, <code>channel</code> and the like) is refused here: load it
                  on the Import screen.
                </p>
              </div>
            </details>
          </header>
          <TemixDailyUploadForm />
        </section>
      </div>

      <section className="px-4 pb-6 sm:px-6">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Daily files</h2>
        <TableScroll label="Temix daily files" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Day</th>
                <th scope="col" className="px-4 py-2 font-medium">Uploaded</th>
                <th scope="col" className="px-4 py-2 font-medium">File</th>
                <th scope="col" className="px-4 py-2 font-medium">By</th>
                <th scope="col" className="px-4 py-2 font-medium">Status</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Rows</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">With a note</th>
                <th scope="col" className="px-4 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {files.map((f) => {
                const me: DailyFileForOrder = { ...f, loadDay: dateColumnDay(f.loadDay) };
                const finished = f.state === 'LOADED' || f.state === 'DISCARDED';
                const waits = finished ? null : applyBlockedBy(me, order);
                const overtaken = finished ? null : overtakenBy(me, order);
                const notes = notesOf(f.id);
                return (
                  <tr key={f.id} className="align-top hover:bg-slate-50">
                    <td className="px-4 py-2 font-mono text-xs">{me.loadDay}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{omanDateTime(f.uploadedAt)}</td>
                    <td className="px-4 py-2 font-medium">
                      {f.filename}
                      {f.sameBytesAs && (
                        <p className="mt-1 text-xs font-normal text-amber-700">
                          Exactly the same file as {dateColumnDay(f.sameBytesAs.loadDay)} (&quot;{f.sameBytesAs.filename}&quot;).
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600">{f.uploadedBy.fullName}</td>
                    <td className="px-4 py-2 text-xs">
                      {STATE_LABEL[f.state]}
                      {overtaken ? (
                        <p className="mt-1 text-red-700">
                          Can never be applied: the file of {overtaken.loadDay} is already applied.
                        </p>
                      ) : (
                        waits && (
                          <p className="mt-1 text-amber-700">
                            Waits for the file of {waits.loadDay} (&quot;{waits.filename}&quot;).
                          </p>
                        )
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">{f.totalRows.toLocaleString('en-US')}</td>
                    <td className="px-4 py-2 text-right text-amber-700">{withNotes(f.id).toLocaleString('en-US')}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">
                      {notes.length === 0
                        ? '-'
                        : notes.map((x) => (
                            <p key={x.note}>
                              {x.n.toLocaleString('en-US')}: {TEMIX_DAILY_NOTE_LABEL[x.note as TemixDailyUploadNote]}
                            </p>
                          ))}
                    </td>
                  </tr>
                );
              })}
              {files.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-xs text-slate-500">
                    No daily file uploaded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableScroll>
      </section>
    </main>
  );
}
