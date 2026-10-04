// @vitest-environment node
/**
 * scripts/ops/visitdays-from-sheets.ts against Postgres, run the way an operator runs it:
 * its own client on the owner connection, a real workbook on disk, every mode in order.
 *
 *  - the dry run writes the set and the review workbook and nothing to the database, and
 *    prints no code and no note;
 *  - --rehearse runs every write and rolls it back: no day, no audit row, no ledger row;
 *  - --apply, in several transactions, writes only branches that are exactly as the dry
 *    run read them. A branch that changed in any way meanwhile is left alone: a new
 *    version, and also the changes that do not move the version (a day set by another
 *    writer, a merge into another customer, a route move, a closure, an archived
 *    customer). Each write has its audit row with the run id, moves the customer's
 *    updatedAt and rescores it; the ledger has a STARTING and a COMPLETED row;
 *  - a second dry run of the same sheets finds only what --apply left alone;
 *  - --reverse is a dry run until --confirm, works without the COMPLETED row (a run that
 *    stopped halfway), and undoes only what is still as the run wrote it.
 * The unit half, with no database: tests/unit/visitdays-from-sheets.test.ts.
 *
 *   RUN_VISITDAYS_SHEETS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/visitdays-from-sheets.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { PrismaClient } from '@prisma/client';
import { parseWorkbook } from '@/lib/excel';
import { purgeAuditLog } from '../support/audit';
import { HELP_SHEET, LEDGER_ENTITY, REASONS, run, sha256, type Options } from '../../scripts/ops/visitdays-from-sheets';

const ENABLED = process.env.RUN_VISITDAYS_SHEETS === '1' && !!process.env.DATABASE_URL;

describe.skipIf(!ENABLED)('ops:visitdays-from-sheets against Postgres', () => {
  let prisma: PrismaClient;
  let host = '';
  const tag = randomUUID().slice(0, 8).toLowerCase();
  const P = `ZZVD-${tag}`.toUpperCase();
  const NOTE = `call before visiting ${tag}`;
  const steward = `zz.vdsheets.${tag}`;
  let stewardId = '';
  let regionId = '';
  const routes = { a: '', b: '' };
  const RA = `${P}-RA`;
  const RB = `${P}-RB`;
  const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'k', 'z'] as const;
  type Letter = (typeof letters)[number];
  const cust = Object.fromEntries(letters.map((l) => [l, `zzvd${tag}${l}`])) as Record<Letter, string>;
  const br = {
    a1: `zzvd${tag}a1`, b1: `zzvd${tag}b1`, b2: `zzvd${tag}b2`, c1: `zzvd${tag}c1`, d1: `zzvd${tag}d1`,
    e1: `zzvd${tag}e1`, f1: `zzvd${tag}f1`, g1: `zzvd${tag}g1`, h1: `zzvd${tag}h1`, i1: `zzvd${tag}i1`,
    k1: `zzvd${tag}k1`,
  };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vdsheets-it-'));
  const sheets = path.join(dir, 'returned');
  const out = path.join(dir, 'out');
  const book = `visit-days-to-fill-${P}.xlsx`;
  const printed: string[] = [];

  const opts = (over: Partial<Options>): Options => ({
    mode: 'dry', sheets: [sheets], out, setFile: '', setSha: '', actor: steward, runId: '', confirm: false, chunk: 200, ...over,
  });
  const quiet = () => {
    const lines: string[] = [];
    return { lines, log: (l: string) => { lines.push(l); printed.push(l); } };
  };
  const branch = (id: string) =>
    prisma.branch.findUniqueOrThrow({
      where: { id },
      select: { dayOfVisit: true, version: true, lastEditedById: true, completenessScore: true, updatedAt: true },
    });
  const ledger = () =>
    prisma.auditLog.findMany({
      where: { actorId: stewardId, entityType: LEDGER_ENTITY },
      orderBy: { at: 'asc' },
      select: { entityId: true, after: true },
    });
  const branchAudit = () =>
    prisma.auditLog.findMany({
      where: { actorId: stewardId, entityType: 'Branch' },
      orderBy: { at: 'asc' },
      select: { entityId: true, before: true, after: true },
    });
  /** The newest file of a kind the dry run wrote. */
  const newest = (suffix: string) => {
    const f = readdirSync(out).filter((n) => n.endsWith(suffix)).sort().pop();
    if (!f) throw new Error(`no ${suffix} file in the output folder`);
    return path.join(out, f);
  };
  const setOf = (file: string) =>
    (JSON.parse(readFileSync(file, 'utf8')) as { items: Array<{ branchId: string; day: string }> }).items
      .map((i) => [i.branchId, i.day])
      .sort();

  beforeAll(async () => {
    const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
    if (url.includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
    prisma = new PrismaClient({ datasourceUrl: url });
    stewardId = (
      await prisma.user.create({
        data: { username: steward, passwordHash: 'x', fullName: 'ZZ Visit-day Steward', role: 'STEWARD' },
      })
    ).id;
    regionId = (await prisma.region.create({ data: { code: `${P}-R`, name: `ZZ VD ${tag}` } })).id;
    routes.a = (await prisma.route.create({ data: { code: RA, name: `ZZ VD A ${tag}`, regionId } })).id;
    routes.b = (await prisma.route.create({ data: { code: RB, name: `ZZ VD B ${tag}`, regionId } })).id;
    for (const l of letters) {
      await prisma.customer.create({ data: { id: cust[l], nmwcCode: `${P}-${l.toUpperCase()}`, legalName: `ZZ VD ${l}` } });
    }
    const make = (id: string, customerId: string, code: string, routeId: string, extra: object = {}) =>
      prisma.branch.create({
        data: { id, customerId, branchCode: code, branchName: 'Main', address: 'Way 1, Muscat', regionId, routeId, ...extra },
      });
    await make(br.a1, cust.a, `${P}-A-01`, routes.a);
    await make(br.b1, cust.b, `${P}-B-01`, routes.a);
    await make(br.b2, cust.b, `${P}-B-02`, routes.b, { dayOfVisit: 'MON' });
    await make(br.c1, cust.c, `${P}-C-01`, routes.a, { status: 'CLOSED' });
    for (const l of ['d', 'e', 'f', 'g', 'h', 'i', 'k'] as const) {
      await make(br[`${l}1`], cust[l], `${P}-${l.toUpperCase()}-01`, routes.a);
    }

    // The workbook as it comes back from the region's Managers.
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet(HELP_SHEET).addRow(['Fill ONLY the "Visit day" column.']);
    const headings = ['Route', 'Branch code', 'Customer code', 'Customer name', 'Branch name', 'Area', 'Address', 'Cash/Credit', 'Status', 'Visit day', 'Notes'];
    const line = (route: string, l: string, n: string, day: string, note = '') =>
      [route, `${P}-${l}-${n}`, `${P}-${l}`, 'ZZ', 'Main', '', 'Way 1', 'CASH', 'ACTIVE', day, note];
    const a = wb.addWorksheet(RA);
    a.addRow(headings);
    a.addRow(line(RA, 'A', '01', 'SAT'));
    a.addRow(line(RA, 'B', '01', 'sun'));
    a.addRow(line(RA, 'C', '01', 'MON')); // CLOSED: for a person
    a.addRow(line(RA, 'D', '01', 'TUE')); // edited before --apply (new version)
    a.addRow(line(RA, 'E', '01', 'WED')); // given a day by another writer, same version
    a.addRow(line(RA, 'F', '01', 'THU')); // merged into another customer, same version
    a.addRow(line(RA, 'G', '01', 'FRI')); // moved to another route, same version
    a.addRow(line(RA, 'H', '01', 'SAT')); // closed, same version
    a.addRow(line(RA, 'I', '01', 'SUN')); // its customer archived
    a.addRow(line(RA, 'K', '01', 'MON', NOTE)); // a note: for a person
    a.addRow(line(RA, 'X', '01', 'WED')); // no such branch
    const b = wb.addWorksheet(RB);
    b.addRow(headings);
    b.addRow(line(RB, 'B', '02', 'THU')); // already MON: for a person
    mkdirSync(sheets, { recursive: true });
    await wb.xlsx.writeFile(path.join(sheets, book));
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    if (!prisma) return;
    try {
      await purgeAuditLog(prisma, { where: { actorId: stewardId } });
      await prisma.branch.deleteMany({ where: { id: { in: Object.values(br) } } });
      await prisma.customer.deleteMany({ where: { id: { in: Object.values(cust) } } });
      await prisma.route.deleteMany({ where: { id: { in: [routes.a, routes.b] } } });
      await prisma.region.deleteMany({ where: { id: regionId } });
      await prisma.user.deleteMany({ where: { id: stewardId } });
    } catch (e) {
      console.error('cleanup', e);
    }
    await prisma.$disconnect();
  });

  let setFile = '';
  let setSha = '';
  let runId = '';
  const loadable = [br.a1, br.b1, br.d1, br.e1, br.f1, br.g1, br.h1, br.i1];

  it('the dry run writes the set and the review workbook, and nothing to the database', async () => {
    const before = await Promise.all(loadable.map(branch));
    const { lines, log } = quiet();
    expect(await run(opts({}), prisma, host, log)).toBe(0);
    setFile = newest('.json');
    setSha = sha256(readFileSync(setFile, 'utf8')).slice(0, 16);
    expect(setOf(setFile)).toEqual(
      [[br.a1, 'SAT'], [br.b1, 'SUN'], [br.d1, 'TUE'], [br.e1, 'WED'], [br.f1, 'THU'], [br.g1, 'FRI'], [br.h1, 'SAT'], [br.i1, 'SUN']].sort()
    );
    const [review] = await parseWorkbook(readFileSync(newest('-review.xlsx')));
    const why = new Map(review!.rows.map((r) => [String(r['Branch code']), String(r.Why)]));
    expect(why.get(`${P}-C-01`)).toBe(REASONS.inactive);
    expect(why.get(`${P}-K-01`)).toBe(REASONS.note);
    expect(why.get(`${P}-X-01`)).toBe(REASONS.noBranch);
    expect(why.get(`${P}-B-02`)).toBe(REASONS.otherDay);
    expect(review!.rows.find((r) => r['Branch code'] === `${P}-K-01`)?.Notes).toBe(NOTE);
    expect(await Promise.all(loadable.map(branch))).toEqual(before);
    expect(await ledger()).toEqual([]);
    expect(await branchAudit()).toEqual([]);
    expect(lines.join('\n')).toContain('TO WRITE:         8 branch(es)');
  }, 180_000);

  it('the rehearsal runs every write and keeps none of them', async () => {
    const before = await Promise.all(loadable.map(branch));
    const { lines, log } = quiet();
    expect(await run(opts({ mode: 'rehearse', sheets: [], setFile, setSha, chunk: 3 }), prisma, host, log)).toBe(0);
    expect(lines.join('\n')).toContain('REHEARSED (rolled back): would write 8; changed since the review 0');
    expect(await Promise.all(loadable.map(branch))).toEqual(before);
    expect(await ledger()).toEqual([]);
    expect(await branchAudit()).toEqual([]);
  }, 180_000);

  it('--apply writes only what is exactly as the dry run read it, with its audit trail', async () => {
    // After the review, each of these changes one branch. Only D's moves the version.
    await prisma.branch.update({ where: { id: br.d1 }, data: { openingHours: '08-13', version: { increment: 1 } } });
    await prisma.branch.update({ where: { id: br.e1 }, data: { dayOfVisit: 'FRI' } });
    await prisma.branch.update({ where: { id: br.f1 }, data: { customerId: cust.z } });
    await prisma.branch.update({ where: { id: br.g1 }, data: { routeId: routes.b } });
    await prisma.branch.update({ where: { id: br.h1 }, data: { status: 'CLOSED' } });
    await prisma.customer.update({ where: { id: cust.i }, data: { deletedAt: new Date() } });
    const before = Object.fromEntries(await Promise.all(loadable.map(async (id) => [id, await branch(id)] as const)));
    const custBefore = await prisma.customer.findMany({ where: { id: { in: [cust.a, cust.b] } }, select: { id: true, updatedAt: true } });

    const { lines, log } = quiet();
    expect(await run(opts({ mode: 'apply', sheets: [], setFile, setSha, chunk: 3 }), prisma, host, log)).toBe(0);
    const text = lines.join('\n');
    expect(text).toMatch(/Run id: +visitdays-from-sheets-/);
    expect(text).toContain('chunk 1/');
    expect(text).toContain('Checked: 2 of 2 day(s) in place; 2 audit row(s) for this run.');

    const a1 = await branch(br.a1);
    expect(a1).toMatchObject({ dayOfVisit: 'SAT', version: before[br.a1]!.version + 1, lastEditedById: stewardId });
    expect(a1.completenessScore).toBeGreaterThan(0);
    expect(a1.updatedAt.getTime()).toBeGreaterThan(before[br.a1]!.updatedAt.getTime());
    expect(await branch(br.b1)).toMatchObject({ dayOfVisit: 'SUN', version: before[br.b1]!.version + 1 });
    for (const id of [br.d1, br.e1, br.f1, br.g1, br.h1, br.i1]) {
      expect(await branch(id), id).toMatchObject({ dayOfVisit: before[id]!.dayOfVisit, version: before[id]!.version });
    }
    expect((await branch(br.c1)).dayOfVisit).toBeNull();
    expect((await branch(br.b2)).dayOfVisit).toBe('MON');

    const rows = await ledger();
    expect(rows.map((r) => (r.after as { phase: string }).phase)).toEqual(['started', 'completed']);
    expect(rows[1]!.after).toMatchObject({ planned: 8, written: 2, changed: 6 });
    runId = rows[0]!.entityId;
    const audit = await branchAudit();
    expect(audit.map((r) => r.entityId).sort()).toEqual([br.a1, br.b1].sort());
    for (const r of audit) {
      expect(r.before).toMatchObject({ dayOfVisit: null });
      expect(r.after).toMatchObject({ runId, source: { file: book, sheet: RA } });
    }
    const custAfter = await prisma.customer.findMany({ where: { id: { in: [cust.a, cust.b] } }, select: { id: true, updatedAt: true } });
    for (const c of custAfter) {
      const was = custBefore.find((x) => x.id === c.id)!;
      expect(c.updatedAt.getTime()).toBeGreaterThan(was.updatedAt.getTime());
    }
  }, 180_000);

  it('a second dry run of the same sheets finds only the branch --apply left alone', async () => {
    const { lines, log } = quiet();
    expect(await run(opts({}), prisma, host, log)).toBe(0);
    expect(setOf(newest('.json'))).toEqual([[br.d1, 'TUE']]);
    expect(lines.join('\n')).toMatch(/2\s+already has this day/);
  }, 180_000);

  it('--reverse is a dry run until --confirm, needs no COMPLETED row, and undoes only what is still as written', async () => {
    // As if the run had stopped before its COMPLETED row: the branch rows carry the run id.
    await purgeAuditLog(prisma, {
      where: { actorId: stewardId, entityType: LEDGER_ENTITY, entityId: runId, after: { path: ['phase'], equals: 'completed' } },
    });
    const { lines, log } = quiet();
    expect(await run(opts({ mode: 'reverse', sheets: [], runId }), prisma, host, log)).toBe(0);
    expect(lines.join('\n')).toContain('2 still as written');
    expect((await branch(br.a1)).dayOfVisit).toBe('SAT');

    // B's branch is edited after the run: its day is no longer the run's to take back.
    await prisma.branch.update({ where: { id: br.b1 }, data: { openingHours: '09-14', version: { increment: 1 } } });
    const a1 = await branch(br.a1);
    const confirmed = quiet();
    expect(await run(opts({ mode: 'reverse', sheets: [], runId, confirm: true }), prisma, host, confirmed.log)).toBe(0);
    expect(confirmed.lines.join('\n')).toContain('REVERSED: 1 of 2');
    expect(await branch(br.a1)).toMatchObject({ dayOfVisit: null, version: a1.version + 1 });
    expect((await branch(br.b1)).dayOfVisit).toBe('SUN');
    const rows = await ledger();
    expect(rows.map((r) => (r.after as { phase: string }).phase)).toEqual(['started', 'reversed']);
    expect(rows[1]!.after).toMatchObject({ reversed: 1, written: 2 });
    const undo = (await branchAudit()).filter((r) => (r.after as { reverseOf?: string }).reverseOf === runId);
    expect(undo.map((r) => r.entityId)).toEqual([br.a1]);
  }, 180_000);

  it('printed no code, no customer and no note in any mode', () => {
    const all = printed.join('\n');
    expect(all).not.toContain(P);
    expect(all).not.toContain(NOTE);
  });
});
