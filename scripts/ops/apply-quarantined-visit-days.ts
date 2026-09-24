/**
 * Land the visit days that a quarantine held back.
 *
 *   DIRECT_URL='<the OWNER connection string>' npx tsx scripts/ops/apply-quarantined-visit-days.ts \
 *     --expect-host ep-sweet-haze [--apply] [--actor <username>]
 *
 * WHY THE DAYS ARE MISSING. Of the 20,199 rows in the customer master, 69 are
 * QUARANTINED — every one of them for "phone already exists in master". A
 * quarantined row is never promoted, so its branch never receives its
 * `dayOfVisit`, and a branch with no visit day never appears on anyone's Today.
 * That is 47 customers, and it is the last failing check in verify-load.
 *
 * WHAT THE COLLISION ACTUALLY IS, because it decides what this script may do.
 * The customer already holding the phone is, in 47 of the 69 cases, THE SAME
 * BUSINESS under a second customer record — incoming `CAA2429` collides with
 * `CAA2429-MABEC7`, which is that customer's Mabela branch existing as its own
 * customer row. One shop, two records. That is a genuine duplicate and merging
 * the two is the Steward's job in /duplicates: it is destructive, it needs a
 * human to say which record survives, and nothing here touches it.
 *
 * SO THIS SCRIPT DOES THE NARROW THING INSTEAD. It writes the journey plan's
 * visit day onto the branch that ALREADY EXISTS, which is exactly what the
 * promote would have written had the row not been held. It does not merge, does
 * not create, does not delete, and does not touch the quarantine — those rows
 * stay quarantined and the duplicates stay in the queue for review.
 *
 * IT IS DELIBERATELY TIMID ABOUT MATCHING. A quarantined row is only applied when
 * its customer has EXACTLY ONE live branch of that name and that branch has NO
 * day recorded. Anything ambiguous — two branches of the same name, a branch that
 * already carries a different day, a customer that is not live — is skipped and
 * reported. Writing the wrong branch's visit day sends a salesman to the wrong
 * shop on the wrong morning, so the failure direction here is "leave it alone".
 *
 * Reversible: every branch it touches is named in the ledger rows it writes.
 */
import { PrismaClient, DayOfWeek, type Prisma } from '@prisma/client';
import { connectWaking, requireExpectedHost, resolveActor } from './requeue-untracked';

/** Rows per statement; tiny here, but the same shape as its sibling scripts. */
const CHUNK = 100;

type Plan = {
  custCode: string;
  branchId: string;
  branchCode: string;
  day: DayOfWeek;
};

type Skip = { custCode: string; why: string };

async function main(): Promise<number> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('set DIRECT_URL (preferred) or DATABASE_URL');
  const args = process.argv.slice(2);
  const host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
  requireExpectedHost(args, url, host);

  const apply = args.includes('--apply');
  const actorIdx = args.indexOf('--actor');
  const actorArg = actorIdx >= 0 ? (args[actorIdx + 1] ?? '') : '';
  if (actorIdx >= 0 && (!actorArg || actorArg.startsWith('--'))) {
    throw new Error('--actor was passed without a username');
  }

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    console.log(`\nTarget: ${host}`);
    console.log(
      apply
        ? 'Mode:   APPLY — rows WILL be written'
        : 'Mode:   DRY RUN — nothing will be written (pass --apply to write)'
    );
    console.log('='.repeat(76));
    await connectWaking(prisma);

    // The LATEST customer batch. An older batch's quarantines describe a master
    // that is no longer the one on disk, and applying those would write days the
    // current journey plan has since moved.
    const batch = await prisma.importBatch.findFirst({
      where: { kind: 'CUSTOMER' },
      orderBy: { uploadedAt: 'desc' },
      select: { id: true, uploadedAt: true, filename: true },
    });
    if (!batch) throw new Error('no customer import batch on this database');
    console.log(`Batch:  ${batch.filename} (${batch.uploadedAt.toISOString()})`);

    const quarantined = await prisma.importRow.findMany({
      where: { batchId: batch.id, state: 'QUARANTINED' },
      select: { rowNumber: true, parsed: true },
      orderBy: { rowNumber: 'asc' },
    });
    console.log(`Quarantined rows: ${quarantined.length}`);

    const withDay = quarantined
      .map((r) => r.parsed as Record<string, unknown> | null)
      .filter((p): p is Record<string, unknown> => !!p)
      .map((p) => ({
        custCode: String(p.custCode ?? '').trim().toUpperCase(),
        branchName: String(p.branchName ?? '').trim() || 'Main',
        day: String(p.dayOfVisit ?? '').trim().toUpperCase(),
      }))
      .filter((r) => r.custCode && r.day);
    console.log(`   ...carrying a visit day:  ${withDay.length}`);

    const customers = await prisma.customer.findMany({
      where: { deletedAt: null, nmwcCode: { in: [...new Set(withDay.map((r) => r.custCode))] } },
      select: {
        nmwcCode: true,
        branches: {
          where: { deletedAt: null },
          select: { id: true, branchCode: true, branchName: true, dayOfVisit: true },
        },
      },
    });
    const byCode = new Map(customers.map((c) => [c.nmwcCode.toUpperCase(), c.branches]));

    const plan: Plan[] = [];
    const skips: Skip[] = [];
    for (const r of withDay) {
      if (!(r.day in DayOfWeek)) {
        skips.push({ custCode: r.custCode, why: `day "${r.day}" is not one of the seven` });
        continue;
      }
      const branches = byCode.get(r.custCode);
      if (!branches) {
        skips.push({ custCode: r.custCode, why: 'customer is not live on this database' });
        continue;
      }
      const named = branches.filter(
        (b) => b.branchName.trim().toUpperCase() === r.branchName.toUpperCase()
      );
      if (named.length === 0) {
        skips.push({ custCode: r.custCode, why: `no live branch named "${r.branchName}"` });
        continue;
      }
      if (named.length > 1) {
        skips.push({
          custCode: r.custCode,
          why: `${named.length} live branches named "${r.branchName}" — cannot tell which`,
        });
        continue;
      }
      const b = named[0];
      if (b.dayOfVisit) {
        skips.push({
          custCode: r.custCode,
          why:
            b.dayOfVisit === r.day
              ? 'already carries this day'
              : `already carries ${b.dayOfVisit}, master says ${r.day} — steward review`,
        });
        continue;
      }
      plan.push({
        custCode: r.custCode,
        branchId: b.id,
        branchCode: b.branchCode,
        day: r.day as DayOfWeek,
      });
    }

    console.log('');
    console.log(`Would set a visit day on: ${plan.length} branch(es)`);
    console.log(`Skipped:                  ${skips.length}`);
    const byWhy = new Map<string, number>();
    for (const s of skips) {
      const key = s.why.replace(/"[^"]*"/g, '"…"').replace(/\d+/g, 'N');
      byWhy.set(key, (byWhy.get(key) ?? 0) + 1);
    }
    for (const [w, n] of [...byWhy].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(n).padStart(4)}  ${w}`);
    }
    const byDay = new Map<string, number>();
    for (const p of plan) byDay.set(p.day, (byDay.get(p.day) ?? 0) + 1);
    if (plan.length > 0) {
      console.log('\n   days to be written: ' + [...byDay].sort().map(([d, n]) => `${d}=${n}`).join(' '));
    }

    console.log('');
    console.log('NOT touched: the quarantine itself, the duplicate queue, and every');
    console.log('customer record involved. Those 69 rows stay quarantined and the');
    console.log('duplicates stay in /duplicates for a Steward to merge.');

    if (plan.length === 0) {
      console.log('\nNothing to do.\n');
      return 0;
    }

    const actor = await resolveActor(prisma, actorArg);
    console.log(
      `Audit actor: ${actor.username}` + (actorArg ? ' (--actor)' : ' (the one active Steward)')
    );

    if (!apply) {
      console.log('='.repeat(76));
      console.log('DRY RUN — nothing was written. Re-run with --apply to make the change.\n');
      return 0;
    }

    const at = new Date();
    console.log('='.repeat(76));
    console.log(`Applying as ${actor.username} at ${at.toISOString()}`);

    // The claim row first, carrying every branch this run will touch and the day
    // it will write — so an interrupted run is still fully reversible from the
    // ledger, which is the only way back for a field with no in-app history.
    await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'UPDATE',
        entityType: 'QuarantinedVisitDays',
        entityId: at.toISOString(),
        reason:
          `operator script scripts/ops/apply-quarantined-visit-days.ts on ${host}: STARTING — ` +
          `about to write dayOfVisit on ${plan.length} branch(es) whose import row was held in ` +
          'QUARANTINE for a duplicate phone and therefore never promoted. The day written is ' +
          'the one the journey plan supplied in the master, and is exactly what the promote ' +
          'would have written. No customer is merged, created or deleted and no quarantine is ' +
          'cleared. Every branch and day is listed in this row, so the change can be reversed ' +
          'from the ledger alone. Run outside any session, so ip and userAgent are null by ' +
          'construction.',
        after: {
          phase: 'started',
          intended: plan.length,
          batchId: batch.id,
          host,
          branches: plan.map((p) => ({ branchCode: p.branchCode, day: p.day })),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    let done = 0;
    for (let i = 0; i < plan.length; i += CHUNK) {
      for (const p of plan.slice(i, i + CHUNK)) {
        const res = await prisma.branch.updateMany({
          // dayOfVisit null again in the WHERE: if anything set a day between the
          // read above and now, that decision wins over this one.
          where: { id: p.branchId, deletedAt: null, dayOfVisit: null },
          data: { dayOfVisit: p.day, lastEditedById: actor.id },
        });
        done += res.count;
      }
      console.log(`  written ${String(done).padStart(4)} of ${plan.length}`);
    }

    await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'UPDATE',
        entityType: 'QuarantinedVisitDays',
        entityId: at.toISOString(),
        reason:
          `operator script scripts/ops/apply-quarantined-visit-days.ts on ${host}: COMPLETED — ` +
          `${done} branch(es) now carry the visit day their quarantined import row supplied. ` +
          "Pairs with the STARTING row of the same entityId, whose payload lists every branch " +
          'and the day written. Run outside any session, so ip and userAgent are null by ' +
          'construction.',
        after: {
          phase: 'completed',
          written: done,
          intended: plan.length,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    console.log('='.repeat(76));
    console.log(`Wrote ${done} of ${plan.length}.`);
    console.log('');
    console.log('For the record — paste this into the go-live log:');
    console.log('');
    console.log(`  scripts/ops/apply-quarantined-visit-days.ts --apply   ${at.toISOString()}`);
    console.log(`  database        ${host}`);
    console.log(`  run as          ${actor.username}`);
    console.log(`  written         ${done} branch(es) given the visit day from the master`);
    console.log(`  skipped         ${skips.length} quarantined row(s) — ambiguous or already set`);
    console.log(`  NOT done        no merge, no quarantine cleared, no duplicate resolved`);
    console.log(
      `  audit rows      AuditLog entityType=QuarantinedVisitDays entityId=${at.toISOString()} (STARTING + COMPLETED)`
    );
    console.log('');
    console.log('Next: npm run smoke, then npm run verify:load.');
    console.log('The 69 duplicate-phone quarantines are still open in /duplicates.\n');
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (/apply-quarantined-visit-days\.ts$/.test(process.argv[1] ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch((e: Error) => {
      console.error(`\nVISIT-DAY APPLY FAILED: ${e.message}\n`);
      process.exit(2);
    });
}
