// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditProcess, EditState, PrismaClient } from '@prisma/client';
import { signalHash } from '@/lib/duplicate-pairing';
import { main } from '../../scripts/ops/recompute-cr-norm';

vi.mock('@prisma/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisma/client')>();
  return { ...actual, PrismaClient: vi.fn() };
});

const OLD_CR = String.fromCharCode(0x661, 0x662, 0x663, 0x664, 0x665, 0x666, 0x667);
const NEW_CR = '1234567';
const STAMP = new Date('2026-09-01T00:00:00Z');
const ACTOR = { id: 'test-steward', username: 'review.steward', role: 'STEWARD', isActive: true };
// A deliberately sensitive-looking synthetic error: the failed-check report must
// not echo arbitrary database errors, which can contain connection or row values.
const READ_ERROR = 'synthetic-private-connection-detail';

type Customer = {
  id: string;
  crNumber: string | null;
  crNumberNorm: string | null;
  deletedAt: Date | null;
  updatedAt: Date;
  legalName: string;
  primaryPhoneNorm: string | null;
  branches: Array<{ regionId: string }>;
};
type Draft = {
  id: string;
  crNumber: string | null;
  crNumberNorm: string | null;
  edit: { state: EditState; process: EditProcess };
};
type AuditRow = {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  reason: string;
  after: Record<string, unknown>;
};
type Write = {
  where: { id: string; crNumber: string | null; crNumberNorm: string | null; updatedAt?: Date };
  data: { crNumberNorm: string | null; updatedAt?: Date };
};
type FailureStage = 'customers' | 'drafts' | 'pairs';

function fakeDb(options: {
  failCheck?: FailureStage;
  failWrite?: 'customers' | 'drafts';
  failCompleted?: boolean;
  skip?: boolean;
  alreadyCorrect?: boolean;
} = {}) {
  const customers: Customer[] = ['customer-alpha', 'customer-beta'].map((id) => ({
    id,
    crNumber: OLD_CR,
    crNumberNorm: options.alreadyCorrect ? NEW_CR : OLD_CR,
    deletedAt: null,
    updatedAt: STAMP,
    legalName: `Synthetic private name ${id}`,
    primaryPhoneNorm: null,
    branches: [{ regionId: 'test-region' }],
  }));
  const drafts: Draft[] = ['draft-alpha', 'draft-beta'].map((id) => ({
    id,
    crNumber: OLD_CR,
    crNumberNorm: options.alreadyCorrect ? NEW_CR : OLD_CR,
    edit: { state: EditState.DRAFT, process: EditProcess.CREATE },
  }));
  const pairLog = [{
    entityId: 'customer-alpha|customer-beta',
    after: { signals: [`cr:${signalHash(options.alreadyCorrect ? NEW_CR : OLD_CR)}`] },
    at: STAMP,
  }];
  const ledger: AuditRow[] = [];
  const events: string[] = [];
  const reads = { customers: 0, drafts: 0, pairs: 0 };
  function read(stage: FailureStage) {
    reads[stage] += 1;
    events.push(`read:${stage}:${reads[stage]}`);
    // Initial survey, fresh dismissal history, then the verification read.
    if (reads[stage] === 3 && options.failCheck === stage) throw new Error(READ_ERROR);
  }
  function update(rows: Array<Customer | Draft>, stage: 'customers' | 'drafts', write: Write) {
    events.push(`write:${stage}:${write.where.id}`);
    if (options.failWrite === stage) throw new Error(`synthetic ${stage} write failed`);
    if (options.skip && write.where.id.endsWith('beta')) return { count: 0 };
    const row = rows.find((r) => r.id === write.where.id);
    if (!row || row.crNumber !== write.where.crNumber || row.crNumberNorm !== write.where.crNumberNorm) {
      return { count: 0 };
    }
    if ('updatedAt' in row && row.updatedAt.getTime() !== write.where.updatedAt?.getTime()) {
      return { count: 0 };
    }
    Object.assign(row, write.data);
    return { count: 1 };
  }
  const raw = {
    $queryRawUnsafe: vi.fn(async () => [{ '?column?': 1 }]),
    $disconnect: vi.fn(async () => {}),
    user: { findUnique: vi.fn(async () => ACTOR) },
    customer: {
      findMany: vi.fn(async () => {
        read('customers');
        return structuredClone(customers);
      }),
      updateMany: vi.fn(async (write: Write) => update(customers, 'customers', write)),
    },
    editCustomerDraft: {
      findMany: vi.fn(async () => {
        read('drafts');
        return structuredClone(drafts);
      }),
      updateMany: vi.fn(async (write: Write) => update(drafts, 'drafts', write)),
    },
    auditLog: {
      findMany: vi.fn(async () => {
        read('pairs');
        return structuredClone(pairLog);
      }),
      create: vi.fn(async ({ data }: { data: AuditRow }) => {
        const phase = data.entityType === 'CustomerPair' ? 'carried' : data.after.phase;
        events.push(`ledger:${phase}`);
        if (phase === 'completed' && options.failCompleted) {
          throw new Error('synthetic completion insert failed');
        }
        ledger.push(structuredClone(data));
        return data;
      }),
    },
  };
  const prisma = raw as unknown as PrismaClient;
  vi.mocked(PrismaClient).mockImplementation(function () { return prisma; });
  return { customers, drafts, ledger, events, reads, raw };
}

function completed(db: ReturnType<typeof fakeDb>) {
  return db.ledger.find((r) => r.entityType === 'CrNormRecompute' && r.after.phase === 'completed');
}

function output() {
  return vi.mocked(console.log).mock.calls.map((args) => args.join(' ')).join('\n');
}

let savedArgv: string[];
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('DIRECT_URL', 'postgresql://test@localhost:5432/cr_norm_test');
  vi.stubEnv('DATABASE_URL', 'postgresql://test@localhost:5432/cr_norm_test');
  savedArgv = process.argv;
  process.argv = ['node', 'test-harness', '--expect-host', 'localhost', '--apply', '--actor', ACTOR.username];
});
afterEach(() => {
  process.argv = savedArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('CR recompute run: completion ledger precedes verification', () => {
  it('writes both tables and carried dismissal, completes, then verifies; a second run is a no-op', async () => {
    const db = fakeDb();
    expect(await main()).toBe(0);
    expect(completed(db)?.after).toEqual({
      phase: 'completed', customersWritten: 2, customersSkipped: 0,
      draftsWritten: 2, draftsSkipped: 0, dismissalsCarried: 1,
    });
    const phases = db.ledger.filter((r) => r.entityType === 'CrNormRecompute');
    expect(phases.map((r) => r.after.phase)).toEqual(['started', 'completed']);
    expect(phases[0].entityId).toBe(phases[1].entityId);
    expect(phases.every((r) => r.actorId === ACTOR.id)).toBe(true);
    expect(db.events.indexOf('ledger:carried')).toBeLessThan(db.events.indexOf('write:customers:customer-alpha'));
    expect(db.events.indexOf('write:drafts:draft-beta')).toBeLessThan(db.events.indexOf('ledger:completed'));
    expect(db.events.indexOf('ledger:completed')).toBeLessThan(db.events.indexOf('read:customers:3'));
    expect([...db.customers, ...db.drafts].every((r) => r.crNumberNorm === NEW_CR)).toBe(true);
    expect(db.customers.every((r) => r.updatedAt.getTime() === STAMP.getTime())).toBe(true);
    expect(output()).toContain('Checked: 0 stored norm(s) still differ');
    const recorded = JSON.stringify(phases) + output();
    for (const value of [OLD_CR, NEW_CR, ...db.customers.map((r) => r.legalName)]) {
      expect(recorded).not.toContain(value);
    }
    const count = db.ledger.length;
    expect(await main()).toBe(0);
    expect(db.ledger).toHaveLength(count);
    expect(output()).toContain('Nothing to do');
    expect(db.raw.$disconnect).toHaveBeenCalledTimes(2);
  });

  it.each<FailureStage>(['customers', 'drafts', 'pairs'])('a failed %s verification read preserves COMPLETED and counts, exits 2, and does not leak the error', async (stage) => {
    const db = fakeDb({ failCheck: stage });
    expect(await main()).toBe(2);
    expect(completed(db)?.after).toEqual({
      phase: 'completed', customersWritten: 2, customersSkipped: 0,
      draftsWritten: 2, draftsSkipped: 0, dismissalsCarried: 1,
    });
    expect(db.events.indexOf('ledger:completed')).toBeLessThan(db.events.indexOf('read:customers:3'));
    expect([...db.customers, ...db.drafts].every((r) => r.crNumberNorm === NEW_CR)).toBe(true);
    expect(output()).toMatch(/not checked/i);
    expect(output()).toMatch(/dry run/i);
    expect(output()).toContain('COMPLETED');
    expect(output()).toContain('customers       2 written, 0 skipped');
    expect(output()).toContain('drafts          2 written, 0 skipped');
    expect(output()).not.toContain(READ_ERROR);
    // This retry cannot repair a missing completion row: it finds no work.
    // The original run therefore has to have persisted its own completion.
    const count = db.ledger.length;
    expect(await main()).toBe(0);
    expect(db.ledger).toHaveLength(count);
    expect(output()).toContain('Nothing to do');
    expect(db.raw.$disconnect).toHaveBeenCalledTimes(2);
  });

  it('records actual guarded skips and carried dismissals, and exits 1 when norms remain stale', async () => {
    const db = fakeDb({ skip: true });
    expect(await main()).toBe(1);
    expect(completed(db)?.after).toEqual({
      phase: 'completed', customersWritten: 1, customersSkipped: 1,
      draftsWritten: 1, draftsSkipped: 1, dismissalsCarried: 1,
    });
    expect(db.customers[1].crNumberNorm).toBe(OLD_CR);
    expect(db.drafts[1].crNumberNorm).toBe(OLD_CR);
    expect(db.ledger.find((r) => r.entityType === 'CustomerPair')?.after).toEqual({
      signals: [`cr:${signalHash(OLD_CR)}`, `cr:${signalHash(NEW_CR)}`], carried: true,
    });
    expect(output()).toContain('Checked: 2 stored norm(s) still differ');
  });

  it.each(['customers', 'drafts'] as const)('a failed %s write propagates without COMPLETED or verification', async (stage) => {
    const db = fakeDb({ failWrite: stage });
    await expect(main()).rejects.toThrow(`synthetic ${stage} write failed`);
    expect(completed(db)).toBeUndefined();
    expect(db.reads.customers).toBe(2);
    expect(db.ledger.some((r) => r.after.phase === 'started')).toBe(true);
    expect(output()).not.toMatch(/not checked/i);
    expect(db.raw.$disconnect).toHaveBeenCalledOnce();
  });

  it('a failed COMPLETED insert propagates before verification and never claims completion', async () => {
    const db = fakeDb({ failCompleted: true });
    await expect(main()).rejects.toThrow('synthetic completion insert failed');
    expect(completed(db)).toBeUndefined();
    expect(db.reads.customers).toBe(2);
    expect([...db.customers, ...db.drafts].every((r) => r.crNumberNorm === NEW_CR)).toBe(true);
    expect(output()).not.toContain('COMPLETED');
    expect(output()).not.toMatch(/not checked/i);
    expect(db.raw.$disconnect).toHaveBeenCalledOnce();
  });

  it('a dry run resolves its actor but writes neither norms nor ledger rows', async () => {
    const db = fakeDb();
    process.argv = process.argv.filter((arg) => arg !== '--apply');
    expect(await main()).toBe(0);
    expect(db.raw.user.findUnique).toHaveBeenCalledOnce();
    expect(db.raw.customer.updateMany).not.toHaveBeenCalled();
    expect(db.raw.editCustomerDraft.updateMany).not.toHaveBeenCalled();
    expect(db.raw.auditLog.create).not.toHaveBeenCalled();
    expect(db.raw.$disconnect).toHaveBeenCalledOnce();
    expect(output()).toContain('DRY RUN');
  });

  it('an already-correct database reports no work and creates no ledger rows', async () => {
    const db = fakeDb({ alreadyCorrect: true });
    expect(await main()).toBe(0);
    expect(db.raw.customer.updateMany).not.toHaveBeenCalled();
    expect(db.raw.editCustomerDraft.updateMany).not.toHaveBeenCalled();
    expect(db.raw.auditLog.create).not.toHaveBeenCalled();
    expect(db.reads).toEqual({ customers: 1, drafts: 1, pairs: 1 });
    expect(output()).toContain('Nothing to do');
    expect(db.raw.$disconnect).toHaveBeenCalledOnce();
  });

  it('refuses a missing host marker before creating any database client', async () => {
    const db = fakeDb();
    process.argv = ['node', 'test-harness', '--apply', '--actor', ACTOR.username];
    await expect(main()).rejects.toThrow('refusing to run without --expect-host');
    expect(PrismaClient).not.toHaveBeenCalled();
    expect(db.raw.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(db.raw.auditLog.create).not.toHaveBeenCalled();
  });
});
