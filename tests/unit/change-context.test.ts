import { describe, expect, it, vi } from 'vitest';
import {
  SOURCE_MAX,
  SOURCE_RE,
  changeContextParams,
  changeContextStatement,
  omanDayEnd,
  omanDayStart,
  setChangeContext,
  src,
  withChangeContext,
} from '@/lib/change-context';

/**
 * Gap 24 (data audit 2026-10-10): every write names who made it and why, through
 * three transaction-local settings the history triggers read (lib/change-context.ts).
 */

const SET_SQL =
  "SELECT set_config('nmwc.actor', ?, true), set_config('nmwc.source', ?, true), set_config('nmwc.effective_from', ?, true)";

function fakeTx() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return 1;
    }),
  };
  return { tx, calls };
}

describe('source builders', () => {
  const id = 'clx9a8b7c6d5e4f3g2h1i0jkl';
  it('build the documented shapes, every one matching SOURCE_RE', () => {
    const built: Array<[string, string]> = [
      [src.edit(id), `edit:${id}`],
      [src.import('b1', 14, 'full'), 'import:b1:14:full'],
      [src.import('b1', 14, 'refresh'), 'import:b1:14:refresh'],
      [src.import('b1', 14), 'import:b1:14'],
      [src.importSetup('b1'), 'import:b1:setup'],
      [src.importSummary('b1'), 'import:b1:summary'],
      [src.importAccount('b1', 'Users', 14), 'import:b1:Users!14'],
      [src.importFix('b1', id), `import-fix:b1:${id}`],
      [src.merge('w', 'l'), 'merge:w:l'],
      [src.archive(id), `archive:${id}`],
      [src.photo(id), `photo:${id}`],
      [src.print(id), `print:${id}`],
      [src.users('create', 'salesman.c12'), 'users:create:salesman.c12'],
      [src.routes('toggle-route', id), `routes:toggle-route:${id}`],
      [src.temix('generate', 'b2'), 'temix:generate:b2'],
      [src.auth('logout'), 'auth:logout'],
      [src.password('change'), 'password:change'],
      [src.cron('sla-escalate'), 'cron:sla-escalate'],
      [src.script('zero-credit-limits', 'run1'), 'script:zero-credit-limits:run1'],
      [
        src.migration('20261013100100_history_foundation'),
        'migration:20261013100100_history_foundation',
      ],
      [src.seed('seed'), 'seed:seed'],
      [src.e2e('r42'), 'e2e:r42'],
      [src.test('history-capture'), 'test:history-capture'],
      [src.verify('app-role'), 'verify:app-role'],
      [src.temixDaily('f1', 7), 'temix-daily:f1:7'],
    ];
    for (const [got, want] of built) {
      expect(got).toBe(want);
      expect(SOURCE_RE.test(got), got).toBe(true);
    }
  });

  it('turn characters a source may not hold into "-" and cut each part to 80', () => {
    // An ISO instant is a run id several scripts use: its colons are separators.
    expect(src.script('requeue-untracked', '2026-10-13T08:00:00.000Z')).toBe(
      'script:requeue-untracked:2026-10-13T08-00-00.000Z'
    );
    expect(src.users('create', 'a b"c')).toBe('users:create:a-b-c');
    expect(src.edit('x'.repeat(200))).toBe(`edit:${'x'.repeat(80)}`);
    expect(src.edit('')).toBe('edit:-');
    for (const s of [
      src.script('n', '2026-10-13T08:00:00Z'),
      src.users('x', 'a b'),
      src.edit(''),
    ]) {
      expect(SOURCE_RE.test(s), s).toBe(true);
    }
  });

  it('SOURCE_RE refuses text, upper-case kinds, empty parts and more than four parts', () => {
    for (const bad of [
      '',
      'sql x',
      'Edit:1',
      'e',
      'edit:',
      'edit::1',
      'a:1:2:3:4:5',
      "edit:1'",
      'edit:1 2',
    ]) {
      expect(SOURCE_RE.test(bad), bad).toBe(false);
    }
  });
});

describe('changeContextParams', () => {
  const now = new Date('2026-10-13T08:00:00.000Z');

  it('passes the actor and source, and an empty effective time when none is given', () => {
    expect(changeContextParams({ actorId: 'u1', source: 'edit:e1' }, now)).toEqual({
      actor: 'u1',
      source: 'edit:e1',
      effective: '',
    });
    expect(
      changeContextParams({ actorId: null, source: 'cron:photo-gc', effectiveFrom: null }, now)
        .actor
    ).toBe('');
  });

  it('refuses a malformed or over-long source before any transaction opens', () => {
    expect(() => changeContextParams({ actorId: 'u', source: 'not a source' }, now)).toThrow(
      /malformed source/
    );
    expect(() =>
      changeContextParams({ actorId: 'u', source: `edit:${'x'.repeat(SOURCE_MAX)}` }, now)
    ).toThrow();
  });

  it('takes a calendar day as the start of that Oman day, and refuses one in the future', () => {
    expect(
      changeContextParams(
        { actorId: null, source: 'temix-daily:f:1', effectiveFrom: '2026-10-13' },
        now
      ).effective
    ).toBe('2026-10-13');
    expect(() =>
      changeContextParams(
        { actorId: null, source: 'temix-daily:f:1', effectiveFrom: '2026-10-14' },
        now
      )
    ).toThrow(/future/);
    expect(() =>
      changeContextParams(
        { actorId: null, source: 'temix-daily:f:1', effectiveFrom: '2026-02-30' },
        now
      )
    ).toThrow(/invalid effective day/);
  });

  it('takes an instant with its offset, allows five minutes of clock skew, and refuses anything zone-less', () => {
    const ok = changeContextParams(
      { actorId: null, source: 'script:x:1', effectiveFrom: new Date('2026-10-13T08:04:00.000Z') },
      now
    );
    expect(ok.effective).toBe('2026-10-13T08:04:00.000Z');
    expect(
      changeContextParams(
        { actorId: null, source: 'script:x:1', effectiveFrom: '2026-10-01T09:00:00+04:00' },
        now
      ).effective
    ).toBe('2026-10-01T09:00:00+04:00');
    expect(() =>
      changeContextParams(
        {
          actorId: null,
          source: 'script:x:1',
          effectiveFrom: new Date('2026-10-13T08:06:00.000Z'),
        },
        now
      )
    ).toThrow(/future/);
    expect(() =>
      changeContextParams(
        { actorId: null, source: 'script:x:1', effectiveFrom: '2026-10-01 09:00' },
        now
      )
    ).toThrow(/offset/);
    expect(() =>
      changeContextParams(
        { actorId: null, source: 'script:x:1', effectiveFrom: new Date('nope') },
        now
      )
    ).toThrow(/invalid/);
  });
});

describe('setChangeContext', () => {
  it('is ONE statement: three transaction-local set_config calls, values bound, never interpolated', async () => {
    const { tx, calls } = fakeTx();
    await setChangeContext(tx as never, { actorId: 'u1', source: 'edit:e1' });
    expect(calls).toEqual([{ sql: SET_SQL, values: ['u1', 'edit:e1', ''] }]);
  });

  it('refuses a malformed context without touching the database', async () => {
    const { tx } = fakeTx();
    await expect(
      setChangeContext(tx as never, { actorId: 'u1', source: "edit:1'; DROP" })
    ).rejects.toThrow(/malformed source/);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('changeContextStatement is the same statement, for an array transaction', () => {
    const { tx, calls } = fakeTx();
    void changeContextStatement(tx as never, {
      actorId: null,
      source: 'script:zero-credit-limits:r1',
    });
    expect(calls).toEqual([{ sql: SET_SQL, values: ['', 'script:zero-credit-limits:r1', ''] }]);
  });
});

describe('withChangeContext', () => {
  it('names the cause first, then runs the body on the same transaction client, with the options passed through', async () => {
    const order: string[] = [];
    const { tx } = fakeTx();
    tx.$executeRaw.mockImplementation(async () => {
      order.push('context');
      return 1;
    });
    const client = {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>, opts?: unknown) => {
        order.push(`begin ${JSON.stringify(opts)}`);
        return fn(tx);
      }),
    };
    const out = await withChangeContext(
      client as never,
      { actorId: 'u1', source: 'edit:e1' },
      async (t) => {
        order.push(t === (tx as unknown) ? 'body on tx' : 'body on another client');
        return 42;
      },
      { timeout: 30_000 }
    );
    expect(out).toBe(42);
    expect(order).toEqual(['begin {"timeout":30000}', 'context', 'body on tx']);
  });

  it('refuses a malformed context before opening a transaction', () => {
    const client = { $transaction: vi.fn() };
    expect(() =>
      withChangeContext(client as never, { actorId: 'u', source: 'bad source' }, async () => 1)
    ).toThrow();
    expect(client.$transaction).not.toHaveBeenCalled();
  });
});

describe('Oman day bounds (the as-of convention)', () => {
  it('a day starts at 20:00 UTC the evening before and ends 24 hours later', () => {
    expect(omanDayStart('2026-11-15')?.toISOString()).toBe('2026-11-14T20:00:00.000Z');
    expect(omanDayEnd('2026-11-15')?.toISOString()).toBe('2026-11-15T20:00:00.000Z');
    expect(omanDayStart('2026-13-01')).toBeNull();
    expect(omanDayEnd('15/11/2026')).toBeNull();
  });
});
