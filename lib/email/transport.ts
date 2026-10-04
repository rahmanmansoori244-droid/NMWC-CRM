/**
 * F1 (2026-10-05): the SMTP connection to Gmail. The ONLY module that imports
 * nodemailer (tests/unit/email-structure-guard.test.ts), and it is reached only
 * from the e-mail drain cron, never from a request or inside a transaction.
 *
 * What it guards against:
 *   - A credential in a log or an error. The configuration is an object, never an
 *     smtps://user:pass@ URL; nodemailer's logger and debug output are off; a
 *     failure is reported as a constrained label built from the error's code and
 *     response code (lib/alert.ts logs only an error's class for the same reason).
 *     err.message is never read: an SMTP reply can quote the username, and a
 *     library message the configuration.
 *   - A hung server. nodemailer's defaults (2 minutes to connect, 10 minutes of
 *     socket idle) outlive the 60 s function limit, and a killed run records no
 *     heartbeat and raises no alert (app/api/cron/photo-gc). Every wait here is
 *     bounded, and the drain stops starting sends well before the limit.
 *   - Header injection. Every header value is stripped of CR and LF here too, not
 *     only in the digest.
 * One pooled connection per run (Gmail rate-limits logins), closed at the end.
 */
import nodemailer from 'nodemailer';
import { GMAIL_SMTP, type SendConfig } from './config';
import { headerSafe } from './header';

export type OutgoingMail = {
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
};

/** What a failed send is called. Never derived from free text. */
export type EmailErrorLabel =
  | 'EAUTH'
  | 'ETIMEDOUT'
  | 'ECONNECTION'
  | 'ESOCKET'
  | 'EDNS'
  | 'ETLS'
  | 'EPROTOCOL'
  | 'EENVELOPE'
  | 'EMESSAGE'
  | 'SMTP_4XX'
  | 'SMTP_5XX'
  /** The drain's own hard stop (lib/email/drain.ts), not an SMTP answer. */
  | 'DEADLINE'
  | 'OTHER';

/**
 * auth       — the mailbox refused the login: abort the run, retry nothing (every
 *              later send would fail the same way, and Google locks accounts that
 *              keep trying).
 * account    — the login worked but Gmail refused the SENDER or the message stage
 *              for good (MAIL FROM / DATA, or a refusal with no command at all):
 *              a used-up daily sending limit, a blocked or suspended account.
 *              Every later send would be refused the same way, so it is treated
 *              like auth: abort the run and hand every row back, the current
 *              digest included (fixer review 2026-10-05: these used to be marked
 *              FAILED one digest after another, a day's approver e-mail lost for
 *              good while the account was hit 40 times a run).
 * permanent  — THIS recipient was refused (RCPT TO), or the message could not be
 *              built for him: mark that digest FAILED.
 * transient  — try again later (any 4xx, a timeout, a dropped connection): the
 *              row's lease expires and a later run retries.
 */
export type SendFailure = { label: EmailErrorLabel; kind: 'auth' | 'account' | 'permanent' | 'transient' };
export type SendResult = { ok: true } | ({ ok: false } & SendFailure);

export interface MailTransport {
  send(mail: OutgoingMail): Promise<SendResult>;
  close(): void;
}

const KNOWN_CODES = new Set<EmailErrorLabel>([
  'EAUTH',
  'ETIMEDOUT',
  'ECONNECTION',
  'ESOCKET',
  'EDNS',
  'ETLS',
  'EPROTOCOL',
  'EENVELOPE',
  'EMESSAGE',
]);

/**
 * The SMTP stage a refusal came from: nodemailer's own fixed `err.command`
 * ('MAIL FROM', 'RCPT TO', 'DATA', 'API' for one it refused before sending, …).
 * A structured field set by the library, compared against fixed strings — never
 * the reply text, which can quote the username.
 */
const RECIPIENT_STAGES = new Set(['RCPT TO']);

/** Pure: classify a nodemailer error by its code, SMTP response code and command only. */
export function classifySmtpError(err: unknown): SendFailure {
  let code: unknown;
  let responseCode: unknown;
  let command: unknown;
  try {
    if (err && typeof err === 'object') {
      code = (err as { code?: unknown }).code;
      responseCode = (err as { responseCode?: unknown }).responseCode;
      command = (err as { command?: unknown }).command;
    }
  } catch {
    // A malformed thrown object must not make the classifier throw.
  }
  const rc = typeof responseCode === 'number' && Number.isInteger(responseCode) ? responseCode : null;
  const label: EmailErrorLabel | null =
    typeof code === 'string' && KNOWN_CODES.has(code as EmailErrorLabel) ? (code as EmailErrorLabel) : null;
  const stage = typeof command === 'string' ? command : null;

  // 530/534/535: authentication required / app password needed / not accepted.
  if (label === 'EAUTH' || rc === 530 || rc === 534 || rc === 535) return { label: 'EAUTH', kind: 'auth' };
  // A 4xx is "not now" wherever it came from — including an envelope stage, which
  // nodemailer labels EENVELOPE (Gmail's 421 "try again later" at MAIL FROM).
  if (rc !== null && rc >= 400 && rc < 500) return { label: 'SMTP_4XX', kind: 'transient' };
  const refusedLabel: EmailErrorLabel | null =
    label === 'EENVELOPE' || label === 'EMESSAGE' ? label : rc !== null && rc >= 500 && rc < 600 ? 'SMTP_5XX' : null;
  if (refusedLabel) {
    // One recipient refused, or a message nodemailer would not build (no answer
    // from the server at all): that digest only.
    if (stage !== null && RECIPIENT_STAGES.has(stage)) return { label: refusedLabel, kind: 'permanent' };
    if (stage === 'API' && rc === null) return { label: refusedLabel, kind: 'permanent' };
    // The sender or the message stage, or a refusal that does not say where:
    // every later send in this run would meet the same answer.
    return { label: refusedLabel, kind: 'account' };
  }
  if (label) return { label, kind: 'transient' };
  return { label: 'OTHER', kind: 'transient' };
}

/** Every wait bounded well inside the 60 s function limit (vercel.json). */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
  dnsTimeout: 10_000,
} as const;

export function createGmailTransport(config: Pick<SendConfig, 'user' | 'pass' | 'from'>): MailTransport {
  const transporter = nodemailer.createTransport({
    host: GMAIL_SMTP.host,
    port: GMAIL_SMTP.port,
    secure: GMAIL_SMTP.secure,
    auth: { user: config.user, pass: config.pass },
    pool: true,
    maxConnections: 1,
    maxMessages: 100,
    ...SMTP_TIMEOUTS,
    logger: false,
    debug: false,
    // Messages are plain text the drain builds; nothing may make nodemailer read
    // a file or fetch a URL on its behalf.
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async send(mail) {
      try {
        const headers = Object.fromEntries(Object.entries(mail.headers).map(([k, v]) => [headerSafe(k, 60), headerSafe(v)]));
        await transporter.sendMail({
          from: config.from,
          to: headerSafe(mail.to, 254),
          subject: headerSafe(mail.subject),
          text: mail.text,
          headers,
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, ...classifySmtpError(err) };
      }
    },
    close() {
      try {
        transporter.close();
      } catch {
        // Closing a pool that never connected is not a failure of the run.
      }
    },
  };
}
