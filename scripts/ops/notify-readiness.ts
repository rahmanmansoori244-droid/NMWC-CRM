/**
 * Is the organisation ready for notification e-mail? READ-ONLY, counts only.
 *
 *   NMWC_PROD_ENV_FILE=<env file> node scripts/dev/prod-run.cjs \
 *     scripts/ops/notify-readiness.ts --expect-host <host marker>
 *
 *   or against UAT / a local database:
 *   npx tsx scripts/ops/notify-readiness.ts --expect-host <host marker>
 *
 * WHY. F1 (2026-10-05) e-mails a salesman's hierarchy when he submits a
 * request: his supervisor (a Manager in this organisation, which has no
 * Supervisor accounts), the region's Manager(s) as a fallback, and the region's
 * Accountant (lib/notify-policy.ts). The e-mail reaches only an account that is
 * active, holds an allowed role and has an address on file, and the in-app row
 * reaches only the account the hierarchy names. Before the owner turns e-mail on
 * (NOTIFY_EMAIL_ENABLED=on) this says where the hierarchy has gaps, so they are
 * fixed on /users first instead of discovered as silence.
 *
 * WHAT IT REPORTS, as counts and never as a name, username, address or id:
 *   (a) active approver accounts (MANAGER, SUPERVISOR, ACCOUNTANT, FINANCE_MANAGER)
 *       with an e-mail on file, without one, and with one that is not an address;
 *   (b) active salesmen whose request reaches no supervisor: none set, set to an
 *       inactive account, set to a role that cannot supervise, or set to a Manager
 *       who does not manage the salesman's route region (that Manager is told,
 *       but the request's page refuses him); and salesmen with no route;
 *   (c) active regions with no active Accountant, and with no active Manager;
 *   (d) e-mail addresses held by more than one account once case is ignored
 *       (User.email is unique but case-sensitive, so both would be mailed);
 *   (e) how many active Supervisor accounts exist at all.
 *
 * Its output is never committed or pasted into the repository, which is public
 * (docs/handover/04-PENDING-WORK.md, "This file is public").
 *
 * READ-ONLY: one `SET TRANSACTION READ ONLY` transaction, so the database refuses
 * any write this script might be changed to attempt. --expect-host is required,
 * as for every operator script here (requeue-untracked.ts requireExpectedHost):
 * a variable that did not take cannot point it at the wrong database.
 */
import { PrismaClient, Role } from '@prisma/client';
import { connectWaking, requireExpectedHost } from './requeue-untracked';
import { operatorErrorLabel } from './error-label';

/** Roles that can receive notification e-mail (lib/notify-policy.ts EMAIL_ROLES). */
export const READINESS_APPROVER_ROLES: readonly Role[] = [
  Role.MANAGER,
  Role.SUPERVISOR,
  Role.ACCOUNTANT,
  Role.FINANCE_MANAGER,
];

/** The same address shape lib/email/config.ts accepts: one @, a dot after it, no spaces. */
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ReadinessUser = {
  id: string;
  role: Role;
  isActive: boolean;
  email: string | null;
  supervisorId: string | null;
  routeRegionId: string | null;
  managedRegionIds: string[];
};

export type ReadinessRegion = { id: string; isActive: boolean };

export type ReadinessReport = {
  approvers: Record<string, { withEmail: number; without: number; malformed: number }>;
  salesmen: {
    active: number;
    noSupervisor: number;
    supervisorInactive: number;
    supervisorWrongRole: number;
    managerNotOverRegion: number;
    noRoute: number;
  };
  regions: { active: number; noAccountant: number; noManager: number };
  caseDuplicates: { groups: number; accounts: number };
  activeSupervisors: number;
};

/** Pure: the counts, from the rows. Exported for tests/unit/notify-readiness.test.ts. */
export function readinessReport(users: ReadinessUser[], regions: ReadinessRegion[]): ReadinessReport {
  const byId = new Map(users.map((u) => [u.id, u] as const));
  const active = users.filter((u) => u.isActive);

  const approvers: ReadinessReport['approvers'] = {};
  for (const role of READINESS_APPROVER_ROLES) {
    const holders = active.filter((u) => u.role === role);
    const has = (u: ReadinessUser) => (u.email ?? '').trim() !== '';
    approvers[role] = {
      withEmail: holders.filter((u) => has(u) && ADDRESS.test(u.email!.trim())).length,
      without: holders.filter((u) => !has(u)).length,
      malformed: holders.filter((u) => has(u) && !ADDRESS.test(u.email!.trim())).length,
    };
  }

  const salesmen = active.filter((u) => u.role === Role.SALESMAN);
  const s = {
    active: salesmen.length,
    noSupervisor: 0,
    supervisorInactive: 0,
    supervisorWrongRole: 0,
    managerNotOverRegion: 0,
    noRoute: 0,
  };
  for (const u of salesmen) {
    if (!u.routeRegionId) s.noRoute += 1;
    const sup = u.supervisorId ? byId.get(u.supervisorId) : undefined;
    if (!sup) {
      s.noSupervisor += 1;
      continue;
    }
    if (!sup.isActive) {
      s.supervisorInactive += 1;
      continue;
    }
    if (sup.role !== Role.MANAGER && sup.role !== Role.SUPERVISOR) {
      s.supervisorWrongRole += 1;
      continue;
    }
    if (sup.role === Role.MANAGER && u.routeRegionId && !sup.managedRegionIds.includes(u.routeRegionId)) {
      s.managerNotOverRegion += 1;
    }
  }

  const liveRegions = regions.filter((r) => r.isActive);
  const holdsRegion = (role: Role, regionId: string) =>
    active.some((u) => u.role === role && u.managedRegionIds.includes(regionId));

  const byAddress = new Map<string, number>();
  for (const u of users) {
    const key = (u.email ?? '').trim().toLowerCase();
    if (!key) continue;
    byAddress.set(key, (byAddress.get(key) ?? 0) + 1);
  }
  const dupGroups = [...byAddress.values()].filter((n) => n > 1);

  return {
    approvers,
    salesmen: s,
    regions: {
      active: liveRegions.length,
      noAccountant: liveRegions.filter((r) => !holdsRegion(Role.ACCOUNTANT, r.id)).length,
      noManager: liveRegions.filter((r) => !holdsRegion(Role.MANAGER, r.id)).length,
    },
    caseDuplicates: { groups: dupGroups.length, accounts: dupGroups.reduce((a, n) => a + n, 0) },
    activeSupervisors: active.filter((u) => u.role === Role.SUPERVISOR).length,
  };
}

/** Pure: the report as the lines it prints. Counts and fixed words only. */
export function formatReadiness(r: ReadinessReport): string[] {
  const lines: string[] = [];
  lines.push('Approver accounts (active) and an e-mail on file:');
  for (const [role, c] of Object.entries(r.approvers)) {
    lines.push(`  ${role.padEnd(16)} with ${c.withEmail} · without ${c.without} · not an address ${c.malformed}`);
  }
  lines.push(`Active Supervisor accounts: ${r.activeSupervisors}`);
  lines.push(`Salesmen (active): ${r.salesmen.active}`);
  lines.push(`  no supervisor set                         ${r.salesmen.noSupervisor}`);
  lines.push(`  supervisor account disabled               ${r.salesmen.supervisorInactive}`);
  lines.push(`  supervisor is not a Manager or Supervisor ${r.salesmen.supervisorWrongRole}`);
  lines.push(`  Manager does not manage the route region  ${r.salesmen.managerNotOverRegion}`);
  lines.push(`  no route                                  ${r.salesmen.noRoute}`);
  lines.push(`Regions (active): ${r.regions.active}`);
  lines.push(`  with no active Accountant ${r.regions.noAccountant}`);
  lines.push(`  with no active Manager    ${r.regions.noManager}`);
  lines.push(
    `E-mail addresses held by more than one account (ignoring case): ${r.caseDuplicates.groups} address(es), ${r.caseDuplicates.accounts} account(s)`
  );
  return lines;
}

async function main(): Promise<number> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('set DIRECT_URL (preferred) or DATABASE_URL');
  const args = process.argv.slice(2);
  const host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
  requireExpectedHost(args, url, host);

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await connectWaking(prisma);
    const { users, regions } = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const rows = await tx.user.findMany({
        select: {
          id: true,
          role: true,
          isActive: true,
          email: true,
          supervisorId: true,
          ownedRoute: { select: { regionId: true } },
          managedRegions: { select: { id: true } },
        },
      });
      const regs = await tx.region.findMany({ select: { id: true, isActive: true } });
      return {
        users: rows.map((u) => ({
          id: u.id,
          role: u.role,
          isActive: u.isActive,
          email: u.email,
          supervisorId: u.supervisorId,
          routeRegionId: u.ownedRoute?.regionId ?? null,
          managedRegionIds: u.managedRegions.map((m) => m.id),
        })),
        regions: regs,
      };
    });
    console.log(`\nNotification readiness (read-only, counts only)\nTarget: ${host}\n`);
    for (const line of formatReadiness(readinessReport(users, regions))) console.log(line);
    console.log('\nFix gaps on /users (Steward: Add e-mail, Reports to) before NOTIFY_EMAIL_ENABLED=on.\n');
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

/** Run only when invoked as a command, so importing this in a test opens no connection. */
if (/notify-readiness\.ts$/.test(process.argv[1] ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      console.error(`\nREADINESS CHECK FAILED: ${operatorErrorLabel(e)}\n`);
      process.exit(2);
    });
}
