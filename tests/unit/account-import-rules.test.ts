// @vitest-environment node
/**
 * The account-master import's pure row rules (lib/account-import.ts). The service
 * around them is exercised in account-import-service.test.ts; this file pins each
 * rule on its own, including the wording the Steward acts on.
 */
import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_ROW_NOT_PROCESSED,
  accountCreateAudit,
  accountImportInterruptedMessage,
  accountRowFailure,
  accountUpdateAudit,
  errorLogFields,
  inactiveRouteIssue,
  reportableError,
  roleMismatchIssue,
  type AccountState,
} from '@/lib/account-import';

describe('roleMismatchIssue (F08)', () => {
  const base = { username: 'mct-01', wantsRoleChange: false } as const;

  it('lets a row through that names the stored role', () => {
    expect(
      roleMismatchIssue({ ...base, storedRole: 'SALESMAN', incomingRole: 'SALESMAN' })
    ).toBeNull();
  });

  it('lets a differing role through when change_role is yes (the admin-tier guard runs before it)', () => {
    expect(
      roleMismatchIssue({
        ...base,
        wantsRoleChange: true,
        storedRole: 'SALESMAN',
        incomingRole: 'VIEWER',
      })
    ).toBeNull();
  });

  it('holds back a differing role without change_role, and says nothing was written', () => {
    const msg = roleMismatchIssue({ ...base, storedRole: 'SALESMAN', incomingRole: 'VIEWER' });
    expect(msg).toMatch(/"mct-01" is SALESMAN in the CRM but VIEWER in this row/);
    expect(msg).toMatch(/Nothing was written/);
    expect(msg).toMatch(/change_role/);
  });

  it.each([
    ['MANAGER', 'SALESMAN'],
    ['STEWARD', 'VIEWER'],
    ['VIEWER', 'MANAGER'],
  ] as const)(
    'sends a %s/%s mismatch to the Users UI, not to change_role',
    (storedRole, incomingRole) => {
      const msg = roleMismatchIssue({ ...base, storedRole, incomingRole });
      expect(msg).toMatch(/only in the Users UI/);
      expect(msg).not.toMatch(/set change_role/);
    }
  );
});

describe('inactiveRouteIssue (X-IMPORTS-2)', () => {
  const base = { username: 'mct-01', routeCode: 'MCT-01' };

  it('lets an active account take a route', () => {
    expect(
      inactiveRouteIssue({ ...base, isActive: true, currentRouteId: null, incomingRouteId: 'r1' })
    ).toBeNull();
  });

  it('lets a deactivated account through when the row hands it no route', () => {
    expect(
      inactiveRouteIssue({ ...base, isActive: false, currentRouteId: 'r1', incomingRouteId: null })
    ).toBeNull();
  });

  it('lets a deactivated account keep the route it already owns: nothing changes hands', () => {
    expect(
      inactiveRouteIssue({ ...base, isActive: false, currentRouteId: 'r1', incomingRouteId: 'r1' })
    ).toBeNull();
  });

  it('refuses to hand a deactivated account a route it does not own', () => {
    const msg = inactiveRouteIssue({
      ...base,
      isActive: false,
      currentRouteId: null,
      incomingRouteId: 'r1',
    });
    expect(msg).toMatch(/"mct-01" is deactivated, so route MCT-01 is not handed to it/);
    expect(msg).toMatch(/Nothing was written/);
  });
});

const state = (over: Partial<AccountState> = {}): AccountState => ({
  fullName: 'Ali',
  role: 'SALESMAN',
  supervisor: 'sup.a',
  route: 'MCT-01',
  regions: [],
  mustChangePassword: false,
  email: 'ali@example.invalid',
  phone: '+96890000000',
  ...over,
});

describe('account audit rows (X-IMPORTS-1)', () => {
  it('a CREATE row carries the account, the batch, and names contact fields without copying them', () => {
    const after = accountCreateAudit('mct-01', state({ phone: null }), 'batch-1');
    expect(after).toEqual({
      username: 'mct-01',
      role: 'SALESMAN',
      batchId: 'batch-1',
      supervisor: 'sup.a',
      route: 'MCT-01',
      regions: [],
      mustChangePassword: false,
      contactGiven: ['email'],
    });
    expect(Object.keys(after)).not.toContain('password');
    expect(Object.keys(after)).not.toContain('passwordHash');
    expect(JSON.stringify(after)).not.toContain('ali@example.invalid');
    // A person's name is personal data in an append-only ledger, and decides nothing.
    expect(Object.keys(after)).not.toContain('fullName');
    expect(JSON.stringify(after)).not.toContain('"Ali"');
  });

  it('an unchanged account writes no UPDATE row', () => {
    expect(accountUpdateAudit('mct-01', state(), state(), 'batch-1')).toBeNull();
  });

  it('an UPDATE row carries only what changed, before and after', () => {
    const change = accountUpdateAudit(
      'mct-01',
      state(),
      state({ route: 'MCT-02', supervisor: 'sup.b' }),
      'batch-1'
    );
    expect(change).toEqual({
      before: { supervisor: 'sup.a', route: 'MCT-01' },
      after: { username: 'mct-01', supervisor: 'sup.b', route: 'MCT-02', batchId: 'batch-1' },
    });
  });

  it('a renamed account is named as changed, and neither name is copied', () => {
    const change = accountUpdateAudit('mct-01', state(), state({ fullName: 'Ali K' }), 'b');
    expect(change).toEqual({
      before: {},
      after: { username: 'mct-01', changed: ['fullName'], batchId: 'b' },
    });
    expect(JSON.stringify(change)).not.toMatch(/"Ali( K)?"/);
  });

  it('a changed region set is compared as a set of codes', () => {
    const change = accountUpdateAudit(
      'acct.mct',
      state({ role: 'ACCOUNTANT', route: null, regions: ['MCT'] }),
      state({ role: 'ACCOUNTANT', route: null, regions: ['BAT', 'MCT'] }),
      'b'
    );
    expect(change).toEqual({
      before: { regions: ['MCT'] },
      after: { username: 'acct.mct', regions: ['BAT', 'MCT'], batchId: 'b' },
    });
  });

  it('a role change is left to its own row (role_change_via_import), not repeated here', () => {
    expect(accountUpdateAudit('u', state(), state({ role: 'VIEWER' }), 'b')).toBeNull();
  });

  it('a changed e-mail or phone is named, never copied into the append-only ledger', () => {
    const change = accountUpdateAudit(
      'mct-01',
      state(),
      state({ email: 'new@example.invalid', phone: '+96891111111' }),
      'b'
    );
    expect(change).toEqual({
      before: {},
      after: { username: 'mct-01', changed: ['email', 'phone'], batchId: 'b' },
    });
    const text = JSON.stringify(change);
    expect(text).not.toContain('example.invalid');
    expect(text).not.toContain('9689');
  });
});

describe('accountRowFailure (F07 / X-IMPORTS-3)', () => {
  const prismaErr = (code: string, message: string, meta?: unknown) =>
    Object.assign(new Error(message), { code, meta });

  it('a database that did not answer: nothing was written, import the row again', () => {
    const f = accountRowFailure(
      prismaErr('P2024', 'Timed out fetching a new connection'),
      '"mct-01"'
    );
    expect(f).toEqual({
      transient: true,
      mayHaveCommitted: false,
      message:
        'the database did not answer (P2024), so nothing was written for "mct-01". Import this row again.',
    });
  });

  it('a connection that died where the commit may have landed does not claim nothing was written', () => {
    const f = accountRowFailure(
      prismaErr('P1017', 'Server has closed the connection.'),
      '"mct-01"'
    );
    expect(f.transient).toBe(true);
    expect(f.mayHaveCommitted).toBe(true);
    expect(f.message).toMatch(/may or may not have been written/);
    expect(f.message).not.toMatch(/nothing was written/i);
  });

  it('a unique clash names the field, never the value in the raw message', () => {
    const f = accountRowFailure(
      prismaErr(
        'P2002',
        'Unique constraint failed on the fields: (`email`) value ali@example.invalid',
        {
          target: ['email'],
        }
      ),
      '"mct-01"'
    );
    expect(f).toEqual({
      transient: false,
      mayHaveCommitted: false,
      message: 'nothing was written for "mct-01": its email is already used by another record.',
    });
  });

  it('a CHECK violation names the constraint, which is a schema identifier', () => {
    const f = accountRowFailure(
      new Error('new row for relation "User" violates check constraint "User_fullName_len" 0000'),
      'region "MCT"'
    );
    expect(f.message).toBe(
      'nothing was written for region "MCT": the database refused it (User_fullName_len).'
    );
  });

  it('anything else gives its code or error name, not its message', () => {
    const f = accountRowFailure(new TypeError('secret detail 96890000000'), '"x"');
    expect(f.message).toBe('nothing was written for "x": it could not be saved (TypeError).');
    expect(f.transient).toBe(false);
  });
});

describe('errorLogFields / reportableError: what a failed row leaves in the log and in Sentry', () => {
  it('keeps the name and the message, with phone numbers and e-mail addresses scrubbed', () => {
    const fields = errorLogFields(
      new TypeError("Cannot read properties of undefined (reading 'id') ali@example.invalid 96890000000")
    );
    expect(fields).toEqual({
      errName: 'TypeError',
      // The phone pattern takes the separator before the number with it.
      err: "Cannot read properties of undefined (reading 'id') [email][phone]",
    });
  });

  it('a Prisma validation error keeps its first and last lines, never the arguments printed between them', () => {
    const err = Object.assign(
      new Error(
        [
          '',
          'Invalid `prisma.user.upsert()` invocation:',
          '',
          '{',
          '  where: { username: "mct-01" },',
          '  create: { passwordHash: "$2a$12$abcdefghijklmnopqrstuv", fullName: "Ali Al Balushi" }',
          '}',
          '',
          'Unknown argument `colour`. Available options are marked with ?.',
        ].join('\n')
      ),
      { name: 'PrismaClientValidationError' }
    );
    const fields = errorLogFields(err);
    expect(fields).toEqual({
      errName: 'PrismaClientValidationError',
      err: 'Invalid `prisma.user.upsert()` invocation: … Unknown argument `colour`. Available options are marked with ?.',
    });
    expect(JSON.stringify(fields)).not.toMatch(/\$2a\$|passwordHash|Balushi|mct-01/);
  });

  it('cuts a Postgres detail that quotes the failing row or key', () => {
    const check = errorLogFields(
      new Error(
        'Error occurred during query execution: ConnectorError(PostgresError { code: "23514", message: "new row for relation \\"User\\" violates check constraint \\"User_x\\"", severity: "ERROR", detail: Some("Failing row contains (u1, mct-01, $2a$12$hash, Ali).") })'
      )
    );
    expect(check.err).toMatch(/violates check constraint .*User_x.*\[detail cut\]$/);
    expect(check.err).not.toMatch(/Failing row|\$2a\$|Ali\)/);
    const key = errorLogFields(new Error('duplicate key value violates unique constraint "User_email_key" Key (email)=(someone) already exists.'));
    expect(key.err).toBe('duplicate key value violates unique constraint "User_email_key" [detail cut]');
  });

  it('scrubs before it shortens, so a number cut at the limit is not left half-visible', () => {
    // Cut first, the limit would leave " 96890" — too short for the pattern.
    const fields = errorLogFields(new Error(`${'x'.repeat(294)} 96890000000`));
    expect(fields.err).toHaveLength(300);
    expect(fields.err).not.toMatch(/9689/);
  });

  it('a thrown non-Error is named by its type', () => {
    expect(errorLogFields('boom')).toEqual({ errName: 'string', err: 'boom' });
  });

  it('the error Sentry is sent carries the name, the cut-down message and the original frames', () => {
    const original = Object.assign(new Error('line one\n  create: { passwordHash: "$2a$12$zzz" }\nwhy it failed'), {
      name: 'PrismaClientValidationError',
    });
    const sent = reportableError(original);
    expect(sent.name).toBe('PrismaClientValidationError');
    expect(sent.message).toBe('line one … why it failed');
    expect(sent.stack!.split('\n')[0]).toBe('PrismaClientValidationError: line one … why it failed');
    const frames = original.stack!.split('\n').filter((l) => /^ {4}at /.test(l));
    expect(frames.length).toBeGreaterThan(0);
    expect(sent.stack!.split('\n').slice(1)).toEqual(frames);
    expect(sent.stack).not.toMatch(/passwordHash|\$2a\$/);
  });
});

describe('accountImportInterruptedMessage (X-IMPORTS-3)', () => {
  it('when the batch was recorded, points at its page and never says nothing was saved', () => {
    const msg = accountImportInterruptedMessage({
      applied: 12,
      uncertain: 0,
      notApplied: 30,
      recorded: true,
    });
    expect(msg).toMatch(/12 row\(s\) were applied and are saved/);
    expect(msg).toMatch(/30 row\(s\) that were not applied are listed on this upload's batch page/);
    expect(msg).not.toMatch(/nothing was saved/i);
    expect(msg).toMatch(/reset_password/);
  });

  it('when the batch could not be recorded, says the rows are listed nowhere', () => {
    const msg = accountImportInterruptedMessage({
      applied: 5,
      uncertain: 1,
      notApplied: 2,
      recorded: false,
    });
    expect(msg).toMatch(/5 row\(s\) were applied and are saved; 1 may or may not have been/);
    expect(msg).toMatch(/2 row\(s\) that were not applied are not listed anywhere/);
    expect(msg).toMatch(/the database stopped answering before this upload's report could be saved/);
    expect(msg).not.toMatch(/nothing was saved/i);
  });

  it('a report the database refused, or a bug, is not put down to the database going away', () => {
    const msg = accountImportInterruptedMessage({
      applied: 5,
      uncertain: 0,
      notApplied: 2,
      recorded: false,
      reportFault: 'P2000',
    });
    expect(msg).toMatch(/^5 row\(s\) were applied and are saved, but this upload's report could not be saved \(P2000\)/);
    expect(msg).toMatch(/2 row\(s\) that were not applied are not listed anywhere/);
    expect(msg).toMatch(/has been reported/);
    expect(msg).toMatch(/reset_password/);
    expect(msg).not.toMatch(/stopped answering|once the CRM responds/);
  });

  it('a row the import never reached says so', () => {
    expect(ACCOUNT_ROW_NOT_PROCESSED).toMatch(/^not processed: .*Nothing was written for this row/);
  });
});
