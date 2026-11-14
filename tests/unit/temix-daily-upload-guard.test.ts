/**
 * The daily Temix import, stage 3: the upload stages a file and changes no
 * customer. Structural, as the house rules ask (CLAUDE.md): the defect would be
 * "the upload wrote something it must not", so this reads the upload's source.
 *
 *  - services/temix-daily.ts writes only TemixDailyFile, TemixDailyRow and one
 *    AuditLog row (writeAudit), inside withChangeContext with its own source;
 *    it writes no Customer, Branch, ImportBatch, ImportRow, history, ledger
 *    (TemixChange, TemixChangeReview, TemixNoticeSeen, TemixRouteMap) or
 *    Notification row, and names no raw UPDATE, INSERT or DELETE.
 *  - No other file in app/, components/, lib/ or services/ writes the daily
 *    file or its rows through Prisma, but the apply (stage 5,
 *    services/temix-daily-apply.ts: a file's state, lease and counts, a row's
 *    outcome; tests/unit/temix-daily-write-set.test.ts holds what it writes).
 *    The retention sweep's raw SQL empties old payloads (lib/purge-summary.ts).
 *  - The page and the action are the Data Steward's only.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';

const SERVICE = 'services/temix-daily.ts';
/** Stage 5: the apply moves a staged file and its rows on (its write set: tests/unit/temix-daily-write-set.test.ts). */
const APPLY_SERVICE = 'services/temix-daily-apply.ts';
const code = stripComments(readFileSync(SERVICE, 'utf8'), SERVICE);

const WRITE = '(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)';
const MODEL_WRITE_RE = new RegExp(`\\b(?:tx|prisma)\\s*\\.\\s*([a-zA-Z]+)\\s*\\.\\s*${WRITE}\\s*\\(`, 'g');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return e === 'node_modules' || e === '.next' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e) ? [p.replace(/\\/g, '/')] : [];
  });
}

describe('the daily upload writes only the staged file, its rows and its audit row', () => {
  it('the detector still matches the shape it exists to catch', () => {
    const hits = (s: string) => [...s.matchAll(new RegExp(MODEL_WRITE_RE.source, 'g'))].map((m) => m[1]);
    expect(hits('await tx.customer.update({})')).toEqual(['customer']);
    expect(hits('await tx\n  .branch\n  .updateMany({})')).toEqual(['branch']);
    expect(hits('await tx.temixDailyRow.findMany({})')).toEqual([]);
  });

  it('its model writes are TemixDailyFile and TemixDailyRow only', () => {
    const models = new Set([...code.matchAll(MODEL_WRITE_RE)].map((m) => m[1]));
    expect([...models].sort()).toEqual(['temixDailyFile', 'temixDailyRow']);
  });

  it('it names no raw write, and no other table', () => {
    expect(code).not.toMatch(/\$executeRaw(Unsafe)?`\s*(UPDATE|INSERT|DELETE)/i);
    expect(code).not.toMatch(/\$queryRaw(Unsafe)?`[^`]*\b(UPDATE|INSERT|DELETE)\b/i);
    for (const t of ['Customer', 'Branch', 'ImportBatch', 'ImportRow', 'TemixChange', 'TemixNoticeSeen', 'TemixRouteMap', 'Notification']) {
      expect(code, t).not.toMatch(new RegExp(`"${t}"`));
    }
    expect(code).not.toMatch(/notifyUsers|lockCustomerRow|setChangeContext/);
  });

  it('it writes inside withChangeContext under the upload source, with one audit row', () => {
    expect(code).toMatch(/withChangeContext\(\s*prisma,\s*\{\s*actorId: me\.id, source: src\.temixDailyUpload\(fileId\)\s*\}/);
    expect([...code.matchAll(/\bwriteAudit\(/g)]).toHaveLength(1);
    expect(code).toMatch(/entityType: 'TemixDailyFile'/);
  });

  it('the audit row carries no file name (free text the uploader chose), only the file\'s identity and counts', () => {
    const after = /writeAudit\(tx, env, \{[\s\S]*?after: \{([\s\S]*?)\n {10}\},/.exec(code);
    expect(after, 'the audit call').not.toBeNull();
    const keys = [...after![1]!.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*)\s*[:,]/gm)].map((m) => m[1]);
    expect(keys).toContain('fileSha256');
    expect(keys).not.toContain('filename');
  });

  it('the upload time is read with the load day, after the lock, and written on the file', () => {
    const lock = code.indexOf('pg_advisory_xact_lock');
    const clock = code.indexOf('SELECT clock_timestamp() AS at');
    expect(lock).toBeGreaterThan(0);
    expect(clock).toBeGreaterThan(lock);
    // One query gives both: the day is the Oman day of that same instant.
    expect(code).toMatch(/const \[\{ day, at \}\] = await tx\.\$queryRaw/);
    expect(code).toMatch(/temixDailyFile\.create\(\{\s*data: \{[\s\S]*?\buploadedAt,/);
    // The order rule ranks this file by that instant, not by a re-read default.
    expect(code).toMatch(/const self: DailyFileForOrder = \{[\s\S]*?\buploadedAt,/);
    expect(code).not.toMatch(/select: \{ uploadedAt: true \}/);
  });

  it('no other source writes the daily file or its rows through Prisma', () => {
    const found: string[] = [];
    for (const file of ['app', 'components', 'lib', 'services'].flatMap(walk)) {
      if (file === SERVICE || file === APPLY_SERVICE) continue;
      const src = stripComments(readFileSync(file, 'utf8'), file);
      for (const m of src.matchAll(MODEL_WRITE_RE)) {
        if (m[1] === 'temixDailyFile' || m[1] === 'temixDailyRow') found.push(`${file}: ${m[0]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('every gated integration suite of the daily import runs in CI\'s db-tests job', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    const start = ci.indexOf('\n  db-tests:\n');
    expect(start, 'the db-tests job').toBeGreaterThan(0);
    const rest = ci.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    const job = next === -1 ? rest : rest.slice(0, next + 1);
    const gates = readdirSync('tests/integration')
      .filter((f) => f.startsWith('temix-daily'))
      .flatMap((f) => [...readFileSync(join('tests/integration', f), 'utf8').matchAll(/process\.env\.(RUN_[A-Z_]+)/g)].map((m) => m[1]!));
    expect(gates).toEqual(expect.arrayContaining(['RUN_TEMIX_DAILY', 'RUN_TEMIX_DAILY_UPLOAD', 'RUN_TEMIX_DAILY_CHECK', 'RUN_TEMIX_DAILY_APPLY']));
    for (const g of new Set(gates)) expect(job, g).toMatch(new RegExp(`^\\s+${g}: '1'$`, 'm'));
  });

  it('the action and the page are the Data Steward\'s only', () => {
    expect(code).toMatch(/if \(user\.role !== Role\.STEWARD\)\s*\{\s*throw new ForbiddenError/);
    expect(code).toMatch(/async function uploadTemixDailyFileCore[\s\S]*?const me = await requireSteward\(\);/);
    const page = stripComments(readFileSync('app/(app)/temix-daily/page.tsx', 'utf8'), 'page.tsx');
    expect(page).toMatch(/if \(session\.user\.role !== Role\.STEWARD\) redirect\('\/home'\);/);
    expect(page.indexOf("redirect('/home')")).toBeLessThan(page.indexOf('prisma.temixDailyFile.findMany'));
  });
});
