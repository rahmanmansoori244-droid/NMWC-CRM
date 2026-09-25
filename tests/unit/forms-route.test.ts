// @vitest-environment node
/**
 * app/api/forms/[form]/route.ts — the field forms' submit over fetch (benchmark
 * item 22). It must call the SAME action each form's server action was, reply
 * with that action's own result as 200 (an answer), and refuse what a server
 * action would have refused: another site, a non-JSON body, an unknown form.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  edit: vi.fn(),
  create: vi.fn(),
  close: vi.fn(),
  reactivate: vi.fn(),
  signedIn: true,
}));
vi.mock('@/lib/auth', () => ({
  auth: async () => (h.signedIn ? { user: { id: 'u1', role: 'SALESMAN', username: 'c4' } } : null),
}));
vi.mock('@/services/edits', () => ({ submitEditAction: h.edit }));
vi.mock('@/services/creates', () => ({ submitCreateAction: h.create }));
vi.mock('@/services/reactivations', () => ({
  markBranchClosedAction: h.close,
  requestReactivationAction: h.reactivate,
}));

import { POST } from '@/app/api/forms/[form]/route';

const HOST = 'nmwc.example';
function post(form: string, body: unknown, headers: Record<string, string> = {}) {
  const req = new NextRequest(`https://${HOST}/api/forms/${form}`, {
    method: 'POST',
    headers: { host: HOST, origin: `https://${HOST}`, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ form }) });
}

const ACTIONS = [h.edit, h.create, h.close, h.reactivate];
beforeEach(() => {
  h.signedIn = true;
  for (const f of ACTIONS) f.mockReset().mockResolvedValue({ ok: true, data: { editId: 'e1' } });
});

describe('POST /api/forms/[form]', () => {
  it('hands the update body to the update action and replies with its result as an answer', async () => {
    const body = { customerId: 'c1', isDraft: false, customer: {}, branches: [], submissionId: 'x' };
    h.edit.mockResolvedValue({ ok: false, code: 'EDIT_LOCKED', message: 'Pending.' });
    const res = await post('customer-edit', body);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ ok: false, code: 'EDIT_LOCKED', message: 'Pending.' });
    expect(h.edit).toHaveBeenCalledWith(body);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('routes the new-customer form to the create action', async () => {
    await post('customer-create', { isDraft: true });
    expect(h.create).toHaveBeenCalledWith({ isDraft: true });
  });

  it.each([
    ['branch-close', 'close'],
    ['branch-reactivate', 'reactivate'],
  ] as const)('%s gets the FormData its action reads, strings only', async (form, key) => {
    await post(form, { branchId: 'b1', reason: 'Shop shut', attachmentId: 'a1', submissionId: 's1', extra: 'x', n: 5 });
    const fd = h[key].mock.calls[0]![0] as FormData;
    expect(Object.fromEntries(fd.entries())).toEqual({
      branchId: 'b1',
      reason: 'Shop shut',
      attachmentId: 'a1',
      submissionId: 's1',
    });
  });

  it('refuses an unknown form, including an inherited property name', async () => {
    for (const form of ['nope', 'constructor', '__proto__', 'toString']) {
      const res = await post(form, {});
      expect(res.status, form).toBe(404);
    }
    for (const f of ACTIONS) expect(f).not.toHaveBeenCalled();
  });

  it('signed out: 401 before the body is read or any action runs — the middleware does not stop it', async () => {
    h.signedIn = false;
    const res = await post('customer-edit', { customerId: 'c1' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      ok: false,
      code: 'SIGNED_OUT',
      message: 'You are signed out, so nothing was sent.',
    });
    for (const f of ACTIONS) expect(f).not.toHaveBeenCalled();
  });

  it('refuses another site, and an Origin it cannot read', async () => {
    for (const origin of ['https://evil.example', 'null', 'not a url']) {
      const res = await post('customer-edit', {}, { origin });
      expect(res.status, origin).toBe(403);
    }
    expect(h.edit).not.toHaveBeenCalled();
  });

  it('accepts a same-origin request behind a proxy that names the public host', async () => {
    const res = await post('customer-edit', {}, { host: 'internal:3000', 'x-forwarded-host': HOST });
    expect(res.status).toBe(200);
  });

  it('refuses a body that is not JSON — a form post from another site cannot send JSON without CORS', async () => {
    const res = await post('customer-edit', 'a=1', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(res.status).toBe(415);
    expect((await post('customer-edit', '{not json')).status).toBe(400);
    expect((await post('customer-edit', '[1,2]')).status).toBe(400);
    expect(h.edit).not.toHaveBeenCalled();
  });

  it('lets a programmer error propagate (500, reported) instead of answering', async () => {
    h.edit.mockRejectedValue(new Error('bug'));
    await expect(post('customer-edit', {})).rejects.toThrow('bug');
  });
});
