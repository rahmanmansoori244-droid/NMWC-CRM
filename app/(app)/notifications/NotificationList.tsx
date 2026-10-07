'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  markNotificationReadAction,
  markAllNotificationsReadAction,
  markInformationReadAction,
} from '@/services/notifications-actions';
import { omanDayTime } from '@/lib/tz';

const KIND_LABEL: Record<string, string> = {
  EDIT_SUBMITTED: 'Review',
  EDIT_STAGE_ADVANCED: 'Progress',
  EDIT_APPROVED_FINAL: 'Approved',
  EDIT_NEEDS_CORRECTION: 'Correction',
  SLA_BREACH: 'SLA',
  TEMIX_UPLOAD_READY: 'Temix',
  TEMIX_SYNC_ACKED: 'Temix',
  // F1
  REQUEST_FYI: 'FYI',
  REACTIVATION_REQUESTED: 'Reactivation',
};

const KIND_TONE: Record<string, string> = {
  EDIT_SUBMITTED: 'bg-sky-50 text-sky-700 ring-sky-200',
  EDIT_STAGE_ADVANCED: 'bg-slate-100 text-slate-600 ring-slate-200',
  EDIT_APPROVED_FINAL: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  EDIT_NEEDS_CORRECTION: 'bg-amber-50 text-amber-800 ring-amber-200',
  SLA_BREACH: 'bg-red-50 text-red-700 ring-red-200',
  TEMIX_UPLOAD_READY: 'bg-violet-50 text-violet-700 ring-violet-200',
  TEMIX_SYNC_ACKED: 'bg-violet-50 text-violet-700 ring-violet-200',
  REQUEST_FYI: 'bg-slate-100 text-slate-600 ring-slate-200',
  REACTIVATION_REQUESTED: 'bg-sky-50 text-sky-700 ring-sky-200',
};

export function NotificationRow({
  id,
  title,
  body,
  kind,
  createdAt,
  unread,
}: {
  id: string;
  title: string;
  body: string;
  kind: string;
  createdAt: string;
  unread: boolean;
}) {
  // Fire-and-forget mark-read as the user clicks through to the deep link.
  function markRead() {
    if (!unread) return;
    const fd = new FormData();
    fd.set('id', id);
    void markNotificationReadAction(fd);
  }
  return (
    <div
      onClick={markRead}
      className={`rounded-lg p-3 shadow-sm ring-1 transition hover:shadow-md ${
        unread ? 'bg-white ring-brand-300' : 'bg-slate-50 ring-slate-200 opacity-80'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-brand-600" />}
            <span
              className={`inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${KIND_TONE[kind] ?? 'bg-slate-100 text-slate-600 ring-slate-200'}`}
            >
              {KIND_LABEL[kind] ?? kind}
            </span>
            <span className="truncate">{title}</span>
          </p>
          <p className="mt-1 line-clamp-2 text-xs text-slate-600">{body}</p>
        </div>
        <span className="shrink-0 text-xs text-slate-500">
          {/* Oman time, built without Intl: the server (UTC) and the phone must
              print the same text, or React throws #418 on every full load. */}
          {omanDayTime(createdAt)}
        </span>
      </div>
    </div>
  );
}

/**
 * F1: marks only the information rows (REQUEST_FYI) read. Must-act rows stay
 * unread, so their e-mail still goes (a read row is never e-mailed).
 */
export function MarkInformationReadButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      title="Marks only the for-information notifications read. Requests waiting on you stay unread."
      onClick={() =>
        start(async () => {
          await markInformationReadAction();
          router.refresh();
        })
      }
      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
    >
      {pending ? 'Marking…' : 'Mark information read'}
    </button>
  );
}

export function MarkAllReadButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await markAllNotificationsReadAction();
          router.refresh();
        })
      }
      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
    >
      {pending ? 'Marking…' : 'Mark all read'}
    </button>
  );
}
