import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { EditProcess } from '@prisma/client';
import { prisma } from '@/lib/db';
import { findReceipt } from '@/lib/submission-replay';
import { submissionIdSchema } from '@/lib/submission';
import { AppError } from '@/lib/errors';
import { submitEditAction } from '@/services/edits';
import { submitCreateAction } from '@/services/creates';
import { markBranchClosedAction, requestReactivationAction } from '@/services/reactivations';
import type { ActionResult } from '@/lib/errors';
import { readJsonObject, refuse, refuseCrossSite } from '@/lib/fetch-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The field forms' submits, over fetch (benchmark item 22; lib/submit-client.ts
 * says why not a server action: a stalled one cannot be aborted, and every later
 * action queues behind it). Each form calls the SAME function its server action
 * was, so the checks, the audit and the submission-id replay are one code path.
 *
 * The reply is always the action's own `{ ok, … }` shape with status 200 — ok or
 * not, the server read the request and answered. Anything else the client treats
 * as "no answer": a 500 here is a programmer error thrown by runAction, left to
 * propagate so it reaches the error reporting.
 */
type Json = Record<string, unknown>;

const FORMS: Record<string, (body: Json) => Promise<ActionResult<unknown>>> = {
  // The schemas inside each action validate the body; nothing is trusted here.
  'customer-edit': (body) => submitEditAction(body as Parameters<typeof submitEditAction>[0]),
  'customer-create': (body) => submitCreateAction(body as Parameters<typeof submitCreateAction>[0]),
  'branch-close': (body) => markBranchClosedAction(formDataOf(body)),
  'branch-reactivate': (body) => requestReactivationAction(formDataOf(body)),
};

/** The close / reactivate actions read FormData (their server-action shape). */
function formDataOf(body: Json): FormData {
  const fd = new FormData();
  for (const key of ['branchId', 'reason', 'attachmentId', 'submissionId']) {
    const v = body[key];
    if (typeof v === 'string') fd.set(key, v);
  }
  return fd;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ form: string }> }) {
  const { form } = await ctx.params;
  const run = Object.hasOwn(FORMS, form) ? FORMS[form] : undefined;
  if (!run) return refuse(404, 'NOT_FOUND', 'Unknown form.');
  // Same-origin JSON only — the check a server action gets from Next for free.
  const crossSite = refuseCrossSite(req);
  if (crossSite) return crossSite;
  // Signed out: say so with its own status, so the phone can tell "sign in and
  // Try again — nothing was sent" from an answer. The sign-in gate in the
  // middleware does NOT stop this request (auth.config.ts: its `false` is
  // discarded), so without this the action's "Not signed in." came back as a
  // final answer, with no Try again (post-review fix).
  if (!(await auth())?.user) {
    return refuse(401, 'SIGNED_OUT', 'You are signed out, so nothing was sent.');
  }
  const read = await readJsonObject(req);
  if ('refused' in read) return read.refused;
  return NextResponse.json(await run(read.body));
}

/**
 * Item 22: did this submission id land as a new-customer request? Asked by the
 * new-customer form when it reloads after a send that got no answer: its
 * branches, points and photos never lived on the phone, so without the answer
 * it could only tell the salesman to rebuild a request that may already be in.
 * Only the caller's own requests are looked up; a receipt of another kind is
 * "not landed as this", never an error. The update form needs no such thing —
 * its page says on reload whether his edit is pending.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ form: string }> }) {
  const { form } = await ctx.params;
  if (form !== 'customer-create') return refuse(404, 'NOT_FOUND', 'Unknown form.');
  const session = await auth();
  if (!session?.user) return refuse(401, 'SIGNED_OUT', 'You are signed out.');
  const submissionId = submissionIdSchema.safeParse(req.nextUrl.searchParams.get('submissionId')).data;
  if (!submissionId) return refuse(400, 'INVALID_ID', 'A submission id is required.');
  try {
    const receipt = await findReceipt(prisma, session.user.id, submissionId, {
      process: EditProcess.CREATE,
    });
    return NextResponse.json({ ok: true, data: receipt });
  } catch (err) {
    if (err instanceof AppError && err.code === 'SUBMISSION_ID_REUSED') {
      return NextResponse.json({ ok: true, data: null });
    }
    throw err;
  }
}
