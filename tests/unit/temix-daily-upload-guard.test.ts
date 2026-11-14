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
 *    file or its rows through Prisma (the retention sweep's raw SQL empties old
 *    payloads, lib/purge-summary.ts, and is the only other writer).
 *  - The page and the action are the Data Steward's only.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';

const SERVICE = 'services/temix-daily.ts';
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

  it('no other source writes the daily file or its rows through Prisma', () => {
    const found: string[] = [];
    for (const file of ['app', 'components', 'lib', 'services'].flatMap(walk)) {
      if (file === SERVICE) continue;
      const src = stripComments(readFileSync(file, 'utf8'), file);
      for (const m of src.matchAll(MODEL_WRITE_RE)) {
        if (m[1] === 'temixDailyFile' || m[1] === 'temixDailyRow') found.push(`${file}: ${m[0]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('the action and the page are the Data Steward\'s only', () => {
    expect(code).toMatch(/if \(user\.role !== Role\.STEWARD\)\s*\{\s*throw new ForbiddenError/);
    expect(code).toMatch(/async function uploadTemixDailyFileCore[\s\S]*?const me = await requireSteward\(\);/);
    const page = stripComments(readFileSync('app/(app)/temix-daily/page.tsx', 'utf8'), 'page.tsx');
    expect(page).toMatch(/if \(session\.user\.role !== Role\.STEWARD\) redirect\('\/home'\);/);
    expect(page.indexOf("redirect('/home')")).toBeLessThan(page.indexOf('prisma.temixDailyFile.findMany'));
  });
});
