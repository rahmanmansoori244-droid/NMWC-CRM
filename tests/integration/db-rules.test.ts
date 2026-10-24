// @vitest-environment node
/**
 * Gap 31 on Postgres: the rules added NOT VALID (lib/db-rules.ts, migration
 * 20261025090000_db_rules_not_valid) refuse what they should and nothing else,
 * and the nightly check db-rules-older-rows counts the rows a VALIDATE would
 * refuse.
 *
 *   - every CHECK refuses a breaking insert and accepts a conforming one;
 *   - every foreign key refuses a dangling id; a sub-channel of another channel,
 *     and one with no channel, are refused;
 *   - SET NULL fires on delete (a user who created a customer, a customer a
 *     photo and a notification name), and a customer or shop a request names
 *     cannot be deleted (RESTRICT);
 *   - the check's counting, proven on TEMP-table shadows of the real tables
 *     (pg_temp comes first on the search path, so the check's unqualified SQL
 *     reads them and the real tables are never written or locked for writing):
 *     exactly one counted row per rule, every rule present in the catalog and
 *     not validated.
 *
 * Synthetic ZZ rows only, all inside ONE transaction that is rolled back at the
 * end; each refusal runs under a SAVEPOINT. Aborts on the production endpoint.
 *
 *   RUN_DB_RULES=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/db-rules.test.ts
 *
 * Written with the audit-gaps branch; NOT run there (no database was used).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { src, withChangeContext } from '@/lib/change-context';
import { CHECK_BY_ID } from '@/lib/integrity/checks';
import { DB_RULES, DB_RULE_NAMES, type DbRule } from '@/lib/db-rules';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_DB_RULES === '1' && !!process.env.DATABASE_URL;
const PROD = 'ep-sweet-haze';
const sfx = `zzdbr${Date.now().toString(36)}`;
const SFX = sfx.toUpperCase();

class Rollback extends Error {}

/** Run fn in one transaction and roll it back whatever happens. */
async function inRolledBack(db: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await withChangeContext(
      db,
      { actorId: null, source: src.test('db-rules') },
      async (tx) => {
        await fn(tx);
        throw new Rollback('rolled back on purpose');
      },
      { timeout: 110_000, maxWait: 10_000 }
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

let sp = 0;
/** The write must be refused, naming `name`; the transaction goes on. */
async function refused(tx: Prisma.TransactionClient, name: string, write: () => Promise<unknown>): Promise<void> {
  const p = `zz_sp_${++sp}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${p}`);
  let err: unknown = null;
  try {
    await write();
  } catch (e) {
    err = e;
  }
  await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${p}`);
  expect(err, `${name} accepted a row it should refuse`).not.toBeNull();
  expect(String((err as Error).message) + JSON.stringify((err as { meta?: unknown }).meta ?? {})).toContain(name);
}
/** The write must be accepted; it is undone so the next case starts clean. */
async function accepted(tx: Prisma.TransactionClient, write: () => Promise<unknown>): Promise<void> {
  const p = `zz_sp_${++sp}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${p}`);
  await write();
  await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${p}`);
}

describe.skipIf(!ENABLED)('gap 31: the NOT VALID database rules on Postgres', () => {
  let db: PrismaClient;

  beforeAll(() => {
    const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
    if (url.includes(PROD) || (process.env.DATABASE_URL ?? '').includes(PROD)) throw new Error('ABORT: production');
    db = new PrismaClient({ datasourceUrl: url });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  /** A region, a route, a user, a customer and a shop, inside the transaction. */
  async function world(tx: Prisma.TransactionClient) {
    const region = await tx.region.create({ data: { code: `G${SFX}`, name: `ZZ rules ${sfx}` } });
    const route = await tx.route.create({ data: { code: `R${SFX}`, name: `ZZ rules ${sfx}`, regionId: region.id } });
    const user = await tx.user.create({ data: { username: `u.${sfx}`, fullName: `ZZ rules ${sfx}`, role: 'SALESMAN', passwordHash: 'x' } });
    const customer = await tx.customer.create({ data: { nmwcCode: `C${SFX}`, legalName: `ZZ rules ${sfx}` } });
    const branch = await tx.branch.create({
      data: { customerId: customer.id, branchCode: `C${SFX}-01`, branchName: 'ZZ', regionId: region.id, routeId: route.id, address: 'ZZ rules probe address' },
    });
    const channels = await tx.channel.findMany({ include: { subChannels: { take: 1 } }, take: 5 });
    const ch = channels.filter((c) => c.subChannels.length > 0);
    if (ch.length < 2) throw new Error('two channels with a sub-channel each are needed (the seed has them)');
    const edit = await tx.customerEdit.create({
      data: { target: 'CUSTOMER', process: 'CREATE', submittedById: user.id, state: 'DRAFT', fieldChanges: [], attachmentChanges: [] },
    });
    return { region, route, user, customer, branch, ch, edit };
  }

  it('every CHECK refuses a breaking row and accepts a conforming one', async () => {
    await inRolledBack(db, async (tx) => {
      const w = await world(tx);
      const [a, b] = w.ch as [(typeof w.ch)[0], (typeof w.ch)[0]];
      const newCustomer = (n: string, data: Record<string, unknown>) => () =>
        tx.customer.create({ data: { nmwcCode: `C${SFX}-${n}`, legalName: 'ZZ', ...data } as Prisma.CustomerUncheckedCreateInput });
      const setBranch = (data: Prisma.BranchUncheckedUpdateInput) => () => tx.branch.update({ where: { id: w.branch.id }, data });
      const draft = (data: Record<string, unknown>) => () =>
        tx.editCustomerDraft.create({ data: { editId: w.edit.id, legalName: 'ZZ', paymentTerms: 'CASH', ...data } as Prisma.EditCustomerDraftUncheckedCreateInput });
      const branchDraft = (data: Record<string, unknown>) => () =>
        tx.editBranchDraft.create({
          data: { editId: w.edit.id, branchName: 'ZZ', regionId: w.region.id, routeId: w.route.id, address: 'ZZ draft address', ...data } as Prisma.EditBranchDraftUncheckedCreateInput,
        });

      // Customer
      await refused(tx, 'Customer_credit_terms_only_credit', newCustomer('1', { paymentTerms: 'CASH', creditLimit: 5 }));
      await refused(tx, 'Customer_credit_terms_only_credit', newCustomer('2', { paymentTerms: 'CASH', paymentTermDays: 30 }));
      await accepted(tx, newCustomer('3', { paymentTerms: 'CREDIT', creditLimit: 5, paymentTermDays: 30 }));
      await refused(tx, 'Customer_subChannel_needs_channel', newCustomer('4', { subChannelId: a.subChannels[0]!.id }));
      await accepted(tx, newCustomer('5', { channelId: a.id, subChannelId: a.subChannels[0]!.id }));
      await refused(tx, 'Customer_primaryPhoneNorm_shape', newCustomer('6', { primaryPhoneNorm: '91234567' }));
      await refused(tx, 'Customer_primaryPhoneNorm_shape', newCustomer('7', { primaryPhoneNorm: '' }));
      await accepted(tx, newCustomer('8', { primaryPhoneNorm: '+96891234567' }));
      await refused(tx, 'Customer_crNumberNorm_shape', newCustomer('9', { crNumberNorm: 'cr-123' }));
      await refused(tx, 'Customer_crNumberNorm_shape', newCustomer('10', { crNumberNorm: '12 34' }));
      await refused(tx, 'Customer_crNumberNorm_shape', newCustomer('11', { crNumberNorm: '' }));
      await refused(tx, 'Customer_crNumberNorm_shape', newCustomer('12', { crNumberNorm: `12${String.fromCharCode(0x200b)}3` }));
      await refused(tx, 'Customer_crNumberNorm_shape', newCustomer('13', { crNumberNorm: String.fromCharCode(0x0661, 0x0662) }));
      await accepted(tx, newCustomer('14', { crNumberNorm: 'CR-1234567/2024' }));
      // A NOT VALID CHECK is evaluated on updates too, not only on inserts.
      await refused(tx, 'Customer_credit_terms_only_credit', () =>
        tx.customer.update({ where: { id: w.customer.id }, data: { creditLimit: 1 } })
      );

      // Branch
      await refused(tx, 'Branch_gps_in_oman', setBranch({ gpsLat: 30, gpsLng: 58 }));
      await refused(tx, 'Branch_gps_in_oman', setBranch({ gpsLat: 23, gpsLng: 61.0001 }));
      await accepted(tx, setBranch({ gpsLat: 16, gpsLng: 61 }));
      await accepted(tx, setBranch({ gpsLat: 27, gpsLng: 51 }));
      await refused(tx, 'Branch_gps_pair', setBranch({ gpsLat: 23.6, gpsLng: null }));
      await refused(tx, 'Branch_gpsAccuracy_range', setBranch({ gpsAccuracy: 10000.5 }));
      await accepted(tx, setBranch({ gpsAccuracy: 10000 }));
      await refused(tx, 'Branch_equipment_counts_range', setBranch({ coolersCount: 101 }));
      await refused(tx, 'Branch_equipment_counts_range', setBranch({ emptyBottlesCount: 1001 }));
      await accepted(tx, setBranch({ coolersCount: 100, standsCount: 100, emptyBottlesCount: 1000 }));

      // EditCustomerDraft (no credit rule: a draft carries the requested terms on its request)
      await refused(tx, 'EditCustomerDraft_subChannel_needs_channel', draft({ subChannelId: a.subChannels[0]!.id }));
      await refused(tx, 'EditCustomerDraft_primaryPhoneNorm_shape', draft({ primaryPhoneNorm: '+968 91234567' }));
      await refused(tx, 'EditCustomerDraft_crNumberNorm_shape', draft({ crNumberNorm: 'abc' }));
      await accepted(tx, draft({ channelId: a.id, subChannelId: a.subChannels[0]!.id, primaryPhoneNorm: '+96891234567', crNumberNorm: 'ABC' }));

      // EditBranchDraft (no pair rule: a draft may hold one coordinate)
      await refused(tx, 'EditBranchDraft_gps_in_oman', branchDraft({ gpsLat: 10, gpsLng: 58 }));
      await refused(tx, 'EditBranchDraft_gpsAccuracy_range', branchDraft({ gpsAccuracy: -1 }));
      await refused(tx, 'EditBranchDraft_equipment_counts_range', branchDraft({ standsCount: 101 }));
      await accepted(tx, branchDraft({ gpsLat: 23.6 }));

      // Sub-channel of another channel: the composite foreign keys.
      await refused(tx, 'Customer_subChannelId_channelId_fkey', newCustomer('15', { channelId: b.id, subChannelId: a.subChannels[0]!.id }));
      await refused(tx, 'EditCustomerDraft_subChannelId_channelId_fkey', draft({ channelId: b.id, subChannelId: a.subChannels[0]!.id }));
    });
  });

  it('every foreign key refuses a dangling id; SET NULL fires; RESTRICT keeps what a request names', async () => {
    await inRolledBack(db, async (tx) => {
      const w = await world(tx);
      const ghost = `${sfx}-missing`;
      const c = (n: string, data: Record<string, unknown>) => () =>
        tx.customer.create({ data: { nmwcCode: `C${SFX}-F${n}`, legalName: 'ZZ', ...data } as Prisma.CustomerUncheckedCreateInput });
      await refused(tx, 'Customer_createdById_fkey', c('1', { createdById: ghost }));
      await refused(tx, 'Customer_lastEditedById_fkey', c('2', { lastEditedById: ghost }));
      await refused(tx, 'Customer_importBatchId_fkey', c('3', { importBatchId: ghost }));
      await refused(tx, 'Customer_lastTemixUploadBatchId_fkey', c('4', { lastTemixUploadBatchId: ghost }));
      await refused(tx, 'Branch_createdById_fkey', () => tx.branch.update({ where: { id: w.branch.id }, data: { createdById: ghost } }));
      await refused(tx, 'Branch_lastEditedById_fkey', () => tx.branch.update({ where: { id: w.branch.id }, data: { lastEditedById: ghost } }));
      const att = (data: Record<string, unknown>) => () =>
        tx.attachment.create({
          data: { kind: 'FREE', r2Key: `${sfx}/${++sp}.jpg`, mimeType: 'image/jpeg', bytes: 1, capturedById: w.user.id, capturedAt: new Date(), ...data } as Prisma.AttachmentUncheckedCreateInput,
        });
      await refused(tx, 'Attachment_customerId_fkey', att({ customerId: ghost }));
      await refused(tx, 'Attachment_branchId_fkey', att({ branchId: ghost }));
      await refused(tx, 'Notification_customerId_fkey', () =>
        tx.notification.create({ data: { userId: w.user.id, kind: 'EDIT_SUBMITTED', title: 'ZZ', body: 'ZZ', customerId: ghost } })
      );
      await refused(tx, 'CustomerEdit_newRouteId_fkey', () =>
        tx.customerEdit.update({ where: { id: w.edit.id }, data: { newRouteId: ghost } })
      );
      // On insert the trigger copies customerId; a request with none yet may be given one once.
      await refused(tx, 'CustomerEdit_originalCustomerId_fkey', () =>
        tx.customerEdit.update({ where: { id: w.edit.id }, data: { originalCustomerId: ghost } })
      );

      // SET NULL: the creator deleted, the photo's and the notification's customer deleted.
      const made = await tx.customer.create({ data: { nmwcCode: `C${SFX}-S`, legalName: 'ZZ', createdById: w.user.id } });
      const tmpUser = await tx.user.create({ data: { username: `t.${sfx}`, fullName: 'ZZ', role: 'SALESMAN', passwordHash: 'x' } });
      await tx.customer.update({ where: { id: made.id }, data: { lastEditedById: tmpUser.id } });
      await tx.user.delete({ where: { id: tmpUser.id } });
      expect((await tx.customer.findUniqueOrThrow({ where: { id: made.id } })).lastEditedById).toBeNull();
      const photo = await att({ customerId: made.id })();
      const note = await tx.notification.create({ data: { userId: w.user.id, kind: 'EDIT_SUBMITTED', title: 'ZZ', body: 'ZZ', customerId: made.id } });
      await tx.customer.delete({ where: { id: made.id } });
      expect((await tx.attachment.findUniqueOrThrow({ where: { id: (photo as { id: string }).id } })).customerId).toBeNull();
      expect((await tx.notification.findUniqueOrThrow({ where: { id: note.id } })).customerId).toBeNull();

      // RESTRICT: a customer, a shop and a route a request or an approval names.
      await tx.customerEdit.create({
        data: { target: 'BRANCH', submittedById: w.user.id, customerId: w.customer.id, branchId: w.branch.id, state: 'DRAFT', fieldChanges: [], attachmentChanges: [] },
      });
      await refused(tx, 'CustomerEdit_branchId_fkey', () => tx.branch.delete({ where: { id: w.branch.id } }));
      await refused(tx, 'CustomerEdit_', () => tx.customer.delete({ where: { id: w.customer.id } }));
      const other = await tx.route.create({ data: { code: `R2${SFX}`, name: 'ZZ', regionId: w.region.id } });
      await tx.customerEdit.update({ where: { id: w.edit.id }, data: { newRouteId: other.id } });
      await refused(tx, 'CustomerEdit_newRouteId_fkey', () => tx.route.delete({ where: { id: other.id } }));
    });
  });

  it('the nightly check counts one row per rule on TEMP shadows; every rule is present and not validated', async () => {
    await inRolledBack(db, async (tx) => {
      const tables = [...new Set(DB_RULES.flatMap((r: DbRule) => (r.kind === 'fk' ? [r.table, r.refTable] : [r.table])))];
      for (const t of tables) {
        // No constraints copied (CTAS): the shadows take any row, so each rule can be broken alone.
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE "${t}" ON COMMIT DROP AS SELECT * FROM public."${t}" WITH NO DATA`);
      }
      const ins = (t: string, row: Record<string, unknown>) => {
        const cols = Object.keys(row);
        return tx.$executeRaw(
          Prisma.sql`INSERT INTO ${Prisma.raw(`pg_temp."${t}"`)} (${Prisma.raw(cols.map((c) => `"${c}"`).join(', '))}) VALUES (${Prisma.join(cols.map((c) => (c === 'paymentTerms' ? Prisma.sql`${row[c]}::"PaymentTerms"` : Prisma.sql`${row[c]}`)))})`
        );
      };
      // What the foreign keys may point at.
      await ins('User', { id: 'u1' });
      await ins('ImportBatch', { id: 'ib1' });
      await ins('TemixSyncBatch', { id: 'tb1' });
      await ins('SubChannel', { id: 'sc1', channelId: 'ch1' });
      await ins('Route', { id: 'r1' });
      await ins('Customer', { id: 'c-ok', paymentTerms: 'CREDIT', creditLimit: 5, createdById: 'u1', channelId: 'ch1', subChannelId: 'sc1' });
      await ins('Branch', { id: 'b-ok', coolersCount: 0, standsCount: 0, emptyBottlesCount: 0, gpsLat: 23.6, gpsLng: 58.4 });
      const breaking: Record<string, [string, Record<string, unknown>]> = {
        Customer_credit_terms_only_credit: ['Customer', { paymentTerms: 'CASH', creditLimit: 5 }],
        Customer_subChannel_needs_channel: ['Customer', { subChannelId: 'sc1' }],
        Customer_primaryPhoneNorm_shape: ['Customer', { primaryPhoneNorm: '91234567' }],
        Customer_crNumberNorm_shape: ['Customer', { crNumberNorm: 'cr-1' }],
        Customer_subChannelId_channelId_fkey: ['Customer', { subChannelId: 'sc1', channelId: 'ch-other' }],
        Customer_createdById_fkey: ['Customer', { createdById: 'u-missing' }],
        Customer_lastEditedById_fkey: ['Customer', { lastEditedById: 'u-missing' }],
        Customer_importBatchId_fkey: ['Customer', { importBatchId: 'ib-missing' }],
        Customer_lastTemixUploadBatchId_fkey: ['Customer', { lastTemixUploadBatchId: 'tb-missing' }],
        Branch_gps_in_oman: ['Branch', { gpsLat: 30, gpsLng: 58 }],
        Branch_gps_pair: ['Branch', { gpsLat: 23.6 }],
        Branch_gpsAccuracy_range: ['Branch', { gpsAccuracy: 20000 }],
        Branch_equipment_counts_range: ['Branch', { coolersCount: 101 }],
        Branch_createdById_fkey: ['Branch', { createdById: 'u-missing' }],
        Branch_lastEditedById_fkey: ['Branch', { lastEditedById: 'u-missing' }],
        EditCustomerDraft_subChannel_needs_channel: ['EditCustomerDraft', { subChannelId: 'sc1' }],
        EditCustomerDraft_primaryPhoneNorm_shape: ['EditCustomerDraft', { primaryPhoneNorm: 'x' }],
        EditCustomerDraft_crNumberNorm_shape: ['EditCustomerDraft', { crNumberNorm: '' }],
        EditCustomerDraft_subChannelId_channelId_fkey: ['EditCustomerDraft', { subChannelId: 'sc1', channelId: 'ch-other' }],
        EditBranchDraft_gps_in_oman: ['EditBranchDraft', { gpsLng: 70 }],
        EditBranchDraft_gpsAccuracy_range: ['EditBranchDraft', { gpsAccuracy: -1 }],
        EditBranchDraft_equipment_counts_range: ['EditBranchDraft', { emptyBottlesCount: 5000 }],
        Attachment_customerId_fkey: ['Attachment', { customerId: 'c-missing' }],
        Attachment_branchId_fkey: ['Attachment', { branchId: 'b-missing' }],
        Notification_customerId_fkey: ['Notification', { customerId: 'c-missing' }],
        EditApproval_submitterRouteId_fkey: ['EditApproval', { submitterRouteId: 'r-missing' }],
        CustomerEdit_originalCustomerId_fkey: ['CustomerEdit', { originalCustomerId: 'c-missing' }],
        CustomerEdit_newRouteId_fkey: ['CustomerEdit', { newRouteId: 'r-missing' }],
      };
      expect(Object.keys(breaking).sort()).toEqual([...DB_RULE_NAMES].sort());
      for (const [name, [t, row]] of Object.entries(breaking)) await ins(t, { id: `x-${name}`, ...row });
      // Conforming rows that must not be counted.
      await ins('Attachment', { id: 'a-ok', customerId: 'c-ok', branchId: 'b-ok' });
      await ins('CustomerEdit', { id: 'e-ok', originalCustomerId: 'c-ok', newRouteId: 'r1' });

      const out = await CHECK_BY_ID.get('db-rules-older-rows')!.run!(tx, { now: new Date(), previous: new Map() });
      const byRule = (out.detail as { byRule: Record<string, { violations: number; validated: boolean | 'missing' }> }).byRule;
      for (const name of DB_RULE_NAMES) {
        expect(byRule[name], name).toEqual({ violations: 1, validated: false });
      }
      expect(out.count).toBe(DB_RULE_NAMES.length);
      expect(out.sampleIds.length).toBeLessThanOrEqual(10);
      expect(out.sampleIds[0]).toMatch(/^Customer_credit_terms_only_credit:x-/);
      expect((out.detail as { readyToValidate: string[]; missing: string[] }).readyToValidate).toEqual([]);
      expect((out.detail as { missing: string[] }).missing).toEqual([]);
    });
  });
});
