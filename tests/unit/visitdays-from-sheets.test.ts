// @vitest-environment node
/**
 * scripts/ops/visitdays-from-sheets.ts without a database: reading the returned sheets,
 * deciding which rows to write and why the others are left alone, the set file and the hash
 * that pins --apply to it, the review workbook, the transactions a set is cut into, and the
 * arguments. The database half (the lock, the guarded write, the audit rows, the rescore and
 * --reverse) runs against Postgres in tests/integration/visitdays-from-sheets.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parseWorkbook } from '@/lib/excel';
import {
  DAY_CODES,
  DEFAULT_CHUNK,
  DEFAULT_OUT,
  HELP_SHEET,
  REASONS,
  REVIEW_HEADINGS,
  chunksOf,
  dayCode,
  listWorkbooks,
  loadSet,
  parseArgs,
  planVisitDays,
  readSheets,
  reviewWorkbook,
  setFileBody,
  sha256,
  type CrmBranch,
  type SetItem,
  type SheetRow,
} from '../../scripts/ops/visitdays-from-sheets';

/** The headings of a route sheet, as the sheets sent to the Managers have them. */
const HEADINGS = [
  'Route',
  'Branch code',
  'Customer code',
  'Customer name',
  'Branch name',
  'Area',
  'Address',
  'Cash/Credit',
  'Status',
  'Visit day',
  'Notes',
];
type Line = [route: string, branch: string, customer: string, day?: string, note?: string];

/** A workbook shaped like the ones sent out: the help sheet, then one sheet per route. */
async function workbook(routes: Record<string, Line[]>, headings: string[] = HEADINGS) {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet(HELP_SHEET).addRow(['Fill ONLY the "Visit day" column.']);
  for (const [code, lines] of Object.entries(routes)) {
    const ws = wb.addWorksheet(code);
    ws.addRow(headings);
    for (const [route, branch, customer, day = '', note = ''] of lines) {
      const byHeading: Record<string, string> = {
        Route: route,
        'Branch code': branch,
        'Customer code': customer,
        'Customer name': 'Synthetic shop',
        'Branch name': 'Main',
        Area: 'Area',
        Address: 'Way 1',
        'Cash/Credit': 'CASH',
        Status: 'ACTIVE',
        'Visit day': day,
        Notes: note,
      };
      ws.addRow(headings.map((h) => byHeading[h] ?? ''));
    }
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

async function rowsOf(routes: Record<string, Line[]>, headings?: string[]) {
  return readSheets([{ file: 'visit-days-to-fill-TST.xlsx', sheets: await parseWorkbook(await workbook(routes, headings)) }]);
}

const branch = (over: Partial<CrmBranch> = {}): CrmBranch => ({
  id: 'b-1',
  branchCode: 'ZZ1-01',
  customerId: 'c-1',
  customerCode: 'ZZ1',
  routeId: 'r-1',
  routeCode: 'RT1',
  status: 'ACTIVE',
  dayOfVisit: null,
  version: 3,
  ...over,
});

const row = (over: Partial<SheetRow> = {}): SheetRow => ({
  file: 'visit-days-to-fill-TST.xlsx',
  sheet: 'RT1',
  row: 2,
  route: 'RT1',
  branchCode: 'ZZ1-01',
  customerCode: 'ZZ1',
  day: 'SAT',
  note: '',
  ...over,
});

describe('dayCode', () => {
  it.each(DAY_CODES.map((d) => [d]))('reads %s', (d) => {
    expect(dayCode(d)).toBe(d);
  });

  it('ignores case and surrounding spaces', () => {
    expect(dayCode(' sat ')).toBe('SAT');
    expect(dayCode('Fri')).toBe('FRI');
  });

  it.each(['Saturday', 'SAT/SUN', 'SA', 'S A T', '1', '', 'SAT,SUN'])('refuses %j', (raw) => {
    expect(dayCode(raw)).toBeNull();
  });
});

describe('readSheets', () => {
  it('reads every route sheet, skips the help sheet, and keeps the real row numbers', async () => {
    const { rows, problems } = await rowsOf({
      RT1: [
        ['RT1', 'ZZ1-01', 'zz1', 'sat'],
        ['RT1', 'ZZ2-01', 'ZZ2'],
      ],
      RT2: [['rt2', 'ZZ3-01', 'ZZ3', 'MON', 'closed']],
    });
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      { file: 'visit-days-to-fill-TST.xlsx', sheet: 'RT1', row: 2, route: 'RT1', branchCode: 'ZZ1-01', customerCode: 'ZZ1', day: 'sat', note: '' },
      { file: 'visit-days-to-fill-TST.xlsx', sheet: 'RT1', row: 3, route: 'RT1', branchCode: 'ZZ2-01', customerCode: 'ZZ2', day: '', note: '' },
      { file: 'visit-days-to-fill-TST.xlsx', sheet: 'RT2', row: 2, route: 'RT2', branchCode: 'ZZ3-01', customerCode: 'ZZ3', day: 'MON', note: 'closed' },
    ]);
  });

  it('reads each heading from its own column when a column was moved', async () => {
    const moved = ['Visit day', ...HEADINGS.filter((h) => h !== 'Visit day')];
    const { rows, problems } = await rowsOf({ RT1: [['RT1', 'ZZ1-01', 'ZZ1', 'TUE']] }, moved);
    expect(problems).toEqual([]);
    expect(rows[0]).toMatchObject({ route: 'RT1', branchCode: 'ZZ1-01', day: 'TUE' });
  });

  it('does not read a sheet missing a heading it needs, and says which', async () => {
    const renamed = HEADINGS.map((h) => (h === 'Visit day' ? 'Day' : h));
    const { rows, problems } = await rowsOf({ RT1: [['RT1', 'ZZ1-01', 'ZZ1', 'TUE']] }, renamed);
    expect(rows).toEqual([]);
    expect(problems).toEqual([
      { file: 'visit-days-to-fill-TST.xlsx', sheet: 'RT1', why: 'missing heading(s): Visit day' },
    ]);
  });

  it('does not read a sheet with a heading in two columns', async () => {
    const twice = [...HEADINGS, 'Visit day'];
    const { rows, problems } = await rowsOf({ RT1: [['RT1', 'ZZ1-01', 'ZZ1', 'TUE']] }, twice);
    expect(rows).toEqual([]);
    expect(problems[0]?.why).toBe('a heading is in more than one column');
  });

  it('refuses a route sheet found in two workbooks: two versions of one region', async () => {
    const one = await parseWorkbook(await workbook({ RT1: [['RT1', 'ZZ1-01', 'ZZ1', 'SAT']] }));
    const two = await parseWorkbook(await workbook({ rt1: [['RT1', 'ZZ1-01', 'ZZ1', 'MON']] }));
    expect(() =>
      readSheets([
        { file: 'a.xlsx', sheets: one },
        { file: 'a (2).xlsx', sheets: two },
      ])
    ).toThrow(/route sheet rt1 is in two workbooks, a\.xlsx and a \(2\)\.xlsx/);
  });
});

describe('planVisitDays', () => {
  it('writes a valid day onto a live ACTIVE branch with no day, pinned to the version it read', () => {
    const plan = planVisitDays([row({ day: 'sat', row: 7 })], [branch()]);
    expect(plan.items).toEqual([
      {
        branchId: 'b-1',
        customerId: 'c-1',
        routeId: 'r-1',
        version: 3,
        day: 'SAT',
        branchCode: 'ZZ1-01',
        file: 'visit-days-to-fill-TST.xlsx',
        sheet: 'RT1',
        row: 7,
      },
    ]);
    expect(plan.review).toEqual([]);
  });

  it.each([
    ['a note beside a day', row({ note: 'visit twice' }), [branch()], REASONS.note],
    ['a note and no day', row({ day: '', note: 'closed' }), [branch()], REASONS.noteOnly],
    ['a day that is not one of the seven', row({ day: 'Saturday' }), [branch()], REASONS.badDay],
    ["column A not the sheet's route", row({ route: 'RT9' }), [branch()], REASONS.sheetRoute],
    ['no live branch with the code', row({ branchCode: 'ZZ9-01' }), [branch()], REASONS.noBranch],
    ['the branch belongs to another customer', row({ customerCode: 'ZZ2' }), [branch()], REASONS.otherCustomer],
    ['the branch moved to another route', row(), [branch({ routeCode: 'RT2' })], REASONS.moved],
    ['the branch is not ACTIVE', row(), [branch({ status: 'CLOSED' })], REASONS.inactive],
    ['the branch has another day already', row({ day: 'SUN' }), [branch({ dayOfVisit: 'MON' })], REASONS.otherDay],
  ] as const)('leaves %s to a person', (_label, r, branches, why) => {
    const plan = planVisitDays([r], [...branches]);
    expect(plan.items).toEqual([]);
    expect(plan.review).toEqual([{ ...r, why }]);
    expect(plan.counts[why]).toBe(1);
  });

  it('counts a blank row and a day already in place, without asking anyone', () => {
    const plan = planVisitDays(
      [row({ day: '' }), row({ branchCode: 'ZZ2-01', customerCode: 'ZZ2', day: 'mon' })],
      [branch(), branch({ id: 'b-2', branchCode: 'ZZ2-01', customerId: 'c-2', customerCode: 'ZZ2', dayOfVisit: 'MON' })]
    );
    expect(plan.items).toEqual([]);
    expect(plan.review).toEqual([]);
    expect(plan.counts).toEqual({ [REASONS.blank]: 1, [REASONS.sameDay]: 1 });
  });

  it('loads a branch once when every row naming it gives the same day', () => {
    const plan = planVisitDays([row({ row: 2 }), row({ row: 9, day: ' sat ', branchCode: 'zz1-01' })], [branch()]);
    expect(plan.items.map((i) => [i.branchId, i.day, i.row])).toEqual([['b-1', 'SAT', 2]]);
    expect(plan.counts[REASONS.repeat]).toBe(1);
  });

  it.each([
    ['another day', row({ row: 9, day: 'MON' })],
    ['a note', row({ row: 9, day: 'MON', note: 'x' })],
    ['the same day and a note', row({ row: 9, note: 'confirmed' })],
    ['a day that is not one of the seven', row({ row: 9, day: 'Monday' })],
    ['a blank', row({ row: 9, day: '' })],
    ['another route', row({ row: 9, sheet: 'RT2', route: 'RT2' })],
  ])('holds a branch back when another row naming it has %s, and sends both to a person', (_label, other) => {
    const first = row({ row: 2 });
    const plan = planVisitDays([first, other], [branch()]);
    expect(plan.items).toEqual([]);
    expect(plan.review).toEqual([
      { ...first, why: REASONS.conflict },
      { ...other, why: REASONS.conflict },
    ]);
    expect(plan.counts[REASONS.conflict]).toBe(2);
  });

  it('lists the set in branch-id order, whatever order the rows came in', () => {
    const plan = planVisitDays(
      [row({ branchCode: 'ZZ2-01', customerCode: 'ZZ2' }), row()],
      [branch({ id: 'b-9' }), branch({ id: 'b-2', branchCode: 'ZZ2-01', customerId: 'c-2', customerCode: 'ZZ2' })]
    );
    expect(plan.items.map((i) => i.branchId)).toEqual(['b-2', 'b-9']);
  });
});

describe('the set file', () => {
  const items = planVisitDays([row()], [branch()]).items;
  const files = [{ file: 'visit-days-to-fill-TST.xlsx', sha256: 'f'.repeat(64) }];
  const body = setFileBody(items, files, '2026-10-04T00:00:00.000Z');

  it('is the same text for the same input, so its hash names one reviewed set', () => {
    expect(setFileBody(items, files, '2026-10-04T00:00:00.000Z')).toBe(body);
    const changed = setFileBody([{ ...items[0]!, day: 'SUN' }], files, '2026-10-04T00:00:00.000Z');
    expect(sha256(changed)).not.toBe(sha256(body));
  });

  it('loads back with its full hash or a prefix of 12 or more', () => {
    expect(loadSet(body, sha256(body)).items).toEqual(items);
    expect(loadSet(body, sha256(body).slice(0, 12).toUpperCase()).files).toEqual(['visit-days-to-fill-TST.xlsx']);
  });

  it.each<[string, string, string]>([
    ['another hash', body, '0'.repeat(16)],
    ['a hash shorter than 12', body, sha256(body).slice(0, 11)],
    ['a body changed after review', body.replace('"SAT"', '"SUN"'), sha256(body)],
  ])('refuses %s', (_label, text, hash) => {
    expect(() => loadSet(text, hash)).toThrow(/--set-sha does not match/);
  });

  it.each([
    ['not JSON', 'not json', /not JSON/],
    ['another kind of file', JSON.stringify({ kind: 'temix-link', items: [] }), /not a visit-day set/],
    ['a day that is not one of the seven', body.replace('"SAT"', '"SATURDAY"'), /not a visit-day set/],
    ['a branch named twice', setFileBody([items[0]!, items[0]!], files, 'x'), /names a branch twice/],
  ])('refuses %s even when the hash matches', (_label, text, message) => {
    expect(() => loadSet(text, sha256(text))).toThrow(message);
  });
});

describe('reviewWorkbook', () => {
  const review = [
    { ...row({ note: '"=WEBSERVICE("http://x") and an open quote' }), why: REASONS.note },
    { ...row({ row: 3, note: '=HYPERLINK("http://x")' }), why: REASONS.note },
  ];
  const problems = [{ file: 'visit-days-to-fill-TST.xlsx', sheet: 'RT3', why: 'missing heading(s): Notes' }];

  it('lists the sheets not read, then each row for a person, one line each', async () => {
    const [sheet] = await parseWorkbook(await reviewWorkbook(review, problems));
    expect(sheet!.headers).toEqual(REVIEW_HEADINGS);
    expect(sheet!.rows[0]).toMatchObject({ Sheet: 'RT3', Why: 'sheet not read: missing heading(s): Notes' });
    expect(sheet!.rows[1]).toMatchObject({
      File: 'visit-days-to-fill-TST.xlsx', Sheet: 'RT1', Row: 2, Route: 'RT1', 'Branch code': 'ZZ1-01',
      'Customer code': 'ZZ1', 'Visit day': 'SAT', Notes: '"=WEBSERVICE("http://x") and an open quote', Why: REASONS.note,
    });
    expect(sheet!.rows).toHaveLength(3);
  });

  it('keeps a note that looks like a formula as text, never a formula', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await reviewWorkbook(review, [])) as unknown as ArrayBuffer);
    for (const r of [2, 3]) {
      const cell = wb.getWorksheet('Review')!.getRow(r).getCell(8);
      expect(cell.type).toBe(ExcelJS.ValueType.String);
      expect(cell.formula).toBeUndefined();
    }
    expect(wb.getWorksheet('Review')!.getRow(3).getCell(8).value).toBe('=HYPERLINK("http://x")');
  });
});

describe('chunksOf', () => {
  const item = (customerId: string, branchId: string): SetItem => ({
    branchId, customerId, routeId: 'r', version: 0, day: 'SAT', branchCode: branchId, file: 'f', sheet: 's', row: 2,
  });

  it("keeps a customer's branches together, and no chunk over the size", () => {
    const items = [item('c3', 'b4'), item('c2', 'b3'), item('c1', 'b1'), item('c2', 'b2')];
    expect(chunksOf(items, 2).map((c) => c.map((i) => i.branchId))).toEqual([['b1'], ['b2', 'b3'], ['b4']]);
  });

  it('splits a customer with more branches than the size, each part on its own', () => {
    const items = ['b1', 'b2', 'b3', 'b4', 'b5'].map((b) => item('c1', b));
    const chunks = chunksOf(items, 2);
    expect(chunks.map((c) => c.map((i) => i.branchId))).toEqual([['b1', 'b2'], ['b3', 'b4'], ['b5']]);
    expect(Math.max(...chunks.map((c) => c.length))).toBe(2);
  });

  it('puts every branch in exactly one chunk', () => {
    const items = Array.from({ length: 23 }, (_, i) => item(`c${i % 5}`, `b${String(i).padStart(2, '0')}`));
    const ids = chunksOf(items, 4).flat().map((i) => i.branchId).sort();
    expect(ids).toEqual(items.map((i) => i.branchId).sort());
  });
});

describe('parseArgs', () => {
  const host = ['--expect-host', 'ep-test'];

  it('runs a dry run on the sheets, into golive-data by default', () => {
    expect(parseArgs([...host, '--sheets', 'a', '--sheets', 'b.xlsx'])).toEqual({
      mode: 'dry', sheets: ['a', 'b.xlsx'], out: DEFAULT_OUT, setFile: '', setSha: '', actor: '', runId: '', confirm: false, chunk: DEFAULT_CHUNK,
    });
  });

  it('applies a named set, in chunks of the size asked for', () => {
    expect(
      parseArgs([...host, '--set', 's.json', '--set-sha', 'abcdef012345', '--apply', '--actor', 'data.steward', '--chunk', '50'])
    ).toMatchObject({ mode: 'apply', setFile: 's.json', setSha: 'abcdef012345', actor: 'data.steward', chunk: 50 });
  });

  it('reverses a run by its id', () => {
    expect(parseArgs([...host, '--reverse', 'visitdays-from-sheets-x', '--confirm'])).toMatchObject({
      mode: 'reverse', runId: 'visitdays-from-sheets-x', confirm: true,
    });
  });

  it.each([
    ['a dry run without sheets', [], /needs --sheets/],
    ['--apply without the set', ['--apply'], /needs --set/],
    ['--rehearse without its hash', ['--rehearse', '--set', 's.json'], /needs --set/],
    ['--apply that also names sheets', ['--apply', '--set', 's', '--set-sha', 'abcdef012345', '--sheets', 'x'], /Drop --sheets/],
    ['two modes at once', ['--rehearse', '--apply', '--set', 's', '--set-sha', 'abcdef012345'], /at most one/],
    ['a mistyped flag', ['--sheets', 'x', '--aply'], /unknown argument: --aply/],
    ['a stray value', ['--sheets', 'x', 'y'], /unknown argument: y/],
    ['a flag without its value', ['--sheets', '--apply'], /--sheets was passed without a value/],
    ['--confirm outside --reverse', ['--sheets', 'x', '--confirm'], /--confirm belongs to --reverse/],
    ['the same value twice', ['--sheets', 'x', '--out', 'a', '--out', 'b'], /--out was passed more than once/],
    ['a chunk of none', ['--sheets', 'x', '--chunk', '0'], /--chunk takes a whole number/],
    ['a chunk over the cap', ['--sheets', 'x', '--chunk', '1001'], /--chunk takes a whole number/],
    ['a chunk that is not a whole number', ['--sheets', 'x', '--chunk', '2.5'], /--chunk takes a whole number/],
  ])('refuses %s', (_label, args, message) => {
    expect(() => parseArgs([...host, ...args])).toThrow(message);
  });
});

describe('listWorkbooks', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vdsheets-'));
  writeFileSync(path.join(dir, 'visit-days-to-fill-B.xlsx'), 'x');
  writeFileSync(path.join(dir, 'visit-days-to-fill-A.xlsx'), 'x');
  writeFileSync(path.join(dir, '~$visit-days-to-fill-A.xlsx'), 'x');
  writeFileSync(path.join(dir, 'notes.txt'), 'x');

  it('takes every .xlsx in a folder, in name order, and not Excel lock files', () => {
    expect(listWorkbooks([dir]).map((f) => path.basename(f))).toEqual([
      'visit-days-to-fill-A.xlsx',
      'visit-days-to-fill-B.xlsx',
    ]);
  });

  it('reads a workbook named twice once', () => {
    expect(listWorkbooks([dir, path.join(dir, 'visit-days-to-fill-A.xlsx')])).toHaveLength(2);
  });

  it('refuses a path that is not there, and a folder with no workbook', () => {
    expect(() => listWorkbooks([path.join(dir, 'missing')])).toThrow(/nothing at/);
    const empty = mkdtempSync(path.join(os.tmpdir(), 'vdsheets-empty-'));
    expect(() => listWorkbooks([empty])).toThrow(/no .xlsx workbook/);
  });

  it('refuses two workbooks with the same name, which the set could not tell apart', () => {
    const other = path.join(dir, 'other');
    mkdirSync(other);
    writeFileSync(path.join(other, 'visit-days-to-fill-A.xlsx'), 'x');
    expect(() => listWorkbooks([dir, other])).toThrow(/two workbooks are named visit-days-to-fill-A.xlsx/);
  });
});

describe('the npm script', () => {
  it('is beside the other operator scripts', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['ops:visitdays-from-sheets']).toBe('tsx scripts/ops/visitdays-from-sheets.ts');
  });
});
