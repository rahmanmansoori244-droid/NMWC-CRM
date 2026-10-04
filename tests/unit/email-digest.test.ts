// @vitest-environment node
/**
 * F1 (2026-10-05): what a notification e-mail says (lib/email/digest.ts).
 * Counts, the kind of each request and links — nothing that names a customer, a
 * salesman, a route or a region; a line saying the CRM never asks for a password;
 * an Arabic line; headers that keep auto-responders quiet; a subject that cannot
 * start a header of its own.
 */
import { describe, it, expect } from 'vitest';
import { Role } from '@prisma/client';
import { DIGEST_HEADERS, renderDigest, type DigestItem } from '@/lib/email/digest';
import { headerSafe } from '@/lib/email/header';

const ORIGIN = 'https://crm.example.test';
const item = (kind: DigestItem['kind'], editId: string, requestType: DigestItem['requestType'] = 'UPDATE'): DigestItem => ({
  kind,
  editId,
  requestType,
});
const render = (items: DigestItem[], role: Role = Role.MANAGER, extra: Partial<Parameters<typeof renderDigest>[0]> = {}) =>
  renderDigest({ items, role, linkOrigin: ORIGIN, subjectPrefix: '', maxItems: 20, ...extra });

describe('renderDigest', () => {
  it('one line and one link per request; the subject counts what waits and what is for information', () => {
    const d = render([
      item('REQUEST_FYI', 'e3', 'CREATE'),
      item('EDIT_SUBMITTED', 'e1', 'CLOSE'),
      item('REACTIVATION_REQUESTED', 'e2', 'REACTIVATION'),
    ]);
    expect(d.subject).toBe('NMWC CRM: 2 requests waiting for you, 1 request for your information');
    expect(d.text).toContain(`Waiting for your review: a close-shop request\n${ORIGIN}/approvals/e1`);
    expect(d.text).toContain(`Waiting for your decision: a shop reactivation request\n${ORIGIN}/reactivations`);
    expect(d.text).toContain(`For your information: a new-customer request was submitted\n${ORIGIN}/approvals/e3`);
    // Must-act first.
    expect(d.text.indexOf('Waiting for your review')).toBeLessThan(d.text.indexOf('For your information'));
  });

  it('links follow the inbox rule for the recipient’s role', () => {
    const fyiReactivation = [item('REQUEST_FYI', 'e9', 'REACTIVATION')];
    expect(render(fyiReactivation, Role.ACCOUNTANT).text).toContain(`${ORIGIN}/approvals/e9`);
    expect(render(fyiReactivation, Role.MANAGER).text).toContain(`${ORIGIN}/reactivations`);
    expect(render([item('EDIT_STAGE_ADVANCED', 'e4', 'CREATE')], Role.FINANCE_MANAGER).text).toContain(
      `Now at your approval step: a new-customer request\n${ORIGIN}/approvals/e4`
    );
  });

  it('says the CRM never asks for a password, where to sign in, and has an Arabic line', () => {
    const d = render([item('EDIT_SUBMITTED', 'e1')]);
    expect(d.text).toContain('The CRM never asks for your password by e-mail.');
    expect(d.text).toContain(`Sign in only at ${ORIGIN}.`);
    expect(d.text).toMatch(/لا يطلب النظام كلمة المرور/);
    expect(d.text).toContain('sign in, then open the link again');
  });

  it('carries the auto-generated headers', () => {
    expect(render([item('EDIT_SUBMITTED', 'e1')]).headers).toEqual({
      'Auto-Submitted': 'auto-generated',
      'X-Auto-Response-Suppress': 'All',
    });
    expect(DIGEST_HEADERS).toEqual(render([item('EDIT_SUBMITTED', 'e1')]).headers);
  });

  it('beyond the line limit: "and N more" with the inbox link', () => {
    const many = Array.from({ length: 23 }, (_, i) => item('REQUEST_FYI', `e${i}`));
    const d = render(many, Role.ACCOUNTANT, { maxItems: 20 });
    expect(d.text.match(/\/approvals\//g)).toHaveLength(20);
    expect(d.text).toContain(`…and 3 more: ${ORIGIN}/notifications`);
    expect(d.subject).toBe('NMWC CRM: 23 requests for your information');
  });

  it('marks a redirected message, and no prefix can break the subject onto a new header', () => {
    expect(render([item('EDIT_SUBMITTED', 'e1')], Role.MANAGER, { subjectPrefix: '[UAT] ' }).subject).toBe(
      '[UAT] NMWC CRM: 1 request waiting for you'
    );
    const injected = render([item('EDIT_SUBMITTED', 'e1')], Role.MANAGER, { subjectPrefix: 'X\r\nBcc: y@example.test\r\n' });
    expect(injected.subject).not.toMatch(/[\r\n]/);
    expect(headerSafe('a\r\nb\u0000c\u007fd')).toBe('a b c d');
  });

  it('has no field through which a name could arrive: the output is the input ids and fixed words', () => {
    const d = render([item('EDIT_SUBMITTED', 'ck0000000000000000000000a1', 'UPDATE')]);
    const words = d.text
      .replace(/https:\/\/\S+/g, '')
      .replace(/[^\p{L}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase());
    // Every word comes from the fixed English and Arabic copy of the renderer.
    const FIXED = `Hello You your have new item items in the NMWC customer CRM Waiting for your review a update request Open link to see
      If are asked sign then open again The never asks password by e mail Sign only at This message was sent automatically Replies not read
      لديك من العناصر الجديدة في نظام عملاء افتح الروابط أعلاه لعرضها لا يطلب النظام كلمة المرور عبر البريد الإلكتروني أبداً`;
    const allowed = new Set(FIXED.split(/\s+/).map((w) => w.replace(/[^\p{L}]/gu, '')).filter(Boolean).map((w) => w.toLowerCase()));
    for (const w of words) expect(allowed, w).toContain(w);
  });
});
