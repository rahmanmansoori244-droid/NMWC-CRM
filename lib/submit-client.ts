/**
 * Browser half of benchmark item 22 (see lib/submission.ts for the owner's
 * decisions). The field forms submit through `postForm`, not a server action:
 * Next queues every server action behind the one in flight and gives no way to
 * abort it, so after a stalled submit a Try again would not even be SENT until
 * the stall ended — the salesman would watch "Submitting…" for minutes. A fetch
 * can be aborted, and it says which of these happened:
 *
 *   answered     the server read the request and replied (ok or an error)
 *   offline      the phone had no network, so nothing left it
 *   signedOut    turned away before it was read: the session has ended (401
 *                from the route), or a forced password change redirected it
 *   maintenance  turned away before it was read: the app is closed for work
 *   unconfirmed  it may have arrived — no reply, a timeout, or a server fault
 *
 * Only offline, signedOut and maintenance are certain that nothing was saved.
 * Everything else that is not an answer is `unconfirmed`, and the safe move is
 * the same submit again with the same submission id: the server answers
 * "Already received" if the first one landed, and writes nothing twice.
 */
import type { ActionResult } from '@/lib/errors';
import {
  alreadyReceivedMessage,
  FIX_FIELDS_MESSAGE,
  MAINTENANCE_MESSAGE,
  newSubmissionId,
  OFFLINE_AFTER_EARLIER_MESSAGE,
  OFFLINE_AFTER_UNCONFIRMED_MESSAGE,
  OFFLINE_MESSAGE,
  SIGNED_OUT_MESSAGE,
  UNCONFIRMED_MESSAGE,
  type SubmitReceipt,
} from '@/lib/submission';

export type FieldForm = 'customer-edit' | 'customer-create' | 'branch-close' | 'branch-reactivate';

export type SubmitOutcome<T> =
  | { kind: 'answered'; result: ActionResult<T> }
  | { kind: 'offline' }
  | { kind: 'signedOut' }
  | { kind: 'maintenance' }
  | { kind: 'unconfirmed' };

/**
 * How long to wait for an answer. A submit is a small JSON request; it takes a
 * second or two. 30 s is far past that and still under the server's 60 s limit,
 * so a retry after it usually meets a finished first attempt.
 */
export const SUBMIT_TIMEOUT_MS = 30_000;

/** runAction's codes for a database that dropped or did not answer. */
const TRANSIENT_DB_CODES = new Set(['DB_INTERRUPTED', 'DB_UNAVAILABLE']);

/** The header lib/maintenance.ts puts on its 503, so it is not read as a fault. */
export const MAINTENANCE_HEADER = 'x-nmwc-maintenance';

const offlineNow = () => typeof navigator !== 'undefined' && navigator.onLine === false;

export async function postForm<T>(
  form: FieldForm,
  body: Record<string, unknown>,
  { timeoutMs = SUBMIT_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<SubmitOutcome<T>> {
  // Sent even when the phone says it is offline: a wrong flag must not block
  // every try. It only decides the wording when the send then fails.
  const offlineBefore = offlineNow();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/forms/${form}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort.signal,
      credentials: 'same-origin',
      cache: 'no-store',
      // The only redirect this route meets is the forced password change
      // (auth.config.ts, AUTH-09). Followed, it is a 200 HTML page —
      // indistinguishable from a proxy's error page. Not followed, it is
      // certain: turned away, nothing read.
      redirect: 'manual',
    });
    if (res.type === 'opaqueredirect') return { kind: 'signedOut' };
    // The route's own "signed out" (the middleware does not stop it; the route
    // checks the session before it reads the body).
    if (res.status === 401) return { kind: 'signedOut' };
    if (res.status === 503 && res.headers.get(MAINTENANCE_HEADER) === '1') {
      return { kind: 'maintenance' };
    }
    // A server fault may come after the write committed: not an answer.
    if (res.status >= 500) return { kind: 'unconfirmed' };
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
      return { kind: 'unconfirmed' };
    }
    const json = (await res.json()) as unknown;
    if (!json || typeof json !== 'object' || typeof (json as { ok?: unknown }).ok !== 'boolean') {
      return { kind: 'unconfirmed' };
    }
    const result = json as ActionResult<T>;
    // The database dropped or stalled mid-request (lib/errors.ts REL-06). A drop
    // can come after the commit, so this is not an answer about the write: keep
    // the submission id, and let the retry find out.
    if (!result.ok && TRANSIENT_DB_CODES.has(result.code)) return { kind: 'unconfirmed' };
    return { kind: 'answered', result };
  } catch {
    // No network interface before AND after: the request could not leave the
    // phone. Anything else — a network error, the timeout's abort, before or
    // during the reply — may have been read, so it is never "nothing was sent".
    return offlineBefore && offlineNow() ? { kind: 'offline' } : { kind: 'unconfirmed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which submission id a submit carries. The same id is reused only for the SAME
 * payload after an attempt with no answer — that is what makes a retry safe. A
 * changed payload gets a new id: had the first attempt landed, reusing its id
 * would answer "Already received" and silently drop the changes made since.
 * After any answer the id is spent. Keep one per form, in a ref: a new one per
 * submit would never reuse an id.
 */
export class SubmissionIds {
  private open: { id: string; fingerprint: string; uncertain: boolean } | null = null;
  // Ids whose try got no answer and that nothing has settled since — whatever
  // payload they carried. Survives a new id: changing the form does not make an
  // earlier send any less likely to have arrived. An id leaves only when an
  // answer settles IT (a refusal of another payload says nothing about it).
  private unanswered = new Set<string>();

  constructor(private readonly mint: () => string = newSubmissionId) {}

  /** The id to send with this payload. */
  idFor(payload: unknown): string {
    const fingerprint = JSON.stringify(payload);
    if (this.open?.fingerprint === fingerprint) return this.open.id;
    this.open = { id: this.mint(), fingerprint, uncertain: false };
    return this.open.id;
  }

  /** Call with every outcome: an answer spends the id; no answer keeps it for the retry. */
  settle(outcome: SubmitOutcome<unknown>): void {
    if (outcome.kind === 'answered') {
      // Answered for the open id: it landed now or before (a replay), or it
      // was refused — either way that id's doubt is settled.
      if (this.open) this.unanswered.delete(this.open.id);
      // A request that is IN: the earlier doubts are moot for what he does next.
      if (outcome.result.ok) this.unanswered.clear();
      this.open = null;
    } else if (outcome.kind === 'unconfirmed' && this.open) {
      this.open.uncertain = true;
      this.unanswered.add(this.open.id);
    }
  }

  /**
   * What may have arrived without an answer: 'this' — a try of the open id, so
   * a retry is answered "Already received" if it landed; 'earlier' — a try of a
   * payload changed since; 'none'.
   */
  get doubt(): SubmitDoubt {
    if (this.open?.uncertain) return 'this';
    return this.unanswered.size > 0 ? 'earlier' : 'none';
  }
}

export type SubmitDoubt = 'this' | 'earlier' | 'none';

/** What the salesman reads beside the button after a submit. */
export type SubmitNotice =
  | { tone: 'failed'; text: string; retry: boolean }
  | { tone: 'received'; text: string };

/**
 * The notice for an outcome that is not a plain success. Returns null for a
 * first-time success (the form says its own "Submitted"). An answered error
 * with fields says so beside the button; the fields say what. `doubt`: what may
 * have arrived unanswered before this outcome (SubmissionIds.doubt).
 */
export function noticeFor(
  outcome: SubmitOutcome<unknown>,
  { now = new Date(), doubt = 'none' }: { now?: Date; doubt?: SubmitDoubt } = {}
): SubmitNotice | null {
  switch (outcome.kind) {
    case 'offline':
      return {
        tone: 'failed',
        text:
          doubt === 'this'
            ? OFFLINE_AFTER_UNCONFIRMED_MESSAGE
            : doubt === 'earlier'
              ? OFFLINE_AFTER_EARLIER_MESSAGE
              : OFFLINE_MESSAGE,
        retry: true,
      };
    case 'signedOut':
      return { tone: 'failed', text: SIGNED_OUT_MESSAGE, retry: true };
    case 'maintenance':
      return { tone: 'failed', text: MAINTENANCE_MESSAGE, retry: true };
    case 'unconfirmed':
      return { tone: 'failed', text: UNCONFIRMED_MESSAGE, retry: true };
    case 'answered': {
      const r = outcome.result;
      if (!r.ok) {
        // Fields to fix: say so here, the fields say what. A form-level refusal
        // alone ("No changes to submit.") has nothing marked red: say it itself.
        const perField = Object.keys(r.fields ?? {}).some((k) => k !== '_form');
        return { tone: 'failed', text: perField ? FIX_FIELDS_MESSAGE : (r.fields?._form ?? r.message), retry: false };
      }
      const receipt = r.data as Partial<SubmitReceipt> | undefined;
      if (receipt?.replayed && receipt.state && receipt.editId) {
        const text = alreadyReceivedMessage(receipt as SubmitReceipt, now);
        // It arrived, but it needs the salesman again: not the good-news green.
        const sentBack = receipt.state === 'REJECTED' || receipt.state === 'NEEDS_CORRECTION';
        return sentBack ? { tone: 'failed', text, retry: false } : { tone: 'received', text };
      }
      return null;
    }
  }
}

/**
 * Whether a submission id landed as a new-customer request — asked by a form
 * reloaded after a send that got no answer (the id was kept on the phone). The
 * receipt, null when it did not land, or "noAnswer" when the question itself
 * got none.
 */
export async function fetchCreateReceipt(
  submissionId: string,
  { timeoutMs = SUBMIT_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<{ kind: 'answered'; receipt: SubmitReceipt | null } | { kind: 'noAnswer' }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(
      `/api/forms/customer-create?submissionId=${encodeURIComponent(submissionId)}`,
      { signal: abort.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'manual' }
    );
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) {
      return { kind: 'noAnswer' };
    }
    const json = (await res.json()) as { ok?: unknown; data?: unknown };
    if (json?.ok !== true) return { kind: 'noAnswer' };
    return { kind: 'answered', receipt: (json.data as SubmitReceipt | null) ?? null };
  } catch {
    return { kind: 'noAnswer' };
  } finally {
    clearTimeout(timer);
  }
}
