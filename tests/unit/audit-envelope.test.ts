/**
 * DG-06/07 — every AuditLog row must carry the device and network it came from.
 *
 * Before this, eleven writes across the Temix, import, export and SLA paths
 * called `prisma.auditLog.create` (or `.createMany`) directly, so `ip` and
 * `userAgent` landed NULL and the append-only ledger named in
 * docs/compliance/RECORDS-OF-PROCESSING.md could not answer "from which device,
 * from which network" for any Temix batch, any import, or any export of the
 * customer master.
 *
 * `lib/audit.writeAudit` is the ONLY writer that populates those two columns, so
 * these are structural guards rather than behavioural ones: they fail when a new
 * direct `auditLog` write appears in one of these files, and when an audit
 * envelope is built somewhere it must not be.
 *
 * Deliberately no database. An integration test needs the Neon link and could
 * only ever prove that ONE action populates `ip` — never that the other ten
 * paths stayed converted. The append-only property at the database is already
 * covered by tests/integration/audit-immutability.test.ts and is untouched here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { systemAuditEnvelope } from '@/lib/audit';

const FILES = [
  // Every file that used to write the ledger directly. Three separate batches
  // converted these; the guard covers all of them so a later edit cannot quietly
  // reintroduce a direct write in the batch nobody is looking at.
  'services/edits.ts',
  'services/photos.ts',
  'services/customers.ts',
  'services/duplicates.ts',
  'services/reactivations.ts',
  'services/creates.ts',
  'lib/create-finalize.ts',
  'services/temix.ts',
  'services/imports.ts',
  'services/exports.ts',
  'services/customer-export.ts',
  'app/api/exports/changes/route.ts',
  'app/api/cron/sla-escalate/route.ts',
];

const SRC: Record<string, string> = {};
for (const f of FILES) SRC[f] = readFileSync(f, 'utf8');

/**
 * Blank out comments and string/template bodies, preserving offsets and line
 * numbers. Every guard below runs on this, so prose that merely mentions
 * `auditLog` or `getAuditEnvelope` — including the comments in those files that
 * explain these very rules — can neither satisfy nor trip a guard.
 */
function stripCommentsAndStrings(code: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | '"' | "'" | '`' = 'code';
  while (i < code.length) {
    const c = code[i];
    const d = code[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = c; out += ' '; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; } else out += ' ';
      i += 1; continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === mode) { mode = 'code'; out += ' '; i += 1; continue; }
    out += c === '\n' ? '\n' : ' '; i += 1;
  }
  return out;
}

/** [start, end] offsets of every `$transaction( … )` call, parentheses matched. */
function transactionRanges(clean: string): [number, number][] {
  const TOKEN = '$transaction(';
  const ranges: [number, number][] = [];
  for (let i = 0; i < clean.length; i++) {
    if (!clean.startsWith(TOKEN, i)) continue;
    let depth = 0;
    let j = i + TOKEN.length - 1;
    for (; j < clean.length; j++) {
      if (clean[j] === '(') depth += 1;
      else if (clean[j] === ')') { depth -= 1; if (depth === 0) break; }
    }
    ranges.push([i, j]);
    i += TOKEN.length;
  }
  return ranges;
}

/** 1-based lines where `needle` sits inside a `$transaction(...)` call. */
function insideTransaction(code: string, needle: string): number[] {
  const clean = stripCommentsAndStrings(code);
  const ranges = transactionRanges(clean);
  const hits: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    if (!clean.startsWith(needle, i)) continue;
    if (ranges.some(([a, b]) => i > a && i < b)) hits.push(code.slice(0, i).split('\n').length);
  }
  return hits;
}

describe('every audit write goes through lib/audit', () => {
  it.each(FILES)('%s never WRITES prisma.auditLog directly', (f) => {
    // Writes only. Reading the ledger is legitimate — services/duplicates.ts
    // queries CustomerPair rows to honour steward-dismissed pairs — and a guard
    // that also banned reads would be deleted by the first person it blocked.
    // The ledger is append-only at the database, so create and createMany are
    // the only writes that could succeed; the mutating verbs are listed anyway,
    // because a direct attempt is a defect worth catching here rather than as a
    // trigger error in production.
    const offenders = stripCommentsAndStrings(SRC[f])
      .split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) =>
        /\bauditLog\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|delete|deleteMany|upsert)\b/.test(
          l
        )
      );
    expect(offenders).toEqual([]);
  });

  it.each(FILES)('%s routes its audit writes through writeAudit', (f) => {
    expect(/\bwriteAudit\(/.test(stripCommentsAndStrings(SRC[f]))).toBe(true);
  });
});

describe('the request envelope is built before any transaction opens', () => {
  it.each(FILES)('%s builds no envelope inside a $transaction callback', (f) => {
    // Reading headers belongs outside an open interactive transaction: one read
    // per action instead of one per write, and no avoidable work while a
    // transaction is held open on a WAN-bound link — the delay class that
    // produced this codebase's P2028 failures.
    expect(insideTransaction(SRC[f], 'getAuditEnvelope(')).toEqual([]);
  });

  it('the guard fires when an envelope is moved inside a transaction', () => {
    // A structural guard that cannot fail is not a guard.
    const broken = `
      async function f() {
        await prisma.$transaction(async (tx) => {
          const env = await getAuditEnvelope(me.id);
          await writeAudit(tx, env, { action: 'UPDATE' });
        });
      }`;
    expect(insideTransaction(broken, 'getAuditEnvelope(')).not.toEqual([]);
  });

  it('the guard is not fooled by a comment or a string literal', () => {
    const innocent = `
      async function f() {
        const env = await getAuditEnvelope(me.id);
        await prisma.$transaction(async (tx) => {
          // never call getAuditEnvelope( in here
          const s = 'getAuditEnvelope(';
          await writeAudit(tx, env, { action: 'UPDATE' });
        });
      }`;
    expect(insideTransaction(innocent, 'getAuditEnvelope(')).toEqual([]);
  });
});

describe('the SLA sweep uses a system envelope, not the scheduler request', () => {
  const CRON = 'app/api/cron/sla-escalate/route.ts';

  it('systemAuditEnvelope returns null ip and userAgent, synchronously', () => {
    const env = systemAuditEnvelope('user-123');
    // Not a promise: the one envelope that is safe to build anywhere.
    expect(env).not.toBeInstanceOf(Promise);
    expect(env).toEqual({ actorId: 'user-123', ip: null, userAgent: null });
  });

  it('the cron route never reads the request headers for an audit row', () => {
    // A cron route handler IS a request scope, so getAuditEnvelope would succeed
    // and stamp the SCHEDULER's ip and user-agent onto a row whose actorId is
    // the human submitter. A fabricated forensic field is worse than an absent
    // one. Checked on the comment-stripped source so the comment in that file
    // explaining this rule does not trip it.
    const clean = stripCommentsAndStrings(SRC[CRON]);
    expect(clean).toMatch(/\bsystemAuditEnvelope\(/);
    expect(clean).not.toMatch(/\bgetAuditEnvelope\b/);
  });
});
