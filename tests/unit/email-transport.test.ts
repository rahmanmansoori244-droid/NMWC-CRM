// @vitest-environment node
/**
 * F1 (2026-10-05): the Gmail SMTP transport (lib/email/transport.ts).
 *
 * nodemailer is mocked: these cases pin how the transport is configured (object
 * config, implicit TLS on 465, every wait bounded, nodemailer's logger and debug
 * off, no file or URL access) and how a failure is reported (a constrained label
 * from the error's code and response code, never its message — an SMTP reply
 * can quote the username, a library message the configuration).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  options: null as null | Record<string, unknown>,
  sent: [] as Array<Record<string, unknown>>,
  fail: null as null | unknown,
  closed: 0,
}));

vi.mock('nodemailer', () => {
  const createTransport = (options: Record<string, unknown>) => {
    h.options = options;
    return {
      sendMail: async (msg: Record<string, unknown>) => {
        if (h.fail) {
          const e = h.fail;
          h.fail = null;
          throw e;
        }
        h.sent.push(msg);
        return { messageId: 'm1' };
      },
      close: () => {
        h.closed += 1;
      },
    };
  };
  return { default: { createTransport }, createTransport };
});

import { classifySmtpError, createGmailTransport, SMTP_TIMEOUTS } from '@/lib/email/transport';

const PASS = 'p'.repeat(16);
const cfg = { user: 'sender@example.test', pass: PASS, from: 'NMWC CRM <sender@example.test>' };

beforeEach(() => {
  h.options = null;
  h.sent = [];
  h.fail = null;
  h.closed = 0;
});

describe('createGmailTransport', () => {
  it('configures Gmail with an object, implicit TLS, bounded waits, no logging, no file or URL access', () => {
    createGmailTransport(cfg);
    expect(h.options).toMatchObject({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: 'sender@example.test', pass: PASS },
      pool: true,
      maxConnections: 1,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      ...SMTP_TIMEOUTS,
    });
    // Every wait well inside the 60 s function limit.
    for (const v of Object.values(SMTP_TIMEOUTS)) expect(v).toBeLessThanOrEqual(20_000);
  });

  it('sends plain text from the configured sender, with every header line safe', async () => {
    const t = createGmailTransport(cfg);
    const res = await t.send({
      to: 'approver@example.test',
      subject: 'NMWC CRM: 1 request\r\nBcc: someone@example.test',
      text: 'body',
      headers: { 'Auto-Submitted': 'auto-generated\r\nX-Evil: 1' },
    });
    expect(res).toEqual({ ok: true });
    expect(h.sent[0]).toMatchObject({ from: cfg.from, to: 'approver@example.test', text: 'body' });
    expect(String(h.sent[0]!.subject)).not.toMatch(/[\r\n]/);
    expect(JSON.stringify(h.sent[0]!.headers)).not.toMatch(/\\r|\\n/);
    expect(h.sent[0]).not.toHaveProperty('html');
    t.close();
    expect(h.closed).toBe(1);
  });

  it('a failed send is a label, never the message — even one quoting the password', async () => {
    const t = createGmailTransport(cfg);
    h.fail = Object.assign(new Error(`Invalid login: 535 5.7.8 ${cfg.user} ${PASS}`), { code: 'EAUTH', responseCode: 535 });
    const res = await t.send({ to: 'a@example.test', subject: 's', text: 't', headers: {} });
    expect(res).toEqual({ ok: false, label: 'EAUTH', kind: 'auth' });
    expect(JSON.stringify(res)).not.toContain(PASS);
    expect(JSON.stringify(res)).not.toContain(cfg.user);
  });
});

describe('classifySmtpError', () => {
  it.each([
    [{ code: 'EAUTH' }, { label: 'EAUTH', kind: 'auth' }],
    [{ responseCode: 535 }, { label: 'EAUTH', kind: 'auth' }],
    [{ responseCode: 534 }, { label: 'EAUTH', kind: 'auth' }],
    // One recipient refused: that digest only.
    [{ code: 'EENVELOPE', responseCode: 553, command: 'RCPT TO' }, { label: 'EENVELOPE', kind: 'permanent' }],
    [{ code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' }, { label: 'EENVELOPE', kind: 'permanent' }],
    // A message nodemailer would not build, before any server answer: that digest only.
    [{ code: 'EMESSAGE', command: 'API' }, { label: 'EMESSAGE', kind: 'permanent' }],
    [{ code: 'EENVELOPE', command: 'API' }, { label: 'EENVELOPE', kind: 'permanent' }],
    // The sending account refused (Gmail's daily sending limit or a blocked
    // account answers at MAIL FROM; a refusal at DATA, or one that does not say
    // where, is no better): the run stops and hands everything back.
    [{ code: 'EENVELOPE', responseCode: 550, command: 'MAIL FROM' }, { label: 'EENVELOPE', kind: 'account' }],
    [{ code: 'EENVELOPE', responseCode: 554, command: 'DATA' }, { label: 'EENVELOPE', kind: 'account' }],
    [{ code: 'EMESSAGE', responseCode: 550, command: 'DATA' }, { label: 'EMESSAGE', kind: 'account' }],
    [{ code: 'EPROTOCOL', responseCode: 554, command: 'CONN' }, { label: 'SMTP_5XX', kind: 'account' }],
    [{ responseCode: 550 }, { label: 'SMTP_5XX', kind: 'account' }],
    [{ code: 'EMESSAGE' }, { label: 'EMESSAGE', kind: 'account' }],
    [{ responseCode: 550, command: 'RCPT TO' }, { label: 'SMTP_5XX', kind: 'permanent' }],
    // "Not now" is transient wherever it comes from — Gmail's 421 at MAIL FROM
    // used to be an EENVELOPE and so a permanent FAILED.
    [{ responseCode: 421 }, { label: 'SMTP_4XX', kind: 'transient' }],
    [{ code: 'EENVELOPE', responseCode: 421, command: 'MAIL FROM' }, { label: 'SMTP_4XX', kind: 'transient' }],
    [{ code: 'EENVELOPE', responseCode: 450, command: 'RCPT TO' }, { label: 'SMTP_4XX', kind: 'transient' }],
    [{ code: 'EENVELOPE', responseCode: 550, command: { toString: (): string => 'RCPT TO' } }, { label: 'EENVELOPE', kind: 'account' }],
    [{ code: 'ETIMEDOUT' }, { label: 'ETIMEDOUT', kind: 'transient' }],
    [{ code: 'ECONNECTION' }, { label: 'ECONNECTION', kind: 'transient' }],
    [{ code: 'ESOCKET' }, { label: 'ESOCKET', kind: 'transient' }],
    [{ code: 'something else' }, { label: 'OTHER', kind: 'transient' }],
    [{ code: 'EAUTH; drop table' }, { label: 'OTHER', kind: 'transient' }],
    ['a string', { label: 'OTHER', kind: 'transient' }],
    [null, { label: 'OTHER', kind: 'transient' }],
  ])('%j → %j', (err, expected) => {
    expect(classifySmtpError(err)).toEqual(expected);
  });

  it('reads the stage from nodemailer’s own command field, as nodemailer sets it', async () => {
    // The real library's error for a sender Gmail refuses: built by its own
    // _formatError, so a change in how nodemailer marks the stage fails here.
    const { default: SMTPConnection } = (await vi.importActual('nodemailer/lib/smtp-connection')) as {
      default: new (o: Record<string, unknown>) => { _formatError(m: string, t: string, r: string, c: string): unknown };
    };
    const conn = new SMTPConnection({});
    const fromRefused = conn._formatError('Mail command failed', 'EENVELOPE', '550 5.4.5 Daily user sending limit exceeded.', 'MAIL FROM');
    expect(classifySmtpError(fromRefused)).toEqual({ label: 'EENVELOPE', kind: 'account' });
    const rcptRefused = conn._formatError('Recipient command failed', 'EENVELOPE', '550 5.1.1 The email account does not exist.', 'RCPT TO');
    expect(classifySmtpError(rcptRefused)).toEqual({ label: 'EENVELOPE', kind: 'permanent' });
  });

  it('never reads the message, and survives a hostile error object', () => {
    const err = new Error();
    Object.defineProperty(err, 'message', {
      get: () => {
        throw new Error('the message was read');
      },
    });
    expect(classifySmtpError(Object.assign(err, { code: 'ETIMEDOUT' }))).toEqual({ label: 'ETIMEDOUT', kind: 'transient' });
    const hostile = {
      get code() {
        throw new Error('boom');
      },
    };
    expect(classifySmtpError(hostile)).toEqual({ label: 'OTHER', kind: 'transient' });
  });
});
