/**
 * The daily Temix import: the same-file and order rules (lib/temix-daily-order.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  applyBlockedBy,
  comesBefore,
  dateColumnDay,
  isFinished,
  overtakenBy,
  sameBytesEarlier,
  stagingRefusal,
  type DailyFileForOrder,
  type DailyFileState,
} from '@/lib/temix-daily-order';

const SHA = (c: string) => c.repeat(64);
let n = 0;
const file = (loadDay: string, state: DailyFileState, sha = SHA('a'), at = `${loadDay}T06:00:00Z`): DailyFileForOrder => ({
  id: `f${++n}`,
  filename: `daily-${n}.xlsx`,
  loadDay,
  uploadedAt: new Date(at),
  state,
  fileSha256: sha,
});

describe('the same file', () => {
  it('is refused for the same load day, unless the earlier upload was discarded', () => {
    const today = { loadDay: '2026-11-14', sha256: SHA('a') };
    expect(stagingRefusal(today, [file('2026-11-14', 'STAGED')])).toMatch(/already uploaded for 2026-11-14.*once per day/);
    expect(stagingRefusal(today, [file('2026-11-14', 'LOADED')])).toMatch(/once per day/);
    expect(stagingRefusal(today, [file('2026-11-14', 'DISCARDED')])).toBeNull();
    expect(stagingRefusal(today, [file('2026-11-14', 'STAGED', SHA('b'))])).toBeNull();
  });

  it('is staged on a later day, with a warning naming the latest earlier file', () => {
    const today = { loadDay: '2026-11-14', sha256: SHA('a') };
    const older = file('2026-11-10', 'LOADED');
    const newer = file('2026-11-12', 'LOADED');
    const gone = file('2026-11-13', 'DISCARDED');
    expect(stagingRefusal(today, [older, newer, gone])).toBeNull();
    expect(sameBytesEarlier(today, [older, newer, gone])?.id).toBe(newer.id);
    expect(sameBytesEarlier(today, [file('2026-11-12', 'LOADED', SHA('b'))])).toBeNull();
  });
});

describe('the order rule', () => {
  it('no file is staged behind a later day (it could only ever be discarded)', () => {
    expect(stagingRefusal({ loadDay: '2026-11-13', sha256: SHA('c') }, [file('2026-11-14', 'STAGED')])).toMatch(
      /later day, 2026-11-14.*could never be applied after it/
    );
    expect(stagingRefusal({ loadDay: '2026-11-13', sha256: SHA('c') }, [file('2026-11-14', 'DISCARDED')])).toBeNull();
  });

  it('files are taken by load day, then upload time', () => {
    const a = file('2026-11-13', 'STAGED', SHA('a'), '2026-11-13T20:00:00Z');
    const b = file('2026-11-14', 'STAGED', SHA('b'), '2026-11-14T01:00:00Z');
    const c = file('2026-11-14', 'STAGED', SHA('c'), '2026-11-14T02:00:00Z');
    expect(comesBefore(a, b) && comesBefore(b, c) && !comesBefore(c, a)).toBe(true);
  });

  it('a newer file waits while an older one is neither LOADED nor DISCARDED', () => {
    const states: DailyFileState[] = ['STAGED', 'CHECKED', 'APPLYING', 'FINALIZING', 'LOADED', 'DISCARDED'];
    for (const s of states) {
      const older = file('2026-11-13', s);
      const newer = file('2026-11-14', 'STAGED', SHA('b'));
      expect(applyBlockedBy(newer, [older])?.id ?? null, s).toBe(isFinished(s) ? null : older.id);
      // An older file is never held back by a newer one.
      expect(applyBlockedBy(older, [newer])).toBeNull();
    }
  });

  it('two files of one day: the later upload waits for the earlier', () => {
    const first = file('2026-11-14', 'CHECKED', SHA('a'), '2026-11-14T05:00:00Z');
    const second = file('2026-11-14', 'STAGED', SHA('b'), '2026-11-14T07:00:00Z');
    expect(applyBlockedBy(second, [first])?.id).toBe(first.id);
    expect(applyBlockedBy(first, [second])).toBeNull();
  });

  it('it names the earliest file to clear first', () => {
    const f1 = file('2026-11-11', 'STAGED');
    const f2 = file('2026-11-12', 'STAGED');
    expect(applyBlockedBy(file('2026-11-14', 'STAGED'), [f2, f1])?.id).toBe(f1.id);
  });

  it('an earlier day can never be applied once a later day is applied or applying', () => {
    const early = file('2026-11-12', 'STAGED');
    for (const s of ['APPLYING', 'FINALIZING', 'LOADED'] as const) {
      expect(overtakenBy(early, [file('2026-11-13', s)])?.loadDay, s).toBe('2026-11-13');
    }
    for (const s of ['STAGED', 'CHECKED', 'DISCARDED'] as const) {
      expect(overtakenBy(early, [file('2026-11-13', s)]), s).toBeNull();
    }
    expect(overtakenBy(early, [file('2026-11-12', 'LOADED')])).toBeNull();
  });
});

describe('the day of a DATE column', () => {
  it('is its UTC parts (Prisma returns midnight UTC), whatever the clock zone', () => {
    expect(dateColumnDay(new Date('2026-11-14T00:00:00Z'))).toBe('2026-11-14');
    expect(dateColumnDay(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05');
  });
});
