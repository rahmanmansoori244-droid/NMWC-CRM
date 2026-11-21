/**
 * The daily Temix import, stage 3: how a daily file's headings and rows are
 * read (lib/temix-daily-file.ts, lib/temix-daily-csv.ts, lib/temix-daily-upload.ts).
 * Every file here is synthetic, built in code from the agreed columns.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { parseWorkbook } from '@/lib/excel';
import {
  CUSTOMER_MASTER_ONLY_HEADINGS,
  TEMIX_DAILY_COLUMNS,
  TEMIX_DAILY_NOTE_LABEL,
  TEMIX_DAILY_OPTIONAL,
  TEMIX_DAILY_REQUIRED,
  TEMIX_DAILY_UPLOAD_NOTES,
  dailyHeadingRefusal,
  notesAtUpload,
  readNotesAtUpload,
  readCreatedDay,
  readCreditDays,
  readCreditLimit,
  readStatus,
  reportDailyHeadings,
  stageDailyRows,
  type DailySheetRow,
} from '@/lib/temix-daily-file';
import { CsvReadError, csvDelimiter, csvRecords, parseCsv, MAX_DAILY_ROWS } from '@/lib/temix-daily-csv';
import { dailyFileKind, dailyFileKindRefusal, dailyFileName, uploadMessage } from '@/lib/temix-daily-upload';
import { CUSTOMER_COLUMNS } from '@/lib/import-headings';

const HEAD = [...TEMIX_DAILY_COLUMNS] as string[];

type Cells = Partial<Record<(typeof TEMIX_DAILY_COLUMNS)[number], string | number | null>>;

const base: Cells = {
  cust_code: 'ZZD0001',
  branch_code: 'ZZD0001-01',
  cust_name: 'Customer 1',
  route: 'ZR10',
  payment_terms: 'CASH',
  credit_limit: '0',
  payment_term_days: '0',
  status: 'A',
  created_date: '2026-01-15',
};

const sheetOf = (rows: Cells[], headers = HEAD) => ({
  headers,
  rows: rows.map((r) => Object.fromEntries(headers.map((h) => [h, (r as Record<string, unknown>)[h] ?? null])) as DailySheetRow),
  rowNumbers: rows.map((_, i) => i + 2),
});

const stage = (rows: Cells[], headers = HEAD) => {
  const s = sheetOf(rows, headers);
  const report = reportDailyHeadings(s.headers);
  expect(dailyHeadingRefusal(report)).toBeNull();
  return stageDailyRows(s, report);
};

describe('the agreed columns', () => {
  it('nine required, three optional, and none of them a customer-master-only heading', () => {
    expect(TEMIX_DAILY_REQUIRED).toEqual([
      'cust_code',
      'branch_code',
      'cust_name',
      'route',
      'payment_terms',
      'credit_limit',
      'payment_term_days',
      'status',
      'created_date',
    ]);
    expect(TEMIX_DAILY_OPTIONAL).toEqual(['cr_no', 'phone', 'address']);
    for (const m of CUSTOMER_MASTER_ONLY_HEADINGS) {
      expect(CUSTOMER_COLUMNS as readonly string[]).toContain(m);
      expect(TEMIX_DAILY_COLUMNS as readonly string[]).not.toContain(m);
    }
  });

  it('every note is a code word the database accepts, with a label', () => {
    for (const n of TEMIX_DAILY_UPLOAD_NOTES) {
      expect(n).toMatch(/^[A-Z][A-Z0-9_]{0,59}$/);
      expect(TEMIX_DAILY_NOTE_LABEL[n]).toBeTruthy();
    }
  });
});

describe('headings', () => {
  it('reads the agreed headings whatever their capitals, spaces or underscores', () => {
    const r = reportDailyHeadings(['CUST CODE', 'Branch_Code', 'custname', 'ROUTE', 'Payment Terms', 'credit-limit', 'PAYMENT_TERM_DAYS', 'Status', 'Created Date', 'Notes']);
    expect(dailyHeadingRefusal(r)).toBeNull();
    expect(r.read.cust_code).toBe('CUST CODE');
    expect(r.read.created_date).toBe('Created Date');
    expect(r.notRead).toEqual(['Notes']);
  });

  it('refuses a file missing a required heading, naming it', () => {
    const r = reportDailyHeadings(HEAD.filter((h) => h !== 'status' && h !== 'created_date'));
    expect(r.missing).toEqual(['status', 'created_date']);
    expect(dailyHeadingRefusal(r)).toMatch(/has no status, created_date columns.*Nothing was uploaded/);
  });

  it('the optional headings may be left out', () => {
    expect(dailyHeadingRefusal(reportDailyHeadings([...TEMIX_DAILY_REQUIRED]))).toBeNull();
  });

  it('refuses a customer master by its headings, sending it to the Import screen', () => {
    // The customer-master template's own headings.
    const r = reportDailyHeadings([...CUSTOMER_COLUMNS]);
    expect(dailyHeadingRefusal(r)).toMatch(/This is a customer master.*"sales_region", "temix_code", "channel", "day_of_visit", "customer_status".*Import screen/);
    // One master-only heading is enough, even beside every agreed column.
    for (const m of ['Temix Code', 'SALES REGION', 'day of visit', 'Customer_Status', 'CHANNEL']) {
      expect(dailyHeadingRefusal(reportDailyHeadings([...HEAD, m])), m).toMatch(/customer master/);
    }
  });

  it('refuses one column under two spellings', () => {
    expect(dailyHeadingRefusal(reportDailyHeadings([...HEAD, 'Cust Code']))).toMatch(
      /"cust_code", "Cust Code" are all read as the cust_code column/
    );
  });
});

describe('rows', () => {
  it('codes in capitals with ASCII digits and no invisible characters; small letters noted', () => {
    const [r] = stage([{ ...base, cust_code: ' zzd٠٠٠2\u200f', branch_code: 'zzd0002-a', route: 'zr10ma' }]);
    expect(r!.custCodeKey).toBe('ZZD0002');
    expect(r!.branchCodeKey).toBe('ZZD0002-A');
    expect(r!.parsed.route).toBe('ZR10MA');
    expect(r!.parsed.capitalised.map((c) => c.cell)).toEqual(['cust_code', 'branch_code', 'route']);
    expect(r!.notes).toEqual([]);
  });

  it('the row as sent is kept as it came', () => {
    const [r] = stage([{ ...base, cust_code: 'zzd0001' }]);
    expect(r!.raw.cust_code).toBe('zzd0001');
    expect(r!.rowNumber).toBe(2);
  });

  it('a blank branch code stays blank: which row is the main account is not decided here', () => {
    const [r] = stage([{ ...base, branch_code: null }]);
    expect(r!.branchCodeKey).toBeNull();
    expect(r).not.toHaveProperty('isMainRow');
    expect(r!.notes).toEqual([]);
  });

  it('status is A or I, any capitals; anything else (blank too) is noted', () => {
    expect(readStatus('a')).toBe('A');
    expect(readStatus(' I ')).toBe('I');
    for (const bad of ['', null, 'X', 'ACTIVE', 'AI']) expect(readStatus(bad)).toBeUndefined();
    const rows = stage([{ ...base, status: 'i' }, { ...base, branch_code: 'ZZD0001-02', status: 'Active' }, { ...base, branch_code: 'ZZD0001-03', status: null }]);
    expect(rows.map((r) => r.parsed.status)).toEqual(['I', null, null]);
    expect(rows.map((r) => r.notes.includes('STATUS_NOT_A_OR_I'))).toEqual([false, true, true]);
  });

  it('payment_terms is kept as written (in capitals) and not checked against a list', () => {
    const rows = stage([{ ...base, payment_terms: 'credit' }, { ...base, branch_code: 'ZZD0001-02', payment_terms: 'ANYTHING' }]);
    expect(rows.map((r) => r.parsed.paymentTerms)).toEqual(['CREDIT', 'ANYTHING']);
    expect(rows.flatMap((r) => r.notes)).toEqual([]);
  });

  it('credit limit and days by the Import screen rules', () => {
    expect(readCreditLimit('1500.1234')).toBe(1500.123);
    expect(readCreditLimit(250)).toBe(250);
    expect(readCreditLimit('')).toBeNull();
    for (const bad of ['1,500', '-1', 'abc', '1e12']) expect(readCreditLimit(bad), bad).toBeUndefined();
    expect(readCreditDays('30')).toBe(30);
    for (const bad of ['30.5', '366', '-1', 'x']) expect(readCreditDays(bad), bad).toBeUndefined();
    const [r] = stage([{ ...base, credit_limit: '1,500', payment_term_days: '45.5' }]);
    expect(r!.notes).toEqual(expect.arrayContaining(['CREDIT_LIMIT_NOT_A_NUMBER', 'CREDIT_DAYS_NOT_WHOLE_DAYS']));
    expect(r!.parsed.creditLimit).toBeNull();
  });

  it('created_date is kept in parsed only, as a day when it is ISO, never guessed', () => {
    expect(readCreatedDay('2026-02-28')).toBe('2026-02-28');
    expect(readCreatedDay('2026-02-28T00:00:00.000Z')).toBe('2026-02-28');
    for (const bad of ['2026-02-30', '03/04/2026', '28-02-2026', '45000']) expect(readCreatedDay(bad), bad).toBeNull();
    const [a, b] = stage([{ ...base }, { ...base, branch_code: 'ZZD0001-02', created_date: '03/04/2026' }]);
    expect(a!.parsed.createdDate).toEqual({ written: '2026-01-15', day: '2026-01-15' });
    expect(b!.parsed.createdDate).toEqual({ written: '03/04/2026', day: null });
    expect(b!.notes).toEqual(['CREATED_DATE_UNREADABLE']);
  });

  it('no customer code, no route, a spreadsheet error: noted', () => {
    const [r] = stage([{ ...base, cust_code: '  ', route: '', cust_name: '#ERROR:#N/A' }]);
    expect(r!.custCodeKey).toBeNull();
    expect(r!.notes).toEqual(expect.arrayContaining(['CUST_CODE_MISSING', 'ROUTE_MISSING', 'CELL_ERROR']));
  });

  it('the look-alike shop-code rule of the Import screen, among one customer\'s rows: zeros or capitals', () => {
    const rows = stage([
      { ...base, branch_code: 'ZZD0001-01' },
      { ...base, branch_code: 'ZZD0001-1' },
      { ...base, branch_code: 'ZZD0001-ab' },
      { ...base, branch_code: 'ZZD0001-AB' },
      { ...base, branch_code: 'ZZD0001-02' },
      // Another customer's look-alike code is not compared.
      { ...base, cust_code: 'ZZD0009', branch_code: 'ZZD0001-2' },
    ]);
    expect(rows.map((r) => r.notes.includes('SHOP_CODE_LOOKALIKE'))).toEqual([true, true, true, true, false, false]);
    expect(rows[0]!.parsed.shopLookalike).toEqual({ other: 'ZZD0001-1', row: 3, caseOnly: false });
    expect(rows[2]!.parsed.shopLookalike).toEqual({ other: 'ZZD0001-AB', row: 5, caseOnly: true });
    // Codes that differ only in capitals are a look-alike, not a duplicate.
    expect(rows.some((r) => r.notes.includes('DUPLICATE_ROW'))).toBe(false);
  });

  it('the same customer and shop code twice (two blanks included) is noted on each row', () => {
    const rows = stage([
      { ...base },
      { ...base },
      { ...base, branch_code: null },
      { ...base, branch_code: null },
      { ...base, branch_code: 'ZZD0001-05' },
    ]);
    expect(rows.map((r) => r.notes.includes('DUPLICATE_ROW'))).toEqual([true, true, true, true, false]);
  });

  it('one shop written apart only in the capitals of the customer prefix is a case-only look-alike, never two clean rows', () => {
    // rowShopCode puts the prefix in capitals, so both compose to one code and
    // the Import screen's sibling rule alone passes them; both rows would carry
    // the same branchCodeKey with no note.
    for (const [a, b] of [
      ['C1-01', 'c1-01'],
      ['C1', 'c1'],
    ]) {
      const rows = stage([
        { ...base, cust_code: 'C1', branch_code: a },
        { ...base, cust_code: 'C1', branch_code: b },
      ]);
      expect(rows.map((r) => r.branchCodeKey), a).toEqual([a, a]);
      expect(rows.map((r) => r.notes), a).toEqual([['SHOP_CODE_LOOKALIKE'], ['SHOP_CODE_LOOKALIKE']]);
      expect(rows[0]!.parsed.shopLookalike, a).toEqual({ other: b, row: 3, caseOnly: true });
      expect(rows[1]!.parsed.shopLookalike, a).toEqual({ other: a, row: 2, caseOnly: true });
    }
  });

  it('one shop written with and without the customer prefix is a duplicate row', () => {
    const rows = stage([
      { ...base, cust_code: 'C1', branch_code: '01' },
      { ...base, cust_code: 'C1', branch_code: 'C1-01' },
      { ...base, cust_code: 'C1', branch_code: 'C1-02' },
    ]);
    expect(rows.map((r) => r.notes)).toEqual([['DUPLICATE_ROW'], ['DUPLICATE_ROW'], []]);
  });

  it('a spreadsheet error word in a cell is a cell error, written bare (CSV) or marked (workbook)', () => {
    for (const w of ['#N/A', '#REF!', '#VALUE!', '#DIV/0!', '#NAME?', '#NUM!', '#NULL!', ' #n/a ']) {
      const [r] = stage([{ ...base, branch_code: w }]);
      expect(r!.notes, w).toContain('CELL_ERROR');
    }
    const s = parseCsv(new TextEncoder().encode(`${HEAD.join(',')}\n#N/A,01,X,R1,CASH,0,0,A,,,,\n`));
    const report = reportDailyHeadings(s.headers);
    const [r] = stageDailyRows(s, report);
    expect(r!.notes).toContain('CELL_ERROR');
    // Text that only starts with # is not an error word.
    expect(stage([{ ...base, cust_name: '#1 Shop' }])[0]!.notes).toEqual([]);
  });

  it('only the agreed columns are kept: a column that is not read has no cell in raw', () => {
    const headers = [...HEAD, 'owner_mobile'];
    const s = {
      headers,
      rows: [{ ...(base as DailySheetRow), cr_no: null, phone: null, address: null, owner_mobile: '99999999' }],
      rowNumbers: [2],
    };
    const report = reportDailyHeadings(headers);
    expect(report.notRead).toEqual(['owner_mobile']);
    const [r] = stageDailyRows(s, report);
    expect(Object.keys(r!.raw).sort()).toEqual([...HEAD].sort());
    expect(JSON.stringify(r)).not.toContain('99999999');
    // An error in a column that is not read is not this row's note.
    const [e] = stageDailyRows({ ...s, rows: [{ ...s.rows[0]!, owner_mobile: '#N/A' }] }, report);
    expect(e!.notes).toEqual([]);
  });

  it('the notes are counted once at upload, and read back from the file as code words and numbers only', () => {
    const rows = stage([{ ...base }, { ...base }, { ...base, branch_code: 'ZZD0001-02', status: 'X', route: '' }, { ...base, branch_code: 'ZZD0001-03' }]);
    const counted = notesAtUpload(rows);
    expect(counted).toEqual({ rows: 3, byNote: { DUPLICATE_ROW: 2, STATUS_NOT_A_OR_I: 1, ROUTE_MISSING: 1 } });
    expect(readNotesAtUpload({ kind: 'csv', notesAtUpload: JSON.parse(JSON.stringify(counted)) })).toEqual(counted);
    // A file without the counts, or with words that are not notes, reads safely.
    expect(readNotesAtUpload({})).toBeNull();
    expect(readNotesAtUpload(null)).toBeNull();
    expect(readNotesAtUpload({ notesAtUpload: { rows: 1, byNote: { 'Customer 1': 4, ROUTE_MISSING: 1 } } })).toEqual({ rows: 1, byNote: { ROUTE_MISSING: 1 } });
  });

  it('optional cells are kept when present and null when the column is absent', () => {
    const withOpt = stage([{ ...base, cr_no: ' 1234567 ', phone: '90000000', address: 'Street 1' }]);
    expect(withOpt[0]!.parsed).toMatchObject({ crNo: '1234567', phone: '90000000', address: 'Street 1' });
    const without = stage([{ ...base }], [...TEMIX_DAILY_REQUIRED]);
    expect(without[0]!.parsed).toMatchObject({ crNo: null, phone: null, address: null });
  });
});

describe('CSV', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('keeps every cell as text: leading zeros survive, nothing is turned into a number or date', () => {
    const s = parseCsv(enc(`${HEAD.join(',')}\r\n0012,0012-01,"Customer, One",zr1,CASH,1500,30,A,2026-01-15,,,"Line 1\nLine 2"\r\n`));
    expect(s.headers).toEqual(HEAD);
    expect(s.rows[0]).toMatchObject({ cust_code: '0012', branch_code: '0012-01', cust_name: 'Customer, One', credit_limit: '1500', cr_no: null, address: 'Line 1\nLine 2' });
    expect(s.rowNumbers).toEqual([2]);
  });

  it('drops a byte-order mark, skips blank records and numbers the rest as the file does', () => {
    const s = parseCsv(enc(`\uFEFF${HEAD.join(',')}\n${'A1,,,,,,,,'}\n,,,,,,,,\n\nA2,,,,,,,,\n`));
    expect(s.headers[0]).toBe('cust_code');
    expect(s.rows.map((r) => r.cust_code)).toEqual(['A1', 'A2']);
    expect(s.rowNumbers).toEqual([2, 5]);
  });

  it('a row keeps the number of the line it starts on, after a quoted cell holding line breaks', () => {
    const s = parseCsv(
      enc(`${HEAD.join(',')}\r\nA1,,,,,,,,,,,"Line 1\r\nLine 2\nLine 3\rLine 4"\r\nA2,,,,,,,,\n\nA3,"x\ny",,,,,,,\nA4,,,,,,,,\n`)
    );
    expect(s.rows.map((r) => r.cust_code)).toEqual(['A1', 'A2', 'A3', 'A4']);
    // A1 spans lines 2-5; A2 is line 6; line 7 is blank; A3 spans 8-9; A4 is 10.
    expect(s.rowNumbers).toEqual([2, 6, 8, 10]);
  });

  it('semicolon and tab files; quotes inside quotes', () => {
    expect(csvDelimiter('a;b;c\n1,5;2;3')).toBe(';');
    expect(csvDelimiter('a\tb\n')).toBe('\t');
    expect(csvDelimiter('"a;b",c\n')).toBe(',');
    expect(csvRecords('x;"say ""hi""";z', ';')).toEqual([['x', 'say "hi"', 'z']]);
  });

  it('refuses a file not in UTF-8, and one that ends inside a quote', () => {
    expect(() => parseCsv(new Uint8Array([0x63, 0x0a, 0xe1, 0xe2, 0x0a]))).toThrow(CsvReadError);
    expect(() => parseCsv(new Uint8Array([0x63, 0x0a, 0xe1, 0xe2, 0x0a]))).toThrow(/not in UTF-8/);
    expect(() => parseCsv(enc('a,b\n"open,1\n'))).toThrow(/ends inside a quoted cell/);
  });

  it('records a repeated heading so the upload refuses it', () => {
    expect(parseCsv(enc('cust_code,CUST_CODE\n1,2\n')).duplicateHeadings).toEqual([{ heading: 'CUST_CODE', first: 'A', again: 'B' }]);
  });

  it('caps the rows as the workbook reader does', () => {
    const many = `cust_code\n${'X\n'.repeat(MAX_DAILY_ROWS + 1)}`;
    expect(() => parseCsv(enc(many))).toThrow(/too many rows/);
  });
});

describe('the file kind', () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]);
  const text = new TextEncoder().encode('cust_code\n');

  it('an .xlsx must be a zip, a .csv must not be one, anything else is refused', () => {
    expect(dailyFileKind('Daily.XLSX', zip)).toBe('xlsx');
    expect(dailyFileKind('daily.csv', text)).toBe('csv');
    expect(dailyFileKind('daily.xlsx', text)).toBeNull();
    expect(dailyFileKind('daily.csv', zip)).toBeNull();
    expect(dailyFileKind('daily.xls', zip)).toBeNull();
    expect(dailyFileKindRefusal(null, 10)).toMatch(/\.xlsx workbook or a \.csv file/);
    expect(dailyFileKindRefusal('csv', 0)).toMatch(/empty/);
    expect(dailyFileKindRefusal('csv', 10)).toBeNull();
  });

  it('the recorded name is the last part of the path, trimmed and capped', () => {
    expect(dailyFileName('C:\\x\\y\\daily.csv')).toBe('daily.csv');
    expect(dailyFileName('  ')).toBe('unnamed');
    expect(dailyFileName(`${'a'.repeat(300)}.csv`)).toHaveLength(200);
  });
});

describe('an .xlsx daily file, through the workbook reader', () => {
  it('reads a synthetic workbook built from the agreed columns', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Daily');
    ws.addRow(HEAD.map((h) => h.toUpperCase()));
    ws.addRow(['zzd0001', 'ZZD0001-01', 'Customer 1', 'zr10', 'Cash', 1500, 30, 'a', new Date(Date.UTC(2026, 0, 15)), null, null, null]);
    const buf = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(dailyFileKind('daily.xlsx', buf)).toBe('xlsx');
    const [sheet] = await parseWorkbook(buf);
    const report = reportDailyHeadings(sheet!.headers);
    expect(dailyHeadingRefusal(report)).toBeNull();
    const [r] = stageDailyRows(sheet!, report);
    expect(r).toMatchObject({ custCodeKey: 'ZZD0001', branchCodeKey: 'ZZD0001-01', notes: [] });
    expect(r!.parsed).toMatchObject({ route: 'ZR10', paymentTerms: 'CASH', creditLimit: 1500, paymentTermDays: 30, status: 'A', createdDate: { day: '2026-01-15' } });
  });
});

describe('what the Steward is told after an upload', () => {
  const ok = { loadDay: '2026-11-14', rows: 3, rowsWithNotes: 0, notRead: [], otherSheets: [], sameBytesAs: null, waitsFor: null };

  it('staged, and that nothing is applied', () => {
    expect(uploadMessage(ok)).toEqual({ tone: 'ok', lines: ['Staged 3 rows for 2026-11-14. Nothing is applied to customers yet.'] });
  });

  it('notes, the same bytes as an earlier day, a file it waits for, sheets and headings not read', () => {
    const m = uploadMessage({
      ...ok,
      rowsWithNotes: 1,
      notRead: ['Notes'],
      otherSheets: ['Help'],
      sameBytesAs: { loadDay: '2026-11-13', filename: 'a.xlsx' },
      waitsFor: { loadDay: '2026-11-12', filename: 'b.xlsx' },
    });
    expect(m.tone).toBe('warn');
    expect(m.lines.slice(1)).toEqual([
      '1 row has a note (counted in the list below).',
      'This file is exactly the same as the one uploaded for 2026-11-13 ("a.xlsx").',
      'It waits for the file of 2026-11-12 ("b.xlsx"), which must be applied or discarded first.',
      'Only the first sheet was read. Not read: Help.',
      'Not read: 1 column is not one of the agreed columns and was ignored: Notes.',
    ]);
  });
});
