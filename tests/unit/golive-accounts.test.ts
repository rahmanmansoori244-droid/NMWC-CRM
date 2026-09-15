// @vitest-environment node
/**
 * The account audit reads the go-live master to learn which usernames are meant
 * to exist. Everything it then reports hangs off that set being right, and the
 * script is run exactly once, by hand, on launch day — so its parsing is tested
 * here rather than discovered to be wrong at the worst moment.
 *
 * The case that matters is the reordered sheet. The Users sheet carries a
 * `password` column beside `username`. A parser that took a column by POSITION
 * would, on a sheet whose columns moved, read passwords into a set that the
 * script then compares against live usernames — and prints. Finding the column
 * by name is the whole defence, so it is asserted rather than assumed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expectedUsernames } from '@/lib/ops/golive-accounts';

let dir: string;

/** Build a Users sheet with the given header order. */
async function master(file: string, headers: string[], rows: Record<string, string>[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Users');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(headers.map((h) => r[h] ?? ''));
  await wb.xlsx.writeFile(path.join(dir, file));
  return path.join(dir, file);
}

function managers(file: string, body: unknown) {
  const p = path.join(dir, file);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'nmwc-golive-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HEADERS = ['username', 'full_name', 'role', 'password', 'supervisor_username'];
const ROWS = [
  { username: 'c4', full_name: 'Ali', role: 'SALESMAN', password: 'SECRET-1' },
  { username: 'MH01', full_name: 'Said', role: 'SALESMAN', password: 'SECRET-2' },
];
const MANAGERS = {
  steward: { username: 'steward', fullName: 'DATA STEWARD', password: 'SECRET-3' },
  managers: [{ username: 'ashok', password: 'SECRET-4' }, { username: 'rashid' }],
};

describe('expectedUsernames', () => {
  it('reads the sheet and managers.json, lower-cased and merged', async () => {
    const m = await master('a.xlsx', HEADERS, ROWS);
    const j = managers('a.json', MANAGERS);
    const got = await expectedUsernames(m, j);
    expect([...got].sort()).toEqual(['ashok', 'c4', 'mh01', 'rashid', 'steward']);
  });

  it('never picks up a password, even when the columns are reordered', async () => {
    // password FIRST, username fourth. A positional parser reads secrets here.
    const reordered = ['password', 'role', 'full_name', 'username', 'supervisor_username'];
    const m = await master('b.xlsx', reordered, ROWS);
    const j = managers('b.json', MANAGERS);
    const got = await expectedUsernames(m, j);
    expect([...got].sort()).toEqual(['ashok', 'c4', 'mh01', 'rashid', 'steward']);
    for (const v of got) expect(v).not.toMatch(/^secret-/);
  });

  it('is not fooled by a header with different case or padding', async () => {
    const m = await master('c.xlsx', ['  UserName  ', 'password'], [
      { '  UserName  ': 'c7', password: 'SECRET-5' },
    ]);
    const j = managers('c.json', { managers: [] });
    expect([...(await expectedUsernames(m, j))]).toEqual(['c7']);
  });

  it('refuses a sheet with no username column rather than guessing', async () => {
    const m = await master('d.xlsx', ['login', 'password'], [{ login: 'c9', password: 'S' }]);
    const j = managers('d.json', { managers: [] });
    await expect(expectedUsernames(m, j)).rejects.toThrow(/no username column/);
  });

  it('refuses a workbook with no Users sheet', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Routes');
    const p = path.join(dir, 'e.xlsx');
    await wb.xlsx.writeFile(p);
    const j = managers('e.json', { managers: [] });
    await expect(expectedUsernames(p, j)).rejects.toThrow(/no "Users" sheet/);
  });

  it('names the missing file rather than failing obscurely', async () => {
    // The script is run once, by hand, on launch day. An unclear failure there
    // costs the operator more than the check saves.
    await expect(expectedUsernames('x.xlsx', path.join(dir, 'nope.json'))).rejects.toThrow(
      /nope\.json not found/
    );
    const j = managers('f.json', { managers: [] });
    await expect(expectedUsernames(path.join(dir, 'nope.xlsx'), j)).rejects.toThrow(
      /nope\.xlsx not found/
    );
  });

  it('survives a master with no data rows', async () => {
    const m = await master('g.xlsx', HEADERS, []);
    const j = managers('g.json', MANAGERS);
    expect([...(await expectedUsernames(m, j))].sort()).toEqual(['ashok', 'rashid', 'steward']);
  });
});
