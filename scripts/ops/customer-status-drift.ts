/**
 * Customers whose status contradicts their shops (owner decision 7, 2026-10-07).
 *
 *   npx tsx scripts/ops/customer-status-drift.ts --expect-host <host marker> [--list]
 *   npx tsx scripts/ops/customer-status-drift.ts --expect-host <host marker> --apply [--actor <steward>]
 *
 *   or against production, through the owner connection:
 *   NMWC_PROD_ENV_FILE=<env file> node scripts/dev/prod-run.cjs \
 *     scripts/ops/customer-status-drift.ts --expect-host ep-sweet-haze [--list | --apply]
 *
 * WHY. Decision 7 moves a customer's status when one of its branches changes
 * (lib/customer-status.ts). It never re-reads a customer whose branches changed
 * before it shipped: one whose shops were closed one by one earlier, or that the
 * master load brought in that way, stays ACTIVE with every shop closed until one
 * of them changes again, and the Status filter "Closed" on /customers does not
 * find it (fixer review; UAT had 1 of 163 live customers).
 *
 * WHAT IT FINDS, by the rule's own reading of a state (lib/customer-status-rule.ts
 * statusDrift), among live customers with at least one live branch:
 *   close   every live branch CLOSED, the customer not       -> CLOSED
 *   reopen  CLOSED, with an ACTIVE live branch                -> ACTIVE
 *   review  ACTIVE, no ACTIVE live branch, some SUSPENDED: whether its last open
 *           shop closed or was suspended is not in the data, so it is never
 *           moved here; a Manager or the Steward decides on the customer's page.
 * A SUSPENDED customer with an ACTIVE branch is a hold a person set, not drift.
 *
 * OUTPUT: counts; with --list also the NMWC codes of each kind (never a name).
 * Its output is never committed or pasted into the repository, which is public.
 *
 * Without --apply it is READ-ONLY: one `SET TRANSACTION READ ONLY` transaction.
 * --apply moves `close` and `reopen` only, one customer per transaction: its row
 * lock first (lib/locks.ts), then a fresh read and the classification again on
 * it (a customer changed since the scan is left to whatever changed it), the
 * status written with the version bumped (an edit form open on it then reports a
 * conflict instead of writing over the new status, B-05), and one CLOSE or
 * REACTIVATE audit row on the customer, as decision 7 writes, attributed to
 * --actor (a Steward; the one active Steward by default) with null ip and
 * userAgent (run outside any session: RECORDS-OF-PROCESSING A6). Each customer
 * commits with its own audit row, so an interrupted run is partial, never
 * unrecorded, and re-running is safe: a moved customer no longer matches.
 * --expect-host is required, as for every operator script here.
 */
import { PrismaClient, CustomerStatus, type Prisma } from '@prisma/client';
import { connectWaking, requireExpectedHost, resolveActor } from './requeue-untracked';
import { OperatorRefusal, operatorErrorLabel } from './error-label';
import { statusDrift, type StatusDrift } from '../../lib/customer-status-rule';
import { lockCustomerRow } from '../../lib/locks';

export type DriftRow = { id: string; nmwcCode: string; status: CustomerStatus; drift: StatusDrift };

type Reader = Pick<Prisma.TransactionClient, 'customer'>;

/** Live customers whose status contradicts their live branches (`where` narrows the scan; tests scope it). */
export async function readDrift(db: Reader, where: Prisma.CustomerWhereInput = {}): Promise<DriftRow[]> {
  const rows = await db.customer.findMany({
    where: { ...where, deletedAt: null },
    select: {
      id: true,
      nmwcCode: true,
      status: true,
      branches: { where: { deletedAt: null }, select: { status: true } },
    },
    orderBy: { nmwcCode: 'asc' },
  });
  return rows.flatMap((c) => {
    const drift = statusDrift(
      c.status,
      c.branches.map((b) => b.status)
    );
    return drift ? [{ id: c.id, nmwcCode: c.nmwcCode, status: c.status, drift }] : [];
  });
}

export function driftCounts(rows: readonly DriftRow[]): Record<StatusDrift['kind'], number> {
  const counts = { close: 0, reopen: 0, review: 0 };
  for (const r of rows) counts[r.drift.kind] += 1;
  return counts;
}

/**
 * Move one customer as the rule says, under its row lock, re-read and
 * re-classified there. Returns the move, or null when there is none to make now
 * (archived, gone, consistent, or one for a person to review).
 */
export async function applyDrift(
  prisma: PrismaClient,
  customerId: string,
  actorId: string,
  host: string
): Promise<{ from: CustomerStatus; to: CustomerStatus } | null> {
  return prisma.$transaction(async (tx) => {
    await lockCustomerRow(tx, customerId);
    const c = await tx.customer.findUnique({
      where: { id: customerId },
      select: { status: true, deletedAt: true, branches: { where: { deletedAt: null }, select: { status: true } } },
    });
    if (!c || c.deletedAt) return null;
    const drift = statusDrift(
      c.status,
      c.branches.map((b) => b.status)
    );
    if (!drift || drift.kind === 'review') return null;
    await tx.customer.update({
      where: { id: customerId },
      data: { status: drift.to, lastEditedById: actorId, version: { increment: 1 } },
    });
    // Operator scripts sit outside the writeAudit() rule on purpose (no request;
    // see scripts/ops/requeue-untracked.ts): the row decision 7 writes, by hand.
    await tx.auditLog.create({
      data: {
        actorId,
        action: drift.kind === 'close' ? 'CLOSE' : 'REACTIVATE',
        entityType: 'Customer',
        entityId: customerId,
        before: { status: c.status },
        after: { status: drift.to },
        reason:
          'customer status follows its branches: operator script scripts/ops/customer-status-drift.ts ' +
          `on ${host} (owner decision 7; the branches changed before the rule shipped). ` +
          'Run outside any session, so ip and userAgent are null by construction.',
      },
    });
    return { from: c.status, to: drift.to };
  });
}

async function main(): Promise<number> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) throw new OperatorRefusal('set DIRECT_URL (preferred) or DATABASE_URL');
  const args = process.argv.slice(2);
  const host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
  requireExpectedHost(args, url, host);
  const apply = args.includes('--apply');
  const list = args.includes('--list');
  const actorIdx = args.indexOf('--actor');
  const actorArg = actorIdx >= 0 ? (args[actorIdx + 1] ?? '') : '';
  if (actorIdx >= 0 && (!actorArg || actorArg.startsWith('--'))) {
    throw new OperatorRefusal('--actor was passed without a username');
  }

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await connectWaking(prisma);
    // Production check 2026-10-09: the default 5 s interactive-transaction budget
    // ran out (P2028) reading every live customer with its branches (about 14,000)
    // from Oman, though UAT's few hundred fit. A read-only scan holds no locks, so
    // a long budget costs nothing.
    const rows = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        return readDrift(tx);
      },
      { maxWait: 30_000, timeout: 180_000 }
    );
    const counts = driftCounts(rows);
    console.log(`\nCustomer status against its shops (owner decision 7)\nTarget: ${host}\n`);
    console.log(`  close   every shop closed, the customer not:          ${counts.close}`);
    console.log(`  reopen  CLOSED with an open shop:                     ${counts.reopen}`);
    console.log(`  review  ACTIVE, no open shop, a suspended one (a person decides): ${counts.review}`);
    if (list) {
      for (const kind of ['close', 'reopen', 'review'] as const) {
        const codes = rows.filter((r) => r.drift.kind === kind).map((r) => r.nmwcCode);
        if (codes.length) console.log(`\n  ${kind}: ${codes.join(', ')}`);
      }
    }
    if (!apply) {
      console.log('\nRead only. --apply moves the close and reopen rows, each audited; review rows are never moved.\n');
      return 0;
    }
    const actor = await resolveActor(prisma, actorArg);
    let moved = 0;
    let left = 0;
    for (const r of rows) {
      if (r.drift.kind === 'review') continue;
      if (await applyDrift(prisma, r.id, actor.id, host)) moved += 1;
      else left += 1;
    }
    console.log(`\n  moved ${moved}, each with a CLOSE or REACTIVATE audit row by ${actor.username}`);
    if (left) console.log(`  left ${left} that changed since the scan (re-run to see them again)`);
    console.log(`  review rows not moved: ${counts.review}\n`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

/** Run only when invoked as a command, so importing this in a test opens no connection. */
if (/customer-status-drift\.ts$/.test(process.argv[1] ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      console.error(`\nSTATUS DRIFT FAILED: ${operatorErrorLabel(e)}\n`);
      // resolveActor's own messages name accounts, so they are not printed; this is the usual cause.
      if (process.argv.includes('--apply')) {
        console.error('With --apply: the actor must be one active, real Steward; name him with --actor <username>.\n');
      }
      process.exit(2);
    });
}
