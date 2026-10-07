'use server';

import { prisma } from '@/lib/db';
import { isTransientDbError } from '@/lib/db-errors';
import {
  Role,
  ImportRowState,
  EditProcess,
  EditState,
  type Prisma,
  type DayOfWeek,
  type CustomerStatus,
} from '@prisma/client';
import { requireActor } from '@/lib/session';
import {
  AppError,
  ForbiddenError,
  ValidationError,
  RateLimitError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { revalidatePath, revalidateTag } from 'next/cache';
import { duplicateHeadingIssue, parseWorkbook } from '@/lib/excel';
import { normalizeCR } from '@/lib/cr';
import { formatCustomerCode, formatBranchCode } from '@/lib/codes';
import { checkLimit } from '@/lib/rate-limit';
import { rescoreCustomerTx } from '@/lib/rescore';
import { subChannelClearedByChannelChange } from '@/lib/channel-pair';
import bcrypt from 'bcryptjs';
import { logger } from '@/lib/logger';
import { notifyUsers } from '@/lib/notifications';
import { sendAlert } from '@/lib/alert';
import { importRejectionAlert } from '@/lib/import-rejection-alert';
import { randomUUID } from 'node:crypto';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import {
  ACCOUNT_IMPORT_STOP_AFTER_DB_FAILURES,
  ACCOUNT_ROW_NOT_PROCESSED,
  accountCreateAudit,
  accountImportInterruptedMessage,
  accountRowFailure,
  accountUpdateAudit,
  errorLogFields,
  inactiveRouteIssue,
  OWN_PASSWORD_RESET_ISSUE,
  passwordReusedIssue,
  reportableError,
  roleMismatchIssue,
  supervisorIssue,
  supervisorReportsIssue,
  type AccountState,
} from '@/lib/account-import';
import {
  importNameIssue,
  importRouteHolderIssue,
  importSupervisorCoverIssue,
  strandedCreatesImportIssue,
} from '@/lib/account-edit';
import { assertPasswordNotReused, rotatePasswordHistory } from '@/lib/password-policy';
import {
  checkCustomerRow,
  fileCollisions,
  type SheetRow,
} from '@/lib/import-row-check';
import { fixTarget, masterCollisionMaps, newerUploadsCarrying } from '@/lib/import-master-lookup';
import { lockCustomerRowByCode } from '@/lib/locks';
import { archivedUncodedDeactivationWhere } from '@/lib/temix';
import {
  branchOnlyNote,
  composeBranchCode,
  fixUnitOf,
  fixWindowClosed,
  fixWindowMessage,
  newerUploadMessage,
  readCorrections,
  unwrittenCustomerCells,
} from '@/lib/import-row-fix';

// RBAC-05-009 / PRD §4: import is Steward-only. The previous lax gate accepted
// MANAGER too, conflating Steward (master-data ops) and Manager (people ops)
// privileges and opening CHAIN-09 (mint Manager via import). Tighten to
// STEWARD only; an emergency Manager-driven import can still happen via a
// Steward-aided session.
async function requireSteward() {
  const user = await requireActor(); // F15: refuses a session that must change its password
  if (user.role !== Role.STEWARD) {
    throw new ForbiddenError('Only the Data Steward can run imports.');
  }
  return user;
}

// ── Account master import (regions, routes, users) ────────────────────────
//
// Expected sheets (any subset, in this order of dependencies):
//   1. "Regions"   — columns: code, name
//   2. "Routes"    — columns: code, name, region_code
//   3. "Users"     — columns: username, full_name, role, password,
//                                 supervisor_username (opt), route_code (opt for SALESMAN),
//                                 region_codes (opt comma-separated for MANAGER), email (opt), phone (opt)
//                  and the explicit-change flags reset_password, change_role,
//                  change_route and change_name (opt, "yes")

// The account-master import is a STEWARD-only bulk provisioning path (requireSteward
// at the call site), so — unlike the Manager-driven /users UI — it may also mint the
// credit-approver tier (ACCOUNTANT/FINANCE_MANAGER/GM). Without them a fresh org has
// no way to bulk-load approvers and the create chains cannot complete.
const VALID_ROLES: Role[] = [
  Role.SALESMAN,
  Role.SUPERVISOR,
  Role.MANAGER,
  Role.STEWARD,
  Role.VIEWER,
  Role.ACCOUNTANT,
  Role.FINANCE_MANAGER,
  Role.GM,
];

function lc(v: unknown): string {
  return String(v ?? '')
    .trim()
    .toLowerCase();
}
function uc(v: unknown): string {
  return String(v ?? '')
    .trim()
    .toUpperCase();
}

// QA-012: hard cap on uploaded xlsx (zip-bomb defense)
const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * The shortest address the DATABASE will accept for a branch.
 *
 * `Branch_address_minlength` — CHECK (length(btrim(address)) >= 3) — is created
 * in prisma/migrations/20260510120000_senior_audit_remediation/migration.sql and
 * is NOT visible in schema.prisma, which is how the import came to send values it
 * refuses. tests/unit/branch-address-guard.test.ts reads the number back out of
 * that migration and fails if the two ever disagree, because a comment asking the
 * next person to keep them in step is not a guard.
 */
const BRANCH_ADDRESS_MIN = 3;

/**
 * An address the database will accept, or null so the caller can fall back.
 *
 * Returns null for absent, blank AND too-short, because all three are the same
 * thing from the importer's point of view: a value that cannot be stored. The
 * distinction cost 26 customers three failed loads on 2026-09-23 — the fallback
 * chain handled '' and let 'X' through to Postgres, which threw a CHECK violation
 * that surfaced with no error code and the message "promote failed (UNKNOWN)".
 */
function usableBranchAddress(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length >= BRANCH_ADDRESS_MIN ? s : null;
}

/**
 * A row or batch-report failure that was not the database going away: a bug, or
 * the database refusing the write. It is caught, so nothing reaches Sentry the way
 * an uncaught one does (instrumentation.ts), and it is sent here — with the
 * original's name and stack frames, and its message cut down as the log line's
 * is. A failed report must never cost the row it is about.
 *
 * The SDK is loaded here, on first use, not with the module: every action in this
 * file would otherwise pay for it on a cold start.
 */
async function reportAccountImportFault(err: unknown, event: string): Promise<void> {
  try {
    const Sentry = await import('@sentry/nextjs');
    Sentry.captureException(reportableError(err), { tags: { event } });
  } catch {
    /* the log line above still carries it */
  }
}

export async function uploadAccountMasterAction(
  formData: FormData
): SafeAction<{ batchId: string; clean: number; issues: number }> {
  return runAction(() => uploadAccountMasterCore(formData));
}

async function uploadAccountMasterCore(
  formData: FormData
): Promise<{ batchId: string; clean: number; issues: number }> {
  const me = await requireSteward();
  // One envelope for the whole upload: read the request headers once, up front,
  // before the row loop and before anything opens a transaction.
  const env = await getAuditEnvelope(me.id);
  // F-07: same rate-limit as customer master.
  const lim = await checkLimit(`import:${me.id}`, { capacity: 3, refillPerSec: 0.05 });
  if (!lim.ok) {
    throw new RateLimitError(`Wait ${lim.retryAfterSec}s before another import.`);
  }
  const file = formData.get('file');
  if (!(file instanceof File)) throw new ValidationError({ file: 'No file uploaded.' });
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ValidationError({
      file: `File is too large (${Math.round(file.size / 1024)} KB). Maximum is 5 MB.`,
    });
  }
  const buf = Buffer.from(await file.arrayBuffer());

  let sheets;
  try {
    sheets = await parseWorkbook(buf);
  } catch (err) {
    throw new ValidationError({ file: `Could not read .xlsx: ${(err as Error).message}` });
  }
  const regionsSheet = sheets.find((s) => s.name.toLowerCase() === 'regions');
  const routesSheet = sheets.find((s) => s.name.toLowerCase() === 'routes');
  const usersSheet = sheets.find((s) => s.name.toLowerCase() === 'users');
  // N05: a repeated heading refuses the file only on a sheet this import reads.
  for (const s of [regionsSheet, routesSheet, usersSheet]) {
    const repeated = s && duplicateHeadingIssue(s);
    if (repeated) throw new ValidationError({ file: `Could not read .xlsx: ${repeated}` });
  }

  const batch = await prisma.importBatch.create({
    data: {
      filename: file.name,
      kind: 'ACCOUNT',
      uploadedById: me.id,
      status: 'PARSING',
      totalRows: sheets.reduce((acc, s) => acc + s.rows.length, 0),
    },
  });

  const issues: { sheet: string; row: number; message: string }[] = [];
  let cleanCount = 0;

  // X-IMPORTS-3: every read and write a row makes happens inside that row's try,
  // so a database fault costs that row, not the upload. The reads used to sit
  // outside it: a pool timeout on the third user's lookup escaped this function
  // after every Region, Route and earlier User had committed, runAction answered
  // "Nothing was saved", and the batch was left PARSING with no issue rows.
  let uncertain = 0;
  let dbFailuresInARow = 0;
  let stopped = false;
  // The run counts rows IN A ROW that failed because the database did not
  // answer. A row the database did answer for, and which then ended without such
  // a failure — held back by a rule — breaks the run as an applied row does, so
  // three transient failures with rule-held rows between them no longer stop the
  // import. The reset waits for the row to end, not for its read: a row whose read
  // answered and whose write then timed out is still one of the three.
  let rowAnswered = false;
  const answered = () => {
    rowAnswered = true;
  };
  const nextRow = () => {
    if (rowAnswered) dbFailuresInARow = 0;
    rowAnswered = false;
  };
  const applied = () => {
    cleanCount++;
    dbFailuresInARow = 0;
    rowAnswered = false;
  };
  const failed = async (sheet: string, row: number, err: unknown, subject: string) => {
    const f = accountRowFailure(err, subject);
    rowAnswered = false;
    issues.push({ sheet, row, message: f.message });
    // The issue text never carries the error's message; the log line does, cut
    // down and scrubbed (lib/account-import.ts errorLogFields).
    logger.warn(
      {
        sheet,
        row,
        code: (err as { code?: unknown })?.code,
        ...errorLogFields(err),
        transient: f.transient,
        batchId: batch.id,
      },
      'import.account.row_failed'
    );
    if (f.mayHaveCommitted) uncertain++;
    dbFailuresInARow = f.transient ? dbFailuresInARow + 1 : 0;
    if (dbFailuresInARow >= ACCOUNT_IMPORT_STOP_AFTER_DB_FAILURES) stopped = true;
    if (!f.transient) await reportAccountImportFault(err, 'import.account.row_failed');
  };

  // 1) Regions
  if (regionsSheet) {
    for (const [i, row] of regionsSheet.rows.entries()) {
      // N05: the row number Excel shows, not index + 2 (wrong after a blank line).
      const sheetRow = regionsSheet.rowNumbers[i];
      if (stopped) {
        issues.push({ sheet: 'Regions', row: sheetRow, message: ACCOUNT_ROW_NOT_PROCESSED });
        continue;
      }
      const code = uc(row.code ?? row.Code);
      const name = String(row.name ?? row.Name ?? '').trim();
      if (!code || !name) {
        issues.push({ sheet: 'Regions', row: sheetRow, message: 'code and name required' });
        continue;
      }
      try {
        // X-AUTH-3 / X-IMPORTS-1: a new or renamed region is audited in the same
        // transaction as the write, so the two stand or fall together. An
        // unchanged row writes nothing, so a re-import does not flood the ledger.
        await prisma.$transaction(async (tx) => {
          const before = await tx.region.findUnique({ where: { code } });
          if (!before) {
            const created = await tx.region.create({ data: { code, name } });
            await writeAudit(tx, env, {
              action: 'CREATE',
              entityType: 'Region',
              entityId: created.id,
              after: { code, name, batchId: batch.id },
              reason: 'account_import',
            });
          } else if (before.name !== name) {
            await tx.region.update({ where: { id: before.id }, data: { name } });
            await writeAudit(tx, env, {
              action: 'UPDATE',
              entityType: 'Region',
              entityId: before.id,
              before: { name: before.name },
              after: { name, batchId: batch.id },
              reason: 'account_import',
            });
          }
        });
        applied();
      } catch (err) {
        await failed('Regions', sheetRow, err, `region "${code}"`);
      }
    }
  }

  // 2) Routes
  if (routesSheet) {
    for (const [i, row] of routesSheet.rows.entries()) {
      nextRow();
      const sheetRow = routesSheet.rowNumbers[i];
      if (stopped) {
        issues.push({ sheet: 'Routes', row: sheetRow, message: ACCOUNT_ROW_NOT_PROCESSED });
        continue;
      }
      const code = uc(row.code ?? row.Code);
      const name = String(row.name ?? row.Name ?? '').trim();
      const regionCode = uc(row.region_code ?? row.regionCode ?? row.region);
      if (!code || !name || !regionCode) {
        issues.push({
          sheet: 'Routes',
          row: sheetRow,
          message: 'code, name, region_code required',
        });
        continue;
      }
      try {
        const region = await prisma.region.findUnique({ where: { code: regionCode } });
        answered();
        if (!region) {
          issues.push({ sheet: 'Routes', row: sheetRow, message: `region "${regionCode}" not found` });
          continue;
        }
        // X-AUTH-3 / X-IMPORTS-1: as for regions. A route moved to another region
        // records both region codes.
        await prisma.$transaction(async (tx) => {
          const before = await tx.route.findUnique({
            where: { code },
            include: { region: { select: { code: true } } },
          });
          if (!before) {
            const created = await tx.route.create({ data: { code, name, regionId: region.id } });
            await writeAudit(tx, env, {
              action: 'CREATE',
              entityType: 'Route',
              entityId: created.id,
              after: { code, name, regionCode: region.code, batchId: batch.id },
              reason: 'account_import',
            });
          } else if (before.name !== name || before.regionId !== region.id) {
            await tx.route.update({ where: { id: before.id }, data: { name, regionId: region.id } });
            const was: Record<string, string> = {};
            const now: Record<string, string> = {};
            if (before.name !== name) {
              was.name = before.name;
              now.name = name;
            }
            if (before.regionId !== region.id) {
              was.regionCode = before.region.code;
              now.regionCode = region.code;
            }
            await writeAudit(tx, env, {
              action: 'UPDATE',
              entityType: 'Route',
              entityId: before.id,
              before: was,
              after: { ...now, batchId: batch.id },
              reason: 'account_import',
            });
          }
        });
        applied();
      } catch (err) {
        await failed('Routes', sheetRow, err, `route "${code}"`);
      }
    }
  }

  // 3) Users (two passes — supervisors first, then everyone else linking by username)
  if (usersSheet) {
    // Keep each row's ORIGINAL spreadsheet position so error messages point at
    // the real row (we process supervisors first, but 'row N' must still be the
    // line the steward sees in Excel). N05: the row number the parser read it
    // from — index + 2 is wrong after a blank line.
    const sortedRows = usersSheet.rows
      .map((row, origIdx) => ({ row, sheetRow: usersSheet.rowNumbers[origIdx] }))
      .sort((a, b) => {
        const order = ['MANAGER', 'STEWARD', 'SUPERVISOR', 'SALESMAN', 'VIEWER'];
        return order.indexOf(uc(a.row.role)) - order.indexOf(uc(b.row.role));
      });
    for (const { row, sheetRow } of sortedRows) {
      nextRow();
      if (stopped) {
        issues.push({ sheet: 'Users', row: sheetRow, message: ACCOUNT_ROW_NOT_PROCESSED });
        continue;
      }
      const username = lc(row.username);
      const fullName = String(row.full_name ?? row.fullName ?? row.name ?? '').trim();
      const roleStr = uc(row.role);
      const passwordRaw = String(row.password ?? '').trim();
      // QA-010: passwords must be EXPLICITLY requested via reset_password column,
      // OR provided ONLY for new users. Existing users keep their existing hash.
      const wantsReset =
        String(row.reset_password ?? row.resetPassword ?? '')
          .trim()
          .toLowerCase() === 'yes';
      // QA-011: role changes must be EXPLICITLY requested via change_role column.
      const wantsRoleChange =
        String(row.change_role ?? row.changeRole ?? '')
          .trim()
          .toLowerCase() === 'yes';
      // Owner decision 8 (review), as /users applies it: a route is taken from an
      // ACTIVE salesman only on change_route=yes, and a salesman's account is
      // given another person's full name only on change_name=yes.
      const wantsRouteChange =
        String(row.change_route ?? row.changeRoute ?? '')
          .trim()
          .toLowerCase() === 'yes';
      const wantsNameChange =
        String(row.change_name ?? row.changeName ?? '')
          .trim()
          .toLowerCase() === 'yes';
      const supUsername = lc(row.supervisor_username ?? row.supervisorUsername ?? '');
      const routeCode = uc(row.route_code ?? row.routeCode ?? '');
      const regionCodesRaw = String(row.region_codes ?? row.regionCodes ?? '').trim();
      // Launch fix: lower-cased, as /users stores it (services/users.ts), so the
      // case-sensitive unique index and the clash check below agree.
      const email = String(row.email ?? '').trim().toLowerCase() || null;
      const phone = String(row.phone ?? '').trim() || null;
      // Go-live credential policy: a row may force the person to choose a new
      // password at first login (AUTH-09). Only then is a SHORT initial password
      // accepted — the change-password screen enforces the 12-character rule on
      // the one they pick, so the weak value never outlives the first sign-in.
      const mustChange = /^(yes|true|1)$/i.test(
        String(row.must_change_password ?? row.mustChangePassword ?? '').trim()
      );

      if (!username || !fullName || !roleStr) {
        issues.push({
          sheet: 'Users',
          row: sheetRow,
          message: 'username, full_name, role required',
        });
        continue;
      }
      if (!VALID_ROLES.includes(roleStr as Role)) {
        issues.push({
          sheet: 'Users',
          row: sheetRow,
          message: `role "${roleStr}" not one of ${VALID_ROLES.join(', ')}`,
        });
        continue;
      }
      if (passwordRaw && passwordRaw.length < (mustChange ? 4 : 12)) {
        issues.push({
          sheet: 'Users',
          row: sheetRow,
          message: mustChange
            ? 'password must be 4+ chars (it is replaced at first login)'
            : 'password must be 12+ chars (or set must_change_password=yes)',
        });
        continue;
      }

      const role = roleStr as Role;

      try {
        // F-02 (Critical) — close THREE bypasses of QA-011:
        //
        // (a) Self-promotion guarded by id (not username). The previous string-
        //     compare on `username === me.username` failed when the calling
        //     Steward's username had different casing in DB or when the import
        //     row used a renamed username; both let the Steward escalate.
        //
        // (b) Steward cannot mint or upgrade a user to MANAGER or STEWARD by
        //     ANY path (new user OR existing). Promotion into the admin tier
        //     must go through the in-app `/users` UI run by an existing
        //     Manager. This blocks the "rogue Steward → rogue Manager →
        //     rubber-stamp every region's edits" CHAIN-01.
        //
        // (c) Steward cannot demote a peer Manager or Steward via import.
        //
        // We compare the incoming row's username case-insensitively against
        // the existing User.id's username so case differences don't bypass.
        //
        // One read of the stored account serves every check below and the audit
        // row's `before` (it used to be read twice, and its regions a third time).
        const existing = await prisma.user.findUnique({
          where: { username },
          include: {
            supervisor: { select: { username: true } },
            ownedRoute: { select: { code: true } },
            managedRegions: { select: { code: true } },
            // For the Users UI's rule that a Supervisor with reports keeps the role.
            reports: { select: { id: true } },
          },
        });
        answered();
        const isSelf = existing?.id === me.id;

        if (isSelf && wantsRoleChange && role !== me.role) {
          issues.push({
            sheet: 'Users',
            row: sheetRow,
            message: 'cannot change your own role via import',
          });
          continue;
        }
        // The Users UI's reset refuses one's own account (canMutateUser), so the
        // import does too: without it the Steward's own password changed here with
        // no current password given and no reuse check.
        if (isSelf && wantsReset) {
          issues.push({ sheet: 'Users', row: sheetRow, message: OWN_PASSWORD_RESET_ISSUE });
          continue;
        }
        // (b) New MANAGER / STEWARD via import — refuse outright. Forces the
        // Manager-driven /users UI for any admin-tier creation.
        if (!existing && (role === Role.MANAGER || role === Role.STEWARD)) {
          issues.push({
            sheet: 'Users',
            row: sheetRow,
            message: 'creating MANAGER or STEWARD via import is not permitted — use the Users UI',
          });
          continue;
        }
        // (b)/(c) Promote-to or mutate an existing admin via import — refuse.
        if (
          existing &&
          wantsRoleChange &&
          (role === Role.MANAGER ||
            role === Role.STEWARD ||
            existing.role === Role.MANAGER ||
            existing.role === Role.STEWARD) &&
          existing.role !== role
        ) {
          issues.push({
            sheet: 'Users',
            row: sheetRow,
            message:
              'promoting/demoting MANAGER or STEWARD via import is not permitted — use the Users UI',
          });
          continue;
        }
        // F08: without change_role=yes the row must name the role the account
        // already has. Every route and region effect below keys on `role`, so past
        // this point `role` is the role the account will have after the write.
        const mismatch = existing
          ? roleMismatchIssue({
              username,
              storedRole: existing.role,
              incomingRole: role,
              wantsRoleChange,
            })
          : null;
        if (mismatch) {
          issues.push({ sheet: 'Users', row: sheetRow, message: mismatch });
          continue;
        }
        const roleChanged = !!existing && existing.role !== role;
        // A Supervisor keeps the role while anyone still reports to them, as in
        // the Users UI (services/users.ts updateUserRoleCore).
        const withReports = existing
          ? supervisorReportsIssue({
              username,
              storedRole: existing.role,
              newRole: role,
              reports: existing.reports.length,
            })
          : null;
        if (withReports) {
          issues.push({ sheet: 'Users', row: sheetRow, message: withReports });
          continue;
        }

        // AUTH-06, as the Users UI applies it: an active SUPERVISOR or MANAGER, on
        // a new account and an existing one alike (both use supervisorId below).
        // Like the UI, it judges a supervisor being SET: a cell naming the one the
        // account already has changes nothing, so a manager deactivated since the
        // sheet was built does not hold back every row that still names him.
        let supervisorId: string | null = null;
        if (supUsername) {
          const sup = await prisma.user.findUnique({
            where: { username: supUsername },
            select: { id: true, role: true, isActive: true },
          });
          const unchanged = !!sup && !!existing && existing.supervisorId === sup.id;
          const badSupervisor = unchanged ? null : supervisorIssue({ supervisorUsername: supUsername, supervisor: sup });
          if (badSupervisor) {
            issues.push({ sheet: 'Users', row: sheetRow, message: badSupervisor });
            continue;
          }
          supervisorId = sup!.id; // supervisorIssue refuses a missing one
        }

        let ownedRouteId: string | null = null;
        let ownedRouteCode: string | null = null;
        let routeRegion: { id: string; code: string } | null = null;
        if (role === Role.SALESMAN) {
          if (!routeCode) {
            issues.push({ sheet: 'Users', row: sheetRow, message: 'salesman needs route_code' });
            continue;
          }
          const route = await prisma.route.findUnique({
            where: { code: routeCode },
            include: { region: { select: { code: true } } },
          });
          if (!route) {
            issues.push({
              sheet: 'Users',
              row: sheetRow,
              message: `route "${routeCode}" not found`,
            });
            continue;
          }
          ownedRouteId = route.id;
          ownedRouteCode = routeCode;
          routeRegion = { id: route.regionId, code: route.region.code };
        }
        // X-IMPORTS-2: never take a route from its salesman to park it on an
        // account that cannot sign in.
        const inactive = existing
          ? inactiveRouteIssue({
              username,
              isActive: existing.isActive,
              currentRouteId: existing.ownedRouteId,
              incomingRouteId: ownedRouteId,
              routeCode: ownedRouteCode,
            })
          : null;
        if (inactive) {
          issues.push({ sheet: 'Users', row: sheetRow, message: inactive });
          continue;
        }

        // Owner decision 8 (review): the rules /users applies to the same change
        // (lib/account-edit.ts), so a re-imported sheet cannot undo what the
        // Steward did there. Each holds the row back with nothing written.
        //
        // (1) A route has one salesman. It is taken from a deactivated holder (the
        // leaver) as before (F-18, below), but from an ACTIVE one only when the row
        // says change_route=yes — /users refuses it outright.
        const routeMoves = !!ownedRouteId && existing?.ownedRouteId !== ownedRouteId;
        if (routeMoves) {
          const taken = importRouteHolderIssue({
            username,
            routeCode: ownedRouteCode!,
            holder: await prisma.user.findUnique({
              where: { ownedRouteId: ownedRouteId! },
              select: { username: true, isActive: true },
            }),
            wantsRouteChange,
          });
          if (taken) {
            issues.push({ sheet: 'Users', row: sheetRow, message: taken });
            continue;
          }
        }
        // (2) The account is found by its sign-in name, which for a salesman is
        // his route's code — after a hand-over on /users, the joiner's. A row
        // that names someone else on a salesman's account is held back unless it
        // says change_name=yes: an older sheet used to write the leaver's name,
        // phone and supervisor onto the joiner.
        if (existing) {
          let named = importNameIssue({
            username,
            storedRole: existing.role,
            storedName: existing.fullName,
            rowName: fullName,
            wantsNameChange,
            retired: null,
          });
          if (named) {
            // The leaver's retired sign-in name (lib/account-edit.ts retiredUsername).
            const leaver = await prisma.user.findFirst({
              where: { username: { startsWith: `${username}.left.` } },
              orderBy: { username: 'desc' },
              select: { username: true },
            });
            if (leaver) {
              named = importNameIssue({
                username,
                storedRole: existing.role,
                storedName: existing.fullName,
                rowName: fullName,
                wantsNameChange,
                retired: leaver.username,
              });
            }
            issues.push({ sheet: 'Users', row: sheetRow, message: named! });
            continue;
          }
        }
        // (3) The supervisor covers the region of the route, judged as /users
        // judges it: when the supervisor, the route or the role changes. A blank
        // cell keeps the stored supervisor, who is judged against a new route.
        const keptSupervisorId = supervisorId ?? existing?.supervisorId ?? null;
        const supervisorChanges = !!supervisorId && supervisorId !== existing?.supervisorId;
        if (routeRegion && keptSupervisorId && (supervisorChanges || routeMoves || roleChanged)) {
          const s = await prisma.user.findUnique({
            where: { id: keptSupervisorId },
            select: {
              id: true,
              username: true,
              role: true,
              isActive: true,
              managedRegions: { select: { id: true } },
              reports: { select: { id: true, ownedRoute: { select: { regionId: true } } } },
            },
          });
          const cover = importSupervisorCoverIssue({
            username,
            supervisorUsername: s?.username ?? supUsername,
            supervisor: s
              ? {
                  id: s.id,
                  role: s.role,
                  isActive: s.isActive,
                  managedRegionIds: s.managedRegions.map((r) => r.id),
                  teamRegionIds: [
                    ...new Set(
                      s.reports
                        .filter((r) => r.id !== existing?.id)
                        .map((r) => r.ownedRoute?.regionId)
                        .filter((r): r is string => !!r)
                    ),
                  ],
                }
              : null,
            targetId: existing?.id ?? null,
            routeCode: ownedRouteCode!,
            routeRegionId: routeRegion.id,
            regionCode: routeRegion.code,
          });
          if (cover) {
            issues.push({ sheet: 'Users', row: sheetRow, message: cover });
            continue;
          }
        }
        // (4) His new-customer requests that are not in review (drafts, or sent
        // back) and were started on another route than the one this row leaves
        // him with: sent again, services/creates.ts would file them under the new
        // route. /users can withdraw them with the change; the import cannot.
        if (existing?.isActive && (existing.ownedRouteId ?? null) !== ownedRouteId) {
          const stranded = await prisma.customerEdit.count({
            where: {
              submittedById: existing.id,
              process: EditProcess.CREATE,
              state: { in: [EditState.DRAFT, EditState.NEEDS_CORRECTION] },
              ...(ownedRouteId
                ? { branchDrafts: { some: { routeId: { not: ownedRouteId } } } }
                : {}),
            },
          });
          if (stranded > 0) {
            issues.push({
              sheet: 'Users',
              row: sheetRow,
              message: strandedCreatesImportIssue(username, stranded),
            });
            continue;
          }
        }

        // QA-010 / QA-011: only set passwordHash + role on INSERT or when
        // explicitly requested. On a normal re-import, existing users keep
        // their existing password and role.
        let passwordHash: string;
        if (existing) {
          if (wantsReset) {
            if (!passwordRaw) {
              issues.push({
                sheet: 'Users',
                row: sheetRow,
                message: 'reset_password=yes but no password provided',
              });
              continue;
            }
            // B-15, as resetPasswordCore applies it: not the current password nor
            // one of the last five. Without it, and without the history rotation in
            // the transaction below, the person could choose the pre-reset password
            // again at the forced change — the one the reset was meant to retire.
            // A database fault is not a refusal: it goes to the row's catch.
            try {
              await assertPasswordNotReused(existing.id, existing.passwordHash, passwordRaw);
            } catch (e) {
              if (!(e instanceof ValidationError)) throw e;
              issues.push({ sheet: 'Users', row: sheetRow, message: passwordReusedIssue(username) });
              continue;
            }
            passwordHash = await bcrypt.hash(passwordRaw, 12);
          } else {
            passwordHash = existing.passwordHash;
          }
        } else {
          if (!passwordRaw) {
            issues.push({
              sheet: 'Users',
              row: sheetRow,
              message: 'new user needs a password',
            });
            continue;
          }
          passwordHash = await bcrypt.hash(passwordRaw, 12);
        }

        const update: Prisma.UserUpdateInput = {
          fullName,
          // X-IMPORTS-4: a blank email or phone cell keeps the stored value, the
          // rule the password, supervisor and region cells already follow. The
          // go-live builder writes both cells blank on every row, so a re-import
          // used to wipe contact details set when the account was created in the
          // Users UI. The import can set a new value but never clears one.
          email: email ?? undefined,
          phone: phone ?? undefined,
          // ownedRoute: a SALESMAN row always carries a resolved route (rows without
          // one continue'd above); a non-SALESMAN owns no route, so clear it (this
          // also correctly drops the route when a salesman is promoted).
          ownedRoute: ownedRouteId ? { connect: { id: ownedRouteId } } : { disconnect: true },
        };
        // A BLANK supervisor_username on a re-import means "keep the existing
        // supervisor" (mirrors the QA-010 password rule) — NOT unlink. A blank
        // column silently detaching a salesman's supervisor was a data-loss
        // footgun. supUsername present ⇒ supervisorId already resolved above.
        if (supUsername) update.supervisor = { connect: { id: supervisorId! } };
        // Only rotate password / role when explicitly authorised. A password reset
        // MUST also revoke live sessions (sessionsRevokedAt) so the old credential
        // cannot keep a session alive — same as services/users.ts resetPasswordCore.
        if (wantsReset) {
          update.passwordHash = passwordHash;
          update.sessionsRevokedAt = new Date();
        }
        // Gated the same way the password is, and for the same reason. Every row the
        // go-live builder writes carries must_change_password: yes, so a re-import —
        // which the runbook invites, to add a route or fix a name — used to re-arm
        // the forced change on everyone in the sheet, INCLUDING people who had long
        // since chosen their own password. Their next request bounces them to the
        // change-password screen and holds them there, and assertPasswordNotReused
        // refuses the last five hashes, so they cannot re-enter the password they
        // are already using: a field salesman is locked out mid-round by an
        // administrative re-import that changed nothing about them.
        //
        // Re-arm it only when this import is actually issuing a new password.
        if (mustChange && (!existing || wantsReset)) update.mustChangePassword = true;
        if (!existing || wantsRoleChange) update.role = role;
        // ENH-6: a role change ends the person's open sessions, as the Users UI's
        // does (services/users.ts updateUserRoleCore). Only a real change: a
        // re-import naming the role the account already has signs nobody out.
        if (roleChanged) update.sessionsRevokedAt = new Date();

        // Regions are resolved BEFORE anything is written.
        //
        // They used to be applied after the upsert, so a row with a bad code was
        // quarantined AFTER the account had been created — leaving a live, signable
        // account managing nothing while the report called the row an issue. An
        // empty managedRegions is fail-closed in every reader (lib/access.ts,
        // lib/permissions.ts, lib/customer-filters.ts, the approvals page), so that
        // account signs in and sees an empty queue for good.
        //
        // `regionIds === null` means "leave the regions this user already has",
        // which is what a blank cell means for an existing user — the same rule the
        // password and supervisor columns follow.
        const regionScoped = role === Role.MANAGER || role === Role.ACCOUNTANT;
        let regionIds: string[] | null = null;
        let regionCodes: string[] | null = null;
        if (regionScoped) {
          const codes = regionCodesRaw
            .split(',')
            .map((c) => c.trim().toUpperCase())
            .filter(Boolean);
          if (codes.length > 0) {
            const regions = await prisma.region.findMany({ where: { code: { in: codes } } });
            const found = new Set(regions.map((r) => r.code));
            const unknown = codes.filter((c) => !found.has(c));
            if (unknown.length > 0) {
              // Quarantine rather than write what did resolve: `set:` REPLACES the
              // relation, so applying the good half would silently shrink the
              // account's coverage. The Routes sheet quarantines the same mistake.
              issues.push({
                sheet: 'Users',
                row: sheetRow,
                message: `region code(s) not found: ${unknown.join(', ')} — nothing was written for "${username}". Import the Regions sheet first, or correct the code.`,
              });
              continue;
            }
            regionIds = regions.map((r) => r.id);
            regionCodes = regions.map((r) => r.code).sort();
          } else if (regionCodesRaw) {
            // The cell is not empty and yet yields no region code — "," or ", ,".
            // It used to be truthy enough to reach `set: []` and wipe the account.
            //
            // Do not fold this into "blank means keep what you had": the operator
            // wrote something and meant it to take effect. Accepting it silently
            // because the account happens to already have regions would report a
            // clean row for an instruction that did nothing.
            issues.push({
              sheet: 'Users',
              row: sheetRow,
              message: `region_codes for "${username}" was "${regionCodesRaw}", which contains no region code. Nothing was written — correct the cell, or leave it empty to keep the regions this account already has.`,
            });
            continue;
          } else {
            // Genuinely blank. That means "keep what you had", the same rule the
            // password and supervisor columns follow — but it may only mean that
            // when there IS something to keep. Decided on the account's real state
            // rather than on whether this import created it, so a re-import cannot
            // keep waving through an account that is already blind.
            if (!existing || existing.managedRegions.length === 0) {
              issues.push({
                sheet: 'Users',
                row: sheetRow,
                message: `${role} "${username}" manages no region, so it can see nothing and clear no approval step. Set region_codes and re-import. Nothing was written.`,
              });
              continue;
            }
          }
        }

        // Launch fix: User.email's unique index is case-sensitive, so an address
        // another account holds in other capitals got through and two accounts
        // shared one mailbox. Checked ignoring case, in the words the unique
        // clash itself produces (lib/account-import.ts accountRowFailure), which
        // name the field and never the value.
        if (email) {
          const clash = await prisma.user.findFirst({
            where: { email: { equals: email, mode: 'insensitive' }, NOT: { username } },
            select: { id: true },
          });
          if (clash) {
            issues.push({
              sheet: 'Users',
              row: sheetRow,
              message: `nothing was written for "${username}": its email is already used by another record.`,
            });
            continue;
          }
        }

        const data: Prisma.UserCreateInput = {
          username,
          passwordHash,
          fullName,
          role,
          email,
          phone,
          mustChangePassword: mustChange,
        };
        if (supervisorId) data.supervisor = { connect: { id: supervisorId } };
        if (ownedRouteId) data.ownedRoute = { connect: { id: ownedRouteId } };
        // F07: the regions go in with the account write itself. They used to be a
        // separate update after the transaction had committed, so a failure there
        // quarantined a row whose account, role and route had already changed.
        if (regionIds) {
          update.managedRegions = { set: regionIds.map((id) => ({ id })) };
          data.managedRegions = { connect: regionIds.map((id) => ({ id })) };
        }

        // X-IMPORTS-1: the account before and after this row, for its audit row
        // (lib/account-import.ts decides which of it the ledger may hold).
        const before: AccountState | null = existing
          ? {
              fullName: existing.fullName,
              role: existing.role,
              supervisor: existing.supervisor?.username ?? null,
              route: existing.ownedRoute?.code ?? null,
              regions: existing.managedRegions.map((r) => r.code).sort(),
              mustChangePassword: existing.mustChangePassword,
              email: existing.email,
              phone: existing.phone,
            }
          : null;
        const after: AccountState = {
          fullName,
          role,
          supervisor: supUsername || (before?.supervisor ?? null),
          route: ownedRouteCode,
          regions: regionCodes ?? before?.regions ?? [],
          mustChangePassword: before
            ? before.mustChangePassword || update.mustChangePassword === true
            : mustChange,
          email: before ? (email ?? before.email) : email,
          phone: before ? (phone ?? before.phone) : phone,
        };

        // F-18: a salesman row takes its route from whoever owns it now — a
        // deactivated owner, or an active one on change_route=yes (owner decision
        // 8, above) — and the move is audited so the Manager can see "salesman.X
        // used to own this route, salesman.Y owns it now".
        //
        // It happens HERE, with the account write, and not where the route is
        // resolved. It used to run before the row's remaining checks, so a row
        // then skipped for a missing password or a bad region code — or whose
        // upsert failed on a duplicate email — had already taken the route off
        // its owner and written an audit row naming a user that was never
        // created: the route was left with no salesman at all. In one
        // transaction the two stand or fall together.
        //
        // F07 / X-IMPORTS-1: and so does every audit row the account write owes.
        // The password and role audits used to be written after this transaction
        // had committed, so a failed insert quarantined a row whose new hash, role
        // and route were already live — and a re-run, finding the role already
        // changed, never wrote the role audit at all.
        //
        // Each of those rows names the batch, as the account_import rows do: a
        // reset or a role change that alters nothing else writes no account_import
        // row, and the batch's IMPORT summary holds counts only.
        await prisma.$transaction(
          async (tx) => {
            if (ownedRouteId) {
              const displacedOwners = await tx.user.findMany({
                where: { ownedRouteId, NOT: { username } },
                select: { id: true, isActive: true },
              });
              // Owner decision 8 (review): re-checked here, as /users re-checks its
              // hand-over — the holder may have been enabled since the check above.
              if (!wantsRouteChange && displacedOwners.some((u) => u.isActive)) {
                throw new Error(
                  `route ${ownedRouteCode} is now worked by an active salesman; set change_route to yes to move it`
                );
              }
              if (displacedOwners.length > 0) {
                await tx.user.updateMany({
                  where: { ownedRouteId, NOT: { username } },
                  data: { ownedRouteId: null },
                });
                // A loop, not createMany: writeAudit is the only writer of ip and
                // userAgent and it writes one row at a time. That costs nothing
                // here — User.ownedRouteId is @unique, so at most ONE user can own
                // a route and this list is 0 or 1 rows by construction.
                for (const u of displacedOwners) {
                  await writeAudit(tx, env, {
                    action: 'REASSIGN',
                    entityType: 'User',
                    entityId: u.id,
                    before: { ownedRouteCode } as unknown as Prisma.InputJsonValue,
                    after: {
                      ownedRouteCode: null,
                      batchId: batch.id,
                    } as unknown as Prisma.InputJsonValue,
                    reason: `route ${ownedRouteCode} reassigned to ${username} via import`,
                  });
                }
              }
            }
            const user = await tx.user.upsert({
              where: { username },
              update,
              create: data,
            });
            if (!before) {
              await writeAudit(tx, env, {
                action: 'CREATE',
                entityType: 'User',
                entityId: user.id,
                after: accountCreateAudit(username, after, batch.id),
                reason: 'account_import',
              });
              return;
            }
            if (wantsReset && existing) {
              // B-15, as resetPasswordCore does: the OLD hash into PasswordHistory,
              // pruned to five, in the same transaction as the new one.
              await rotatePasswordHistory(tx, user.id, existing.passwordHash);
              await writeAudit(tx, env, {
                action: 'UPDATE',
                entityType: 'User',
                entityId: user.id,
                after: { batchId: batch.id } as unknown as Prisma.InputJsonValue,
                reason: 'password_reset_via_import',
              });
            }
            if (roleChanged) {
              await writeAudit(tx, env, {
                action: 'UPDATE',
                entityType: 'User',
                entityId: user.id,
                before: { role: before.role } as unknown as Prisma.InputJsonValue,
                after: { role, batchId: batch.id } as unknown as Prisma.InputJsonValue,
                reason: 'role_change_via_import',
              });
            }
            const change = accountUpdateAudit(username, before, after, batch.id);
            if (change) {
              await writeAudit(tx, env, {
                action: 'UPDATE',
                entityType: 'User',
                entityId: user.id,
                before: change.before,
                after: change.after,
                reason: 'account_import',
              });
            }
          },
          { timeout: 20_000, maxWait: 10_000 }
        );
        applied();
      } catch (err) {
        await failed('Users', sheetRow, err, `"${username}"`);
      }
    }
  }

  // X-IMPORTS-3: the batch's counts and its issue rows land together. Every row
  // counted as applied has committed by now, so a failure here must not reach
  // runAction, whose answer to a database fault is "Nothing was saved".
  let recorded = true;
  // Why the report was not saved, when the database did answer (a Prisma code or
  // an error name). Unset when it was saved, or when the database stopped
  // answering — only then does the Steward read "the database stopped answering".
  let reportFault: string | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.importBatch.update({
        where: { id: batch.id },
        data: {
          status: 'PROMOTED',
          cleanRows: cleanCount,
          quarantinedRows: issues.length,
          promotedRows: cleanCount,
        },
      });

      // Persist issues as ImportRow rows for review
      if (issues.length > 0) {
        await tx.importRow.createMany({
          data: issues.map((iss) => ({
            batchId: batch.id,
            // Launch fix: the row Excel shows (N05), not the issue's index — the
            // batch page's Row column read #1, #2… The sheet is in raw and issues.
            rowNumber: iss.row,
            raw: iss as unknown as Prisma.InputJsonValue,
            state: ImportRowState.QUARANTINED,
            issues: [{ message: iss.message, sheet: iss.sheet, row: iss.row }] as Prisma.InputJsonValue,
          })),
        });
      }
    });
  } catch (err) {
    recorded = false;
    const rawCode = (err as { code?: unknown } | null)?.code;
    const code = typeof rawCode === 'string' ? rawCode : '';
    const fields = errorLogFields(err);
    const transient = isTransientDbError(err, code);
    logger.error(
      {
        code: rawCode,
        ...fields,
        transient,
        batchId: batch.id,
        clean: cleanCount,
        issues: issues.length,
      },
      'import.account.not_recorded'
    );
    if (!transient) {
      reportFault = code || fields.errName;
      await reportAccountImportFault(err, 'import.account.not_recorded');
    }
  }

  // F-19: per-batch audit summary for the Account master too.
  //
  // DG-06/07: the swallow STAYS here, unlike the exports. This is a summary, not
  // the only record — ImportBatch above already carries status PROMOTED and the
  // three counters, and the quarantined rows are persisted as ImportRow. It also
  // runs after everything has committed, so throwing would tell the Steward a
  // fully-successful import failed; the natural re-run would hold back every
  // password reset in the file as a reused password, which reads as the resets
  // having failed. But it no longer swallows SILENTLY — a lost summary is now
  // visible in the logs.
  //
  // Not attempted when the batch itself could not be recorded: the database has
  // just refused a write, and every applied row that changed anything already
  // carries its own audit row, written with it.
  if (recorded) {
    await writeAudit(null, env, {
      action: 'IMPORT',
      entityType: 'ImportBatch',
      entityId: batch.id,
      after: {
        kind: 'ACCOUNT',
        clean: cleanCount,
        issues: issues.length,
        ...(stopped ? { stopped: true } : {}),
      } as unknown as Prisma.InputJsonValue,
      reason: 'account_master_upload',
    }).catch((e) => {
      logger.warn({ err: (e as Error).message?.slice(0, 80) }, 'import.audit_failed');
    });
  }

  logger.info(
    { batchId: batch.id, clean: cleanCount, issues: issues.length, stopped, recorded },
    'import.account.complete'
  );
  revalidatePath('/import');
  // Launch fix: regions, routes and people from this sheet reach the cached
  // filter lists (lib/reference-data.ts) now, not up to five minutes later.
  // Before the throw below: rows applied before an interruption are live too.
  for (const tag of ['ref:regions', 'ref:routes', 'ref:users']) revalidateTag(tag);
  if (stopped || !recorded) {
    throw new AppError(
      'IMPORT_INTERRUPTED',
      accountImportInterruptedMessage({
        applied: cleanCount,
        uncertain,
        notApplied: issues.length - uncertain,
        recorded,
        reportFault,
      }),
      503
    );
  }
  return { batchId: batch.id, clean: cleanCount, issues: issues.length };
}

// ── Customer master import ─────────────────────────────────────────────────
// Single sheet (default first) with at least: cust_code, cust_name.
// Optional: branch_code, branch_name, sales_region, route, address, phone,
//           contact_person, cr_no, payment_terms (CASH/CREDIT).
//
// Behavior:
//   - Each row is one branch. Multiple rows with same cust_code create one
//     parent customer + many branches.
//   - Customers without sales_region/route map to "UNASSIGNED" route.
//   - Phone is normalized; phone collision across DIFFERENT cust_codes is flagged.
//
// Strategy: parse-only (rows go into ImportRow as PENDING). Steward then
// promotes a batch when ready. v1.1 will add an inline review screen; for
// now, we expose a "promote" action that creates customers in bulk.

export async function uploadCustomerMasterAction(
  formData: FormData
): SafeAction<{ batchId: string; clean: number; quarantined: number }> {
  return runAction(() => uploadCustomerMasterCore(formData));
}

async function uploadCustomerMasterCore(
  formData: FormData
): Promise<{ batchId: string; clean: number; quarantined: number }> {
  const me = await requireSteward();
  // F-07: rate-limit imports per Steward. Two Stewards racing the same file
  // (or a single Steward double-tapping the upload button) was previously
  // unguarded and led to interleaved upserts.
  const lim = await checkLimit(`import:${me.id}`, { capacity: 3, refillPerSec: 0.05 });
  if (!lim.ok) {
    throw new RateLimitError(`Wait ${lim.retryAfterSec}s before another import.`);
  }
  const file = formData.get('file');
  if (!(file instanceof File)) throw new ValidationError({ file: 'No file uploaded.' });
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ValidationError({
      file: `File is too large (${Math.round(file.size / 1024)} KB). Maximum is 5 MB.`,
    });
  }
  const buf = Buffer.from(await file.arrayBuffer());

  let sheets;
  try {
    sheets = await parseWorkbook(buf);
  } catch (err) {
    throw new ValidationError({ file: `Could not read .xlsx: ${(err as Error).message}` });
  }
  const sheet = sheets[0];
  if (!sheet || sheet.rows.length === 0) {
    throw new ValidationError({ file: 'Workbook is empty.' });
  }
  // N05: a repeated heading refuses the file only on the sheet this upload reads.
  const repeated = duplicateHeadingIssue(sheet);
  if (repeated) throw new ValidationError({ file: `Could not read .xlsx: ${repeated}` });

  const batch = await prisma.importBatch.create({
    data: {
      filename: file.name,
      kind: 'CUSTOMER',
      uploadedById: me.id,
      status: 'PARSING',
      totalRows: sheet.rows.length,
    },
  });

  const importRows: Prisma.ImportRowCreateManyInput[] = [];
  let clean = 0;
  let quarantined = 0;
  // F-04: collision maps inside the file (lib/import-row-check.ts fileCollisions)
  // and against the live master below, so the parse step queues duplicates for
  // review instead of silently P2002-failing on promote.
  // N05: the Excel row number the parser read the row from — not index + 2, which
  // is wrong for every row after the first blank line (lib/excel.ts).
  const sheetRows = sheet.rows.map((row, i) => ({ row: row as SheetRow, rowNumber: sheet.rowNumbers[i] }));
  const { phonesInFile, crsInFile } = fileCollisions(sheetRows);
  // Accepted `channel` codes — the Channel table's keys, read once per upload.
  const channelKeys = new Set(
    (await prisma.channel.findMany({ select: { key: true } })).map((c) => c.key.toUpperCase())
  );
  // Against the live master: one query each (lib/import-master-lookup.ts).
  const { masterPhones, masterCrs } = await masterCollisionMaps(
    [...phonesInFile.keys()],
    [...crsInFile.keys()]
  );

  // The per-row rules live in lib/import-row-check.ts, shared with the Steward's
  // in-app fix of a held-back row (item 20), so the two can never disagree.
  const ctx = { channelKeys, phonesInFile, crsInFile, masterPhones, masterCrs };
  for (const [i, row] of sheet.rows.entries()) {
    const { parsed, issues } = checkCustomerRow(row as SheetRow, ctx);

    importRows.push({
      batchId: batch.id,
      rowNumber: sheet.rowNumbers[i],
      raw: row as unknown as Prisma.InputJsonValue,
      parsed: parsed as unknown as Prisma.InputJsonValue,
      issues: issues.length > 0 ? (issues as unknown as Prisma.InputJsonValue) : undefined,
      state: issues.length > 0 ? ImportRowState.QUARANTINED : ImportRowState.CLEAN,
    });
    if (issues.length > 0) quarantined++;
    else clean++;
  }

  await prisma.importRow.createMany({ data: importRows });
  await prisma.importBatch.update({
    where: { id: batch.id },
    data: { status: 'READY', cleanRows: clean, quarantinedRows: quarantined },
  });
  revalidatePath('/import');
  return { batchId: batch.id, clean, quarantined };
}

/**
 * RK-3: one call promotes as much of a batch as fits in a time slice.
 * `done` is false while CLEAN rows remain — the caller re-invokes until it is true.
 */
export type PromoteSliceResult = {
  promoted: number;
  /** customers (groups) that failed, not rows — `promoted` counts rows. */
  failed: number;
  /** rows left CLEAN because the DB faltered; the next slice retries them. */
  deferred: number;
  remaining: number;
  done: boolean;
  /**
   * Opaque continuation token. The caller MUST pass it back on the next slice: it
   * both proves this run still owns the batch (so it can carry on without waiting
   * out its own lease) and stops a run that has already lost the batch from
   * carrying on regardless. Absent once `done`.
   */
  leaseToken?: string;
};

/**
 * How long a single promote invocation may work before yielding. The budget is
 * checked between customers, so the true worst case is this PLUS one full
 * transaction (20s) plus its connection wait — sized to stay inside vercel.json's
 * `maxDuration: 60` so a slice always commits its progress instead of being killed.
 */
function promoteSliceBudgetMs(): number {
  const raw = Number(process.env.PROMOTE_SLICE_BUDGET_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 15_000;
  // Clamped: a misconfigured env var must not be able to push a slice past the
  // function limit (budget + one 20s transaction + its connection wait).
  return Math.min(raw, 25_000);
}
/**
 * Lease lifetime while a slice is executing. MUST exceed `maxDuration` — otherwise
 * a slice still running could have its lease expire and a second worker would start
 * on the same batch.
 */
const PROMOTE_LEASE_MS = 90_000;
/**
 * Lease lifetime BETWEEN slices of the same run. The run comes straight back (well
 * inside this), so the batch keeps reading as "in progress" rather than flickering
 * to "interrupted" between every pass — while an abandoned run still frees the
 * batch quickly instead of holding it for the full lease.
 */
const PROMOTE_HANDOFF_GRACE_MS = 20_000;

type LaneBranch = {
  sheetCode: string | null;
  branchCode: string;
  branchName: string;
  regionId: string;
  routeId: string;
  address: string;
  dayOfVisit: string | null;
  status: string | null;
  nameGiven: boolean;
  routeResolved: boolean;
  sheetAddress: string | null;
  fixedInApp: boolean;
};

/**
 * What a row would change on the stored branch: the cells it gives (a blank
 * cell gives nothing, item 20) that the branch does not already hold. The
 * refresh lane names them when it does not apply them; the full lane leaves a
 * branch they are empty for unwritten, so its version and updatedAt stay as
 * they were (F21, auditor recheck 2026-09-27).
 *
 * The region is not a cell: the row's region is its resolved route's region
 * now. The B-19 trigger refuses a Branch write whose region is not its route's,
 * but nothing fires when the ACCOUNT import moves a route to another region, so
 * the branches on that route keep the old one until something writes their
 * route again. The full lane passes the stored region, so a branch whose
 * region is not its route's is written, which puts it back in line — as the
 * unconditional upsert did on every re-import before F21 skipped unchanged
 * branches (post-merge review of phase 2, finding 6). The ~3,300 pilot-seeded
 * customers carry no Temix code and always take that lane. The refresh lane
 * passes none: a plain row there changes no branch, and its note lists only
 * what the row itself states.
 */
function differingBranchCells(
  r: LaneBranch,
  stored: {
    branchName: string;
    routeId: string;
    /** The full lane's owner read only; see above. */
    regionId?: string;
    address: string;
    dayOfVisit: string | null;
    status: string;
  }
): string[] {
  const differs: string[] = [];
  if (r.nameGiven && r.branchName !== stored.branchName) differs.push('branch name');
  if (r.sheetAddress && r.sheetAddress !== stored.address) differs.push('address');
  if (r.routeResolved && r.routeId !== stored.routeId) differs.push('route');
  if (r.routeResolved && stored.regionId !== undefined && r.regionId !== stored.regionId) {
    differs.push('region');
  }
  if (r.dayOfVisit && r.dayOfVisit !== stored.dayOfVisit) differs.push('visit day');
  if (r.status && r.status !== stored.status) differs.push('status');
  return differs;
}

/**
 * The branch half of a Temix refresh group — owner decision 2026-09-25,
 * "branch only". The refresh itself writes the Temix-owned customer fields and
 * nothing else about the customer. A row the Data Steward FIXED IN THE APP
 * (services/import-fixes.ts) then creates its branch when no branch anywhere
 * has the code, or updates it from the cells the row supplied — a held-back
 * branch row of a go-live customer used to land nothing at all.
 *
 * A plain file row changes no branch, and says so. The file cannot tell a
 * Steward's correction from an inbound Temix refresh or an old copy of the
 * go-live master, and branches are the CRM's: letting such a file create or
 * overwrite them would undo changes approved in the app since, and would turn
 * a Temix acknowledgement back into a pending upload. No row moves a branch
 * from another customer, revives one from the archive, or guesses the branch
 * of a row with no branch_code.
 *
 * A row FIXED IN THE APP that cannot be applied — no branch_code, a code that
 * belongs to another customer, an archived branch — throws a CROSSWALK error,
 * so the customer is REJECTED and the Steward can correct its branch_code
 * (lib/import-row-fix.ts offers that cell for these messages, which must not
 * mention Temix). It used to be closed as PROMOTED with a note: every go-live
 * head-office row has a blank branch_code, so fixing one held back for its
 * phone loaded nothing and could never be fixed again (pre-merge review).
 *
 * Returns, per row, a note for the Steward (or null) and whether its branch
 * was written. A branch written here changes what Temix holds, so the customer
 * is queued for the next batch, as an approved edit or a merge queues it. And
 * the customer's updatedAt moves, because the master export's "updated since"
 * filter reads the CUSTOMER's updatedAt (services/exports.ts), not the branch's.
 */
type LaneOutcome = { notes: Array<string | null>; written: boolean[] };

async function refreshLaneBranches(
  tx: Prisma.TransactionClient,
  args: { customerId: string; custCode: string; resolved: LaneBranch[]; me: string }
): Promise<LaneOutcome> {
  const { customerId, resolved, me } = args;
  const notes: Array<string | null> = [];
  const written: boolean[] = [];
  const skip = (note: string | null) => {
    notes.push(note);
    written.push(false);
  };
  for (const r of resolved) {
    if (!r.sheetCode) {
      if (r.fixedInApp) {
        throw new Error(
          'CROSSWALK:a row fixed in the app has no branch_code — the import cannot tell which branch it is; add branch_code (a code this customer does not use yet creates a new branch); steward review'
        );
      }
      skip('no branch_code — the import cannot tell which branch this row is, so no branch was changed');
      continue;
    }
    // As on the ordinary lane: a code the Steward typed that is already another
    // customer's must not be quietly re-prefixed into a new branch of this one.
    if (r.fixedInApp && r.sheetCode !== r.branchCode) {
      const rawOwner = await tx.branch.findUnique({
        where: { branchCode: r.sheetCode },
        select: { customerId: true, customer: { select: { nmwcCode: true } } },
      });
      if (rawOwner && rawOwner.customerId !== customerId) {
        throw new Error(
          `CROSSWALK:branch_code ${r.sheetCode} already belongs to ${rawOwner.customer.nmwcCode} — steward review`
        );
      }
    }
    const found = await tx.branch.findUnique({
      where: { branchCode: r.branchCode },
      select: {
        id: true,
        customerId: true,
        deletedAt: true,
        branchName: true,
        routeId: true,
        address: true,
        dayOfVisit: true,
        status: true,
        customer: { select: { nmwcCode: true } },
      },
    });
    if (!found) {
      if (!r.fixedInApp) {
        skip(
          `branch ${r.branchCode} is not in the master and was not added — a re-import does not add branches to a customer linked to Temix; fix the held-back row on its batch page instead`
        );
        continue;
      }
      await tx.branch.create({
        data: {
          branchCode: r.branchCode,
          branchName: r.branchName,
          regionId: r.regionId,
          routeId: r.routeId,
          address: r.address,
          customerId,
          dayOfVisit: (r.dayOfVisit as DayOfWeek | null) ?? null,
          status: (r.status as CustomerStatus | null) ?? 'ACTIVE',
          lastStatusChangeAt: r.status === 'CLOSED' ? new Date() : null,
          createdById: me,
          lastEditedById: me,
        },
      });
      notes.push(null);
      written.push(true);
      continue;
    }
    if (found.customerId !== customerId) {
      if (r.fixedInApp) {
        throw new Error(
          `CROSSWALK:branch_code ${r.branchCode} already belongs to ${found.customer.nmwcCode} — steward review`
        );
      }
      skip(`branch ${r.branchCode} belongs to customer ${found.customer.nmwcCode} and was not moved`);
      continue;
    }
    if (found.deletedAt) {
      if (r.fixedInApp) {
        throw new Error(
          `CROSSWALK:branch_code ${r.branchCode} is archived and is not revived — use another branch_code; steward review`
        );
      }
      skip(`branch ${r.branchCode} was archived and was not revived`);
      continue;
    }
    const differs = differingBranchCells(r, found);
    if (differs.length === 0) {
      skip(null);
      continue;
    }
    if (!r.fixedInApp) {
      skip(
        `branch ${r.branchCode}: ${differs.join(', ')} in this row differ from the master and were not applied — a re-import does not change an existing branch of a customer linked to Temix; change it on the customer page`
      );
      continue;
    }
    await tx.branch.update({
      where: { id: found.id },
      data: {
        branchName: r.nameGiven ? r.branchName : undefined,
        regionId: r.routeResolved ? r.regionId : undefined,
        routeId: r.routeResolved ? r.routeId : undefined,
        address: r.sheetAddress ?? undefined,
        dayOfVisit: (r.dayOfVisit as DayOfWeek | null) ?? undefined,
        status: (r.status as CustomerStatus | null) ?? undefined,
        lastStatusChangeAt: r.status && r.status !== found.status ? new Date() : undefined,
        lastEditedById: me,
        // B-05 / F21: a writer that read this branch before the import committed
        // (applyEditChanges' versioned updateMany) fails instead of writing over it.
        version: { increment: 1 },
      },
    });
    notes.push(null);
    written.push(true);
  }
  if (written.some(Boolean)) {
    await tx.customer.updateMany({
      where: { id: customerId, temixSyncState: { in: ['SYNCED', 'UPLOADED'] } },
      data: { temixSyncState: 'PENDING_UPLOAD', temixSyncPendingSince: new Date() },
    });
    // The requeue above matches nothing on a customer already PENDING_UPLOAD,
    // and on the branch-only lane nothing else writes the customer through
    // Prisma (the rescore is raw SQL), so its updatedAt stayed put and an
    // "updated since" export left out the branch written here (review of
    // phase 2). updatedAt only — not `version` nor lastEditedById: none of the
    // customer's own fields changed, and lastEditedById would change who the
    // customer reads as last edited by.
    await tx.customer.update({ where: { id: customerId }, data: { updatedAt: new Date() } });
  }
  return { notes, written };
}

/**
 * Put each refresh row's branch note on the row as a '_lane' issue — and a
 * row's `extra` (what a fixed row did not write) the same way. The sub-channel
 * a full-lane channel change cleared (F16, on the lead row) is a
 * '_subchannel' issue of its own: that row's branch WAS written, and the batch
 * page labels '_lane' "Branch not updated" (lib/import-rows-view.ts). The
 * group's route/region warnings go only on rows whose branch was actually
 * written — on a row left as it was they would say something false.
 * Advisory: the caller ignores a failure here, as it does for the ordinary
 * lane's '_resolve' warnings.
 */
type RowNote = {
  note: string | null;
  written: boolean;
  extra?: string | null;
  subChannel?: string | null;
};

async function writeLaneNotes(
  rowIds: string[],
  notes: RowNote[],
  resolveErrors: string[]
): Promise<void> {
  for (const [i, rowId] of rowIds.entries()) {
    const n = notes[i];
    const issues = [
      ...(n?.note ? [{ field: '_lane', message: n.note }] : []),
      ...(n?.extra ? [{ field: '_lane', message: n.extra }] : []),
      ...(n?.subChannel ? [{ field: '_subchannel', message: n.subChannel }] : []),
      ...(n?.written && !n.note ? resolveErrors.map((m) => ({ field: '_resolve', message: m })) : []),
    ];
    if (issues.length === 0) continue;
    await prisma.importRow.update({
      where: { id: rowId },
      data: { issues: issues as Prisma.InputJsonValue },
    });
  }
}

export async function promoteCustomerBatchAction(
  formData: FormData
): SafeAction<PromoteSliceResult> {
  return runAction(() => promoteCustomerBatchCore(formData));
}

async function promoteCustomerBatchCore(formData: FormData): Promise<PromoteSliceResult> {
  const me = await requireSteward();
  // One envelope per slice, read once up front — before the lease claim and
  // before the per-group interactive transaction, so no header work happens
  // while a transaction is held open (see generateTemixBatchCore).
  const env = await getAuditEnvelope(me.id);
  const batchId = String(formData.get('batchId') ?? '');
  if (!batchId) throw new ValidationError({ batchId: 'required' });

  // Kind is checked BEFORE the claim: an ACCOUNT batch must never be moved into
  // PROMOTING (a state the customer resume path owns) just to be rejected.
  const preflight = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { kind: true, uploadedAt: true },
  });
  if (!preflight) throw new ValidationError({ batchId: 'not found' });
  if (preflight.kind !== 'CUSTOMER')
    throw new ValidationError({ batchId: 'not a customer import' });

  const now = new Date();
  // The token identifies THIS slice, not merely this user — the same steward in two
  // tabs must not be able to pass for one another. Every lease write is guarded by
  // it, so a slow worker that wakes up after its lease was taken over cannot clear
  // the new owner's lease and silently break mutual exclusion.
  const priorToken = String(formData.get('leaseToken') ?? '');
  const leaseToken = `${me.id}:${randomUUID()}`;
  // F-07 + RK-3: claim the batch atomically. This single compare-and-set covers the
  // first slice (READY → PROMOTING), a resume of an abandoned batch (PROMOTING with
  // no live lease), and this run continuing to its own next slice (matching token,
  // which is why a run need not wait out the lease it just set). Two Stewards, a
  // double-click, or a stray retry cannot interleave: exactly one caller gets count=1.
  const claim = await prisma.importBatch.updateMany({
    where: {
      id: batchId,
      OR: [
        { status: 'READY' },
        // Nothing writes FAILED any more; accepting it lets a batch left behind by
        // the old single-pass promote be recovered rather than stranded forever.
        { status: 'FAILED' },
        { status: 'PROMOTING', promoteLeaseUntil: null },
        { status: 'PROMOTING', promoteLeaseUntil: { lt: now } },
        ...(priorToken ? [{ status: 'PROMOTING' as const, promoteLeaseBy: priorToken }] : []),
      ],
    },
    data: {
      status: 'PROMOTING',
      promoteLeaseBy: leaseToken,
      promoteLeaseUntil: new Date(now.getTime() + PROMOTE_LEASE_MS),
    },
  });
  if (claim.count === 0) {
    const cur = await prisma.importBatch.findUnique({
      where: { id: batchId },
      select: { status: true, promoteLeaseUntil: true },
    });
    // A live lease is "someone is promoting right now", not "wrong state" — say so,
    // otherwise a steward watching a slow load thinks the batch is broken.
    if (cur?.status === 'PROMOTING' && cur.promoteLeaseUntil && cur.promoteLeaseUntil > now) {
      throw new ValidationError({
        batchId: 'This batch is being promoted right now — wait for it to finish, then resume.',
      });
    }
    throw new ValidationError({
      batchId: `Batch is in state ${cur?.status ?? '<missing>'} — only READY or interrupted batches can be promoted.`,
    });
  }
  // RK-3: the lease serializes ONE batch, but the QA P-01 branch-steal guard is a
  // read-then-upsert whose safety argument rests on promote being serialized across
  // the whole master ("batch promote is serialized by the atomic claim"). Two
  // DIFFERENT batches promoting at once would reopen that window — and RK-3 stretched
  // it from a single request to minutes, while actively inviting the sequence that
  // triggers it (upload a corrected sheet while the first batch is still resumable).
  // So refuse to run a second concurrent promote; fail closed.
  const otherLive = await prisma.importBatch.findFirst({
    where: {
      id: { not: batchId },
      kind: 'CUSTOMER',
      status: 'PROMOTING',
      promoteLeaseUntil: { gt: new Date() },
    },
    select: { id: true, filename: true },
  });
  if (otherLive) {
    // Release the claim we just took so this batch is not left holding a lease.
    await prisma.importBatch
      .updateMany({
        where: { id: batchId, promoteLeaseBy: leaseToken },
        data: { promoteLeaseBy: null, promoteLeaseUntil: null },
      })
      .catch(() => {});
    throw new ValidationError({
      batchId: `Another customer import ("${otherLive.filename}") is being promoted right now. Only one may run at a time — wait for it to finish, then resume this one.`,
    });
  }
  // final-hunt #23 (revised for RK-3): once claimed, any UNEXPECTED throw must not
  // leave the batch holding a lease nobody owns — it would be unresumable until the
  // lease expired. Release the lease in the catch; the batch stays PROMOTING, which
  // now means "interrupted, resumable" rather than a dead end.
  try {
    // RK-3: reference data is read ONCE per slice. It used to be a findUnique for
    // the region AND a findUnique for the route on EVERY row — 2 sequential network
    // round trips per row, which on a 3,300-row master was the single largest cost
    // in the whole promote (~6,600 queries before any work happened).
    const [allRegions, allRoutes] = await Promise.all([
      prisma.region.findMany({ select: { id: true, code: true } }),
      prisma.route.findMany({ select: { id: true, code: true, regionId: true } }),
    ]);
    const regionByCode = new Map(allRegions.map((r) => [r.code.toUpperCase(), r]));
    const routeByCode = new Map(allRoutes.map((r) => [r.code.toUpperCase(), r]));
    const channelIdByKey = new Map(
      (await prisma.channel.findMany({ select: { id: true, key: true } })).map((c) => [
        c.key.toUpperCase(),
        c.id,
      ])
    );

    // Only `parsed` is needed to promote; `raw` is the (much larger) original sheet
    // row and is never read here. Selecting it would move megabytes per slice.
    // `corrections` too: a fixed row's note says which of the cells the Steward
    // corrected were not written (item 20, post-merge review). Small, and only
    // fixed rows carry one.
    const cleanRows = await prisma.importRow.findMany({
      where: { batchId, state: ImportRowState.CLEAN },
      select: { id: true, parsed: true, corrections: true, rowNumber: true, createdAt: true },
      orderBy: { rowNumber: 'asc' },
    });

    // Group rows by parent custCode
    type ParsedShape = {
      custCode: string;
      custName: string;
      branchCode: string | null;
      branchName: string | null;
      regionCode: string | null;
      routeCode: string | null;
      address: string | null;
      phone: string | null;
      contactPerson: string | null;
      crNumber: string | null;
      paymentTerms: string;
      // Phase 1 Temix refresh columns (older batches parsed before the columns
      // existed have them undefined — treat as absent).
      paymentTermsPresent?: boolean;
      temixCode?: string | null;
      creditLimit?: number | null;
      paymentTermDays?: number | null;
      // Go-live enrichment (absent on older batches).
      channelKey?: string | null;
      dayOfVisit?: string | null;
      customerStatus?: string | null;
      // Item 20: set when the Data Steward fixed this row in the app
      // (services/import-fixes.ts). Only such a row may change an existing
      // branch of a customer linked to Temix.
      fixedInApp?: boolean;
      // Set on every row a fix in the app brought back (services/import-fixes.ts
      // recheck): the state before the first fix, and the acted row's id.
      fixedFrom?: unknown;
      fixGroup?: string;
    };
    const groups = new Map<
      string,
      { rowIds: string[]; parsed: ParsedShape[]; corrections: Prisma.JsonValue[] }
    >();
    const rowMeta = new Map(cleanRows.map((r) => [r.id, { rowNumber: r.rowNumber, createdAt: r.createdAt }]));
    for (const row of cleanRows) {
      const p = row.parsed as unknown as ParsedShape | null;
      if (!p?.custCode) continue;
      const g = groups.get(p.custCode) ?? { rowIds: [], parsed: [], corrections: [] };
      g.rowIds.push(row.id);
      g.parsed.push(p);
      g.corrections.push(row.corrections);
      groups.set(p.custCode, g);
    }

    const failures: Array<{ custCode: string; rowIds: string[]; reason: string }> = [];

    // Item 20: the rows a fix in the app brought back — the row acted on, and
    // its customer's rows it released with it (parsed.fixedFrom, one
    // parsed.fixGroup) — are checked again here, as ONE unit:
    //  - past the fix window the newer uploads may be swept, so the check
    //    below would go blind; such a fix is rejected (pre-merge review);
    //  - the newest-upload rule was checked only when the fix was made, so a
    //    fix overtaken by a newer upload while it waited loaded older data over
    //    it (post-merge review). Each row is judged by its own rule — branch
    //    only for a fixed row of a customer linked to Temix, the customer for
    //    every other — and one overtaken row rejects its whole unit: the
    //    released rows used to load alone, older data included (pre-merge
    //    review).
    // Rejected in the words the batch page uses, so they can then only be
    // excluded. Plain rows keep the upload's own rules.
    type FixMember = { id: string; code: string; p: ParsedShape; unit: string };
    const fixMembers: FixMember[] = [];
    for (const [code, g] of groups) {
      g.parsed.forEach((p, i) => {
        if (p.fixedInApp === true || p.fixedFrom) {
          fixMembers.push({ id: g.rowIds[i], code, p, unit: fixUnitOf(g.rowIds[i], p) });
        }
      });
    }
    if (fixMembers.length > 0) {
      const why = new Map<string, (m: FixMember) => string>();
      for (const m of fixMembers) {
        const meta = rowMeta.get(m.id)!;
        if (!why.has(m.unit) && fixWindowClosed(meta.createdAt)) {
          why.set(m.unit, (x) => fixWindowMessage(rowMeta.get(x.id)!.rowNumber));
        }
      }
      const toAsk = fixMembers.filter((m) => !why.has(m.unit));
      const overtaken = toAsk.length
        ? await newerUploadsCarrying(
            prisma,
            preflight.uploadedAt,
            toAsk.map((m) => fixTarget(m.id, m.code, m.p.branchCode, m.p.fixedInApp === true))
          )
        : new Map();
      for (const m of toAsk) {
        const n = overtaken.get(m.id);
        if (n && !why.has(m.unit)) why.set(m.unit, (x) => newerUploadMessage(x.code, n));
      }
      // One failure per customer, as the main loop counts them: a rejected
      // three-row unit read as "3 customer(s) failed" (pre-merge review).
      const failedByCode = new Map<string, { rowIds: string[]; reason: string }>();
      for (const m of fixMembers) {
        const reasonOf = why.get(m.unit);
        const g = groups.get(m.code);
        if (!reasonOf || !g) continue;
        const reason = reasonOf(m);
        const i = g.rowIds.indexOf(m.id);
        g.rowIds.splice(i, 1);
        g.parsed.splice(i, 1);
        g.corrections.splice(i, 1);
        if (g.rowIds.length === 0) groups.delete(m.code);
        await prisma.importRow.updateMany({
          where: { id: m.id, state: ImportRowState.CLEAN },
          data: {
            state: ImportRowState.REJECTED,
            issues: [{ field: '_promote', message: reason }] as Prisma.InputJsonValue,
            reviewedById: me.id,
            reviewedAt: new Date(),
          },
        });
        const f = failedByCode.get(m.code) ?? { rowIds: [], reason };
        f.rowIds.push(m.id);
        failedByCode.set(m.code, f);
      }
      for (const [custCode, f] of failedByCode) failures.push({ custCode, ...f });
    }

    // Ensure the UNASSIGNED region+route pair exists — the fail-safe landing place
    // for rows whose route is unknown. Served from the maps loaded above; only the
    // very first import of a fresh database actually creates them.
    let unassignedRoute = routeByCode.get('UNASSIGNED') ?? null;
    if (!unassignedRoute) {
      let unassignedRegionId = regionByCode.get('UNASSIGNED')?.id ?? null;
      if (!unassignedRegionId) {
        const createdRegion = await prisma.region.create({
          data: { code: 'UNASSIGNED', name: 'Unassigned' },
          select: { id: true, code: true },
        });
        regionByCode.set('UNASSIGNED', createdRegion);
        unassignedRegionId = createdRegion.id;
      }
      unassignedRoute = await prisma.route.create({
        data: { code: 'UNASSIGNED', name: 'Unassigned', regionId: unassignedRegionId },
        select: { id: true, code: true, regionId: true },
      });
      routeByCode.set('UNASSIGNED', unassignedRoute);
      // Launch fix: the cached filter lists (lib/reference-data.ts) learn of it now.
      revalidateTag('ref:regions');
      revalidateTag('ref:routes');
    }

    // QA-019: each customer's promotion (parent + branches + row state) runs
    // in its own transaction so a partial failure leaves no half-state.
    // F-03: per-row failures now mark the row as REJECTED with the error
    // message in `issues`, and the action returns a `{ promoted, failed }`
    // tuple that the UI surfaces in the toast — no more silent swallow.
    let promoted = 0;
    // Rows left CLEAN because the DATABASE failed, not the data — retried next slice.
    let deferred = 0;
    // RK-3: yield the slice once the budget is spent. The check is at the TOP of the
    // loop, so a slice always makes progress on at least one customer — a batch can
    // never livelock by repeatedly yielding before doing any work.
    const deadline = Date.now() + promoteSliceBudgetMs();
    let processedGroups = 0;
    for (const [custCode, g] of groups) {
      if (processedGroups > 0 && Date.now() >= deadline) break;
      processedGroups++;
      const first = g.parsed[0];

      // Pre-resolve regions and routes outside the transaction (these are upserts
      // that can be repeated safely across batches).
      const resolvedBranches: Array<{
        sheetCode: string | null;
        branchCode: string;
        branchName: string;
        regionId: string;
        routeId: string;
        address: string;
        dayOfVisit: string | null;
        status: string | null;
        // Item 20: what the ROW supplied, as opposed to the fallbacks above it. An
        // existing branch is updated only from values the sheet actually gave; a
        // blank cell keeps the stored value instead of writing "Address pending",
        // "Main" or the UNASSIGNED route over real data.
        nameGiven: boolean;
        routeResolved: boolean;
        sheetAddress: string | null;
        fixedInApp: boolean;
      }> = [];
      const groupResolveErrors: string[] = [];
      for (const [bi, p] of g.parsed.entries()) {
        // F-17: refuse to silently auto-create unknown regions/routes. Phantom
        // regions invented by typos are the source of CHAIN-09 (an unscoped
        // Manager later falls into them). Only Existing region/route codes
        // resolve; everything else falls back to UNASSIGNED with a flag in
        // the audit log so the Steward can fix.
        // RK-3: resolved from the per-slice maps, not a query per row. Reference data
        // (regions/routes) is administered by the Steward and is not mutated by this
        // loop, so a snapshot taken at the top of the slice is authoritative for it.
        const region = p.regionCode ? (regionByCode.get(p.regionCode.toUpperCase()) ?? null) : null;
        const route = p.routeCode ? (routeByCode.get(p.routeCode.toUpperCase()) ?? null) : null;
        // Each warning says where the branch actually went. They all used to get
        // "; assigned to UNASSIGNED" appended when written, which was false
        // whenever the route resolved: the branch went to that route's region.
        if (p.regionCode && !region) {
          groupResolveErrors.push(
            route
              ? `region "${p.regionCode}" not found — used the region of route "${p.routeCode}"`
              : `region "${p.regionCode}" not found — a new branch is parked in UNASSIGNED, an existing one keeps its route`
          );
        }
        if (p.routeCode && !route) {
          groupResolveErrors.push(
            `route "${p.routeCode}" not found — a new branch is parked in UNASSIGNED, an existing one keeps its route`
          );
        }
        // QA P-02 fix: the fallback previously used the UNASSIGNED ROUTE's id as a
        // REGION id, so the B-19 region-consistency trigger (Branch.regionId must
        // equal Route.regionId) aborted the whole group — the F-17 fallback could
        // never actually happen. Resolve trigger-consistently instead:
        //   - route known  → the route's own region is authoritative (a region
        //     that disagrees is a sheet inconsistency, warned + overridden);
        //   - route unknown → the consistent UNASSIGNED region+route pair.
        let effectiveRegionId: string;
        let effectiveRouteId: string;
        if (route) {
          effectiveRouteId = route.id;
          effectiveRegionId = route.regionId;
          if (region && region.id !== route.regionId) {
            groupResolveErrors.push(
              `region "${p.regionCode}" does not match route "${p.routeCode}" — used the route's region`
            );
          }
        } else {
          // No usable route → the consistent UNASSIGNED pair. If the row DID supply
          // a region, warn that it was dropped (region is derived from the route to
          // satisfy the B-19 trigger) so the steward can add the missing route.
          effectiveRouteId = unassignedRoute!.id;
          effectiveRegionId = unassignedRoute!.regionId;
          // Only when there was no route at all: an unknown route has its own
          // warning above, and "provided without a route" would be untrue.
          if (p.regionCode && region && !p.routeCode) {
            groupResolveErrors.push(
              `region "${p.regionCode}" was provided without a route — a new branch is parked in UNASSIGNED, an existing one keeps its route; add a route to keep the region`
            );
          }
        }
        // QA P-01 fix (identity model: branch = custcode-branchcode, globally
        // unique): a sheet carrying a BARE suffix ('01') previously produced a
        // global branchCode '01' that collided across customers — and the upsert
        // below silently re-parented the branch to the later customer. Compose
        // bare codes under the owning custCode; already-composed codes (or a
        // code equal to the custCode itself) pass through unchanged.
        const rawBranchCode = p.branchCode ? p.branchCode.trim().toUpperCase() : null;
        resolvedBranches.push({
          // sheetCode: the code EXACTLY as the sheet gave it (null if generated).
          // The in-tx guard checks it too — a sheet code that exists under another
          // customer is a data error to review, not a code to silently re-mint.
          sheetCode: rawBranchCode,
          // lib/import-row-fix composeBranchCode — shared with the newest-upload
          // rule, which compares branches the way promote names them.
          branchCode: rawBranchCode
            ? composeBranchCode(custCode, rawBranchCode)
            : formatBranchCode(custCode, bi + 1),
          branchName: p.branchName ?? 'Main',
          regionId: effectiveRegionId,
          routeId: effectiveRouteId,
          // final-hunt #8: `[...].filter(Boolean).join(', ')` returns '' (empty
          // string, not null) when branch_name AND sales_region are both blank, and
          // `??` does NOT fall through '' — so the branch got an empty address and
          // the whole customer group was REJECTED at promote (address is required).
          // `||` falls through the empty string to the 'Address pending' placeholder.
          //
          // AND THE SAME DEFECT ONE NOTCH ALONG, 2026-09-23: empty is not the only
          // address the database refuses. `Branch_address_minlength` requires three
          // characters after trimming, and `||` does not fall through a non-empty
          // string, so a 1-2 character address sailed past this line and was thrown
          // out by Postgres instead. 26 customers carried a one- or two-letter area
          // abbreviation from the source sheet and were rejected on ALL THREE loads
          // that day — reported as "promote failed (UNKNOWN)", because a CHECK
          // violation reaches Prisma as PrismaClientUnknownRequestError, which
          // carries no `code` at all. usableBranchAddress() applies the database's
          // own rule here, where there is still a fallback to reach for.
          // The second candidate KEEPS the short value rather than discarding it.
          // "X" is not noise — it is the area abbreviation the source sheet holds,
          // and it is the only address those customers have. Qualifying it to
          // "X, Main, MCT" clears the minimum and loses nothing; falling straight
          // to branch+region would throw the one real datum away to satisfy a
          // length check.
          address:
            usableBranchAddress(p.address) ??
            usableBranchAddress([p.address, p.branchName, p.regionCode].filter(Boolean).join(', ')) ??
            'Address pending',
          dayOfVisit: p.dayOfVisit ?? null,
          status: p.customerStatus ?? null,
          nameGiven: !!p.branchName,
          routeResolved: !!route,
          sheetAddress: p.address
            ? (usableBranchAddress(p.address) ??
              usableBranchAddress([p.address, p.branchName, p.regionCode].filter(Boolean).join(', ')))
            : null,
          fixedInApp: p.fixedInApp === true,
        });
      }

      // QA P-03: two rows in the SAME customer group can resolve to the SAME
      // branchCode — a bare code like '03' composes to `X-03`, which also equals
      // the positional `formatBranchCode(X, 3)` produced for a codeless row, or two
      // rows may simply carry the same branch_code. The per-branch upsert is keyed
      // on the globally-unique branchCode, so the second row would silently UPDATE
      // (overwrite) the first branch — one physical branch lost, both rows marked
      // PROMOTED. There is no way to know which row is authoritative, so reject the
      // whole group to steward review rather than drop data silently.
      const seenBranchCodes = new Set<string>();
      let dupBranchCode: string | null = null;
      for (const r of resolvedBranches) {
        if (seenBranchCodes.has(r.branchCode)) {
          dupBranchCode = r.branchCode;
          break;
        }
        seenBranchCodes.add(r.branchCode);
      }
      if (dupBranchCode) {
        failures.push({
          custCode,
          rowIds: g.rowIds,
          reason: `branch_code ${dupBranchCode} appears on more than one row for this customer — steward review`,
        });
        await prisma.importRow
          .updateMany({
            where: { id: { in: g.rowIds } },
            data: {
              state: ImportRowState.REJECTED,
              issues: [
                {
                  field: '_promote',
                  message: `duplicate branch_code ${dupBranchCode} within this customer`,
                },
              ] as Prisma.InputJsonValue,
              reviewedById: me.id,
              reviewedAt: new Date(),
            },
          })
          .catch(() => undefined);
        continue;
      }

      try {
        let refreshedRow = false;
        // Per row: what happened to its branch, when that is worth telling the
        // Steward. Written after the transaction commits.
        let rowNotes: RowNote[] = [];
        // F16: the full lane cleared the customer's sub-channel (logged once
        // the group has committed, never for a rolled-back one).
        let clearedSubChannelOf: string | null = null;
        // final-hunt #32, extended to promote: this interactive transaction makes
        // ~9 sequential round trips (customer read + upsert, per-branch ownership
        // check + upsert, row state, completeness). Prisma's DEFAULT 5s ceiling is
        // simply too tight for that over a networked Postgres — customers were
        // being rejected with P2028 ("transaction closed") purely because the link
        // was slow, which on the real master would silently drop good rows.
        await prisma.$transaction(
          async (tx) => {
            rowNotes = g.rowIds.map(() => ({ note: null, written: false }));
            clearedSubChannelOf = null;
            // N03: the customer's row lock FIRST, then the read, on every lane —
            // lib/locks.ts order, customer before branch. The read used to come
            // unlocked, so an archive committing after it was not seen and the
            // upsert below wrote over the archived customer anyway.
            const lockedId = await lockCustomerRowByCode(tx, custCode);
            const existing = lockedId
              ? await tx.customer.findUnique({
                  where: { id: lockedId },
                  select: {
                    id: true,
                    temixCode: true,
                    paymentTerms: true,
                    deletedAt: true,
                    createdById: true,
                    legalName: true,
                    primaryPhoneNorm: true,
                    crNumberNorm: true,
                    contactPerson: true,
                    channel: { select: { key: true } },
                    // F16: whether a channel change leaves the stored
                    // sub-channel under another channel (read under the lock).
                    channelId: true,
                    subChannelId: true,
                    subChannel: { select: { channelId: true } },
                  },
                })
              : null;
            // N03: an archived customer is refused before any lane is chosen,
            // whatever the rows carry. This check sat inside `if (lead.temixCode)`,
            // so a row with a blank temix_code took the full lane: the upsert
            // found the archived customer by its code and rewrote its name,
            // phone, CR and status, and a new branch_code was created LIVE under
            // it — on the salesman's Today list, while the customer page could
            // not open it. There is no restore in the app; the row can only be
            // excluded. The message names neither a branch code nor Temix, so the
            // batch page offers Re-check and Exclude and no cell to correct
            // (lib/import-row-fix.ts editableColumns).
            if (existing?.deletedAt) {
              throw new Error(
                first.temixCode
                  ? 'CROSSWALK:customer is archived in the CRM — resolve its Temix deactivation before refreshing'
                  : 'CROSSWALK:customer is archived in the CRM, and an import does not bring an archived customer back — exclude the row; steward review'
              );
            }
            // Owner decision 2026-09-25, "branch only" — decided PER ROW. For a
            // customer linked to Temix, a row the Steward fixed in the app writes
            // its own branch and nothing else about the customer, whatever its
            // temix_code cell and whatever the rows beside it. It was decided for
            // the whole group, so a fixed row with a plain sibling took the full
            // lane and was never queued for Temix, and a fixed group took the
            // refresh lane's credit figures from an old sheet (post-merge review).
            // The plain rows take the lane their first row decides, exactly as a
            // group with no fixed row does.
            const linked = !!existing && !existing.deletedAt && !!existing.temixCode;
            const isFixed = g.parsed.map((p) => linked && p.fixedInApp === true);
            const plainIdx = g.parsed.map((_, i) => i).filter((i) => !isFixed[i]);
            // Every customer-level decision below reads the first PLAIN row (the
            // first row, when every row is fixed — then nothing about the
            // customer is written, and the Temix-code guards still apply).
            const lead = plainIdx.length > 0 ? g.parsed[plainIdx[0]] : first;
            const pt = lead.paymentTerms === 'CREDIT' ? 'CREDIT' : 'CASH';

            // ── Phase 1 Temix crosswalk guards (rows carrying temix_code) ──
            // Quarantine-style rejection, never silent overwrite: the crosswalk
            // is a join (owner-locked nmwcCode == temixCode for migrated rows),
            // so a code landing on a different customer, or disagreeing with an
            // already-recorded code, is Steward-review territory.
            if (lead.temixCode) {
              // NO deletedAt filter (adversarial-review CONFIRMED fix): an
              // ARCHIVED customer holding this code has a DEACTIVATE for it
              // queued/in-flight — re-attaching the code to a live customer
              // would let that DEACTIVATE kill the live record in Temix.
              // F11: so does an archived customer with no Temix code whose
              // customer code this is — its deactivation goes out keyed on it
              // (lib/temix.ts deactivationCode). Not asked when this customer
              // already holds the code: the row gives it to nobody new.
              const codeOwner = await tx.customer.findFirst({
                where: {
                  nmwcCode: { not: custCode },
                  OR: [
                    { temixCode: lead.temixCode },
                    ...(existing?.temixCode === lead.temixCode
                      ? []
                      : [archivedUncodedDeactivationWhere(lead.temixCode)]),
                  ],
                },
                select: { nmwcCode: true, temixCode: true, deletedAt: true },
              });
              if (codeOwner && codeOwner.temixCode !== lead.temixCode) {
                throw new Error(
                  `CROSSWALK:temix_code is the customer code of archived ${codeOwner.nmwcCode}, which has no Temix code — its Temix deactivation goes out under that code — steward review`
                );
              }
              if (codeOwner) {
                throw new Error(
                  `CROSSWALK:temix_code already recorded on ${codeOwner.nmwcCode}${codeOwner.deletedAt ? ' (archived — its Temix deactivation may be in flight)' : ''} — steward review`
                );
              }
              if (existing?.temixCode && existing.temixCode !== lead.temixCode) {
                throw new Error(
                  'CROSSWALK:temix_code conflicts with the code already recorded for this customer — steward review'
                );
              }
              // An archived customer (whose in-flight deactivation a stale Temix
              // extract must not settle) was already refused above, before
              // any lane — N03.
            }

            // A refresh is an inbound update from the ERP for a customer the CRM
            // ALREADY KNOWS BY A TEMIX CODE. Deciding it from the mere presence of
            // a temix_code cell was wrong in the one case that matters most.
            //
            // Every row scripts/golive/build-masters.ts emits carries temix_code —
            // it is the same string as cust_code — and production already holds
            // roughly 3,300 seeded customers keyed on the same RoutePro alternate
            // code. So on the FIRST master load every one of those rows would have
            // taken the narrow ERP lane below, which writes only the crosswalk code
            // and the credit figures and, at `if (!isRefresh)`, skips the entire
            // branch loop. The new region, route, address and day of visit would
            // never land; the salesman's Today screen would be empty or point at
            // the May route. And nothing would report it: the rows are still marked
            // PROMOTED and counted, so the step-6 reconciliation comes out clean
            // and the steward signs off on a load that did nothing for thousands of
            // customers.
            //
            // The comment further down reasoned that "a re-run finds it live with a
            // matching code and takes the refresh lane". True — but the first run
            // against a seeded database is indistinguishable from a re-run, and
            // that was never noticed. Requiring `existing.temixCode` makes the two
            // distinguishable: a customer the CRM has never crosswalked takes the
            // upsert lane, which is what a master load is.
            // The equality clause closes the other half: the "ERP authority" that
            // unlocks the credit fields below was, until now, nothing but a string
            // the spreadsheet supplied. A Steward — the one role deliberately NOT
            // on the credit chain — could put any value in temix_code and have the
            // narrow lane write paymentTerms and an arbitrary creditLimit with no
            // approver, while services/edits.ts refuses that same change on the
            // edit path. Worse, the invented code became the customer's ERP
            // identity and went out verbatim in the next Temix batch, telling the
            // ERP to upsert under a code nobody there issued.
            //
            // Requiring the code to MATCH what the CRM already recorded means the
            // authority has to have come from somewhere other than this sheet.
            // A row proposing a different code falls through to the upsert lane,
            // which writes neither temixCode nor paymentTerms, and is rejected
            // just below so a genuine crosswalk change is a deliberate act rather
            // than a cell nobody read.
            //
            // No seeded customer carries a temixCode, so neither clause changes
            // anything about the go-live load itself.
            const isRefresh =
              !!existing &&
              !existing.deletedAt &&
              !!lead.temixCode &&
              !!existing.temixCode &&
              existing.temixCode === lead.temixCode;

            if (
              existing &&
              !existing.deletedAt &&
              lead.temixCode &&
              existing.temixCode &&
              existing.temixCode !== lead.temixCode
            ) {
              throw new Error(
                'CROSSWALK:this customer is already crosswalked to a different Temix code — changing it is a deliberate re-crosswalk, not an import; steward review'
              );
            }
            // The plain rows' lane: the refresh lane when their first row carries
            // the customer's own Temix code, else the full lane. With no plain
            // row, nothing about the customer is written at all.
            const refreshLane = isRefresh && plainIdx.length > 0;
            const fullLane = plainIdx.length > 0 && !isRefresh;
            const fullIdx = fullLane ? plainIdx : [];
            const fullBranches = fullIdx.map((i) => resolvedBranches[i]);
            const fullParsed = fullIdx.map((i) => g.parsed[i]);
            // Every row whose branch goes through refreshLaneBranches: the fixed
            // rows, and the plain rows too on the refresh lane.
            const laneIdx = g.parsed.map((_, i) => i).filter((i) => !fullIdx.includes(i));
            refreshedRow = laneIdx.length > 0;
            const groupChannelId = lead.channelKey
              ? (channelIdByKey.get(lead.channelKey.toUpperCase()) ?? null)
              : null;
            // What the file says about the customer's status, from the rows that
            // say anything: ACTIVE if any row does. A blank cell says nothing — it
            // used to be the first row's, so [blank, CLOSED] kept the status and
            // [CLOSED, blank] closed it (post-merge review).
            const statedStatus: CustomerStatus | null = fullParsed.some(
              (p) => p.customerStatus === 'ACTIVE'
            )
              ? 'ACTIVE'
              : ((fullParsed.find((p) => p.customerStatus)?.customerStatus as
                  | CustomerStatus
                  | undefined) ?? null);

            // Item 20 (owner decision 2026-09-25): a row with no branch_code is
            // numbered by its position among this customer's clean rows in THIS
            // file, so once the customer has branches, a file with only some of its
            // rows gives a row the code of a sibling — and the upsert below would
            // overwrite that sibling. It cannot be told which branch it is; refuse.
            if (
              fullLane &&
              existing &&
              !existing.deletedAt &&
              fullBranches.some((r) => !r.sheetCode)
            ) {
              const has = await tx.branch.count({ where: { customerId: existing.id, deletedAt: null } });
              if (has > 0) {
                throw new Error(
                  'CROSSWALK:a row has no branch_code, and this customer already has branches — the import cannot tell which branch the row is; add branch_code; steward review'
                );
              }
            }
            // Every row fixed in the app: branch writes come first, the
            // customer's own row after (the phone fill, the score). That lane
            // needs the customer's row lock before its branch writes, as photo
            // attach and Remove do (lib/locks.ts), or the two orders deadlock on
            // the same branch (pre-merge review) — every lane now holds it from
            // the top of this transaction (N03).
            let customerId: string;
            if (refreshLane) {
              // ── Temix REFRESH row (existing live customer + temix_code) ──
              // Narrow, Temix-OWNED update only: crosswalk code + payment terms +
              // credit figures (owner-locked: authoritative from Temix). CRM-
              // enriched identity/contact data (legalName, phone, CR, contact)
              // and ALL branch operational data are CRM-owned — a refresh must
              // not clobber them (field-ownership matrix, sla-notif-sync §3.5).
              //
              // Presence-aware (adversarial-review CONFIRMED fix): an ABSENT
              // payment_terms column means "keep the customer's current terms" —
              // only an explicit CASH may clear credit figures, and credit
              // figures apply only while the customer is (or becomes) CREDIT.
              const ptPresent = lead.paymentTermsPresent === true;
              const effectiveTerms = ptPresent ? pt : existing!.paymentTerms;
              await tx.customer.update({
                where: { id: existing!.id },
                data: {
                  temixCode: lead.temixCode,
                  paymentTerms: ptPresent ? pt : undefined,
                  creditLimit:
                    effectiveTerms === 'CREDIT'
                      ? (lead.creditLimit ?? undefined)
                      : ptPresent
                        ? null
                        : undefined,
                  paymentTermDays:
                    effectiveTerms === 'CREDIT'
                      ? (lead.paymentTermDays ?? undefined)
                      : ptPresent
                        ? null
                        : undefined,
                  lastEditedById: me.id,
                  // B-05: make the refresh visible to the optimistic lock so a
                  // concurrent edit-approve sees VERSION_CONFLICT, not a silent
                  // revert of Temix-authoritative fields.
                  version: { increment: 1 },
                },
              });
              // Blueprint §8.3: the inbound refresh is what flips UPLOADED →
              // SYNCED. Guarded so a PENDING_UPLOAD row (correction approved
              // after the last batch) keeps its place in the queue. This lane
              // runs only with a plain row: a group of rows the Steward fixed in
              // the app is no word from Temix, and a batch still awaiting its
              // acknowledgement would read as confirmed. UPLOADED is the safe
              // side — the next real refresh flips it.
              await tx.customer.updateMany({
                where: { id: existing!.id, temixSyncState: 'UPLOADED' },
                data: { temixSyncState: 'SYNCED' },
              });
              // TEMIX_SYNC_ACKED: the ERP code just landed for the first time —
              // tell the originating submitter their customer is live in Temix.
              if (!existing!.temixCode && lead.temixCode && existing!.createdById) {
                await notifyUsers(tx, [existing!.createdById], {
                  kind: 'TEMIX_SYNC_ACKED',
                  title: 'Customer landed in Temix',
                  body: `${existing!.legalName} (${custCode}) is now in Temix as ${lead.temixCode}.`,
                  customerId: existing!.id,
                });
              }
              customerId = existing!.id;
            } else if (!fullLane) {
              // Every row was fixed in the app: branch only.
              customerId = existing!.id;
            } else {
              // SEC-03/09 (2): credit standing is approval-gated or ERP-authoritative,
              // never an ordinary-import side effect.
              //
              // A net-new CREDIT customer created in the app runs Salesman -> Supervisor
              // -> Finance Manager -> GM -> Accountant (lib/approval-chains.ts), and only
              // lib/create-finalize.ts may then write creditLimit/paymentTermDays. The
              // refresh lane above is the other legitimate writer: it is gated on
              // temix_code, i.e. the ERP said so. The ordinary customer edit cannot touch
              // terms at all -- services/edits.ts rejects any customer.paymentTerms change
              // outright (final-hunt #3), on the direct-write path too.
              //
              // THIS lane was the one hole. `isRefresh` above already claimed every
              // live-customer-with-temix_code case, and an archived customer carrying a
              // temix_code already threw, so a row reaching here carries no ERP authority
              // and no approver saw it -- yet it wrote `paymentTerms` on update and
              // paymentTerms + creditLimit + paymentTermDays on create. An ordinary sheet
              // could therefore mint a live CREDIT customer with any credit limit (the
              // parser does not even require credit_limit on a CREDIT row, so "CREDIT with
              // no limit" was reachable too), or flip an existing customer's terms, with
              // nothing anywhere in the trail.
              //
              // Two guards, in THIS order, so a sheet that merely RESTATES the terms
              // already on record stays idempotent. That ordering is not cosmetic: a
              // customer created through the credit chain is CREDIT with NO temix_code
              // until Temix acks it, so a blanket "CREDIT needs temix_code" would reject
              // its own correct row -- and the README promises re-import is safe.
              //   1. disagreement with what is stored -> hold, in either direction;
              //   2. a NEW customer asking for CREDIT with no temix_code -> hold.
              // Held, never silently written and never silently downgraded to CASH, using
              // the CROSSWALK convention already used in this function: the whole group is
              // REJECTED with a PII-free message on the row.
              //
              // This does NOT gate the go-live master load. Every row
              // scripts/golive/build-masters.ts emits carries temix_code (= the Temix base
              // code, which is also cust_code), so a CREDIT row from it passes guard 2 and
              // lands on the create branch below with its ERP figures intact.
              //
              // NOTE, corrected 2026-09-15: this used to add "a re-run finds it live with
              // a matching code and takes the refresh lane above". That was true and
              // beside the point — the FIRST run against the seeded production database is
              // indistinguishable from a re-run, so those rows took the refresh lane too
              // and silently skipped every identity and branch field. The lane test above
              // now also requires the customer to already carry a Temix code. One
              // consequence lands HERE: a seeded customer whose stored payment terms
              // disagree with the master now reaches guard 1 and is REJECTED for steward
              // review rather than being quietly narrowed to a credit-only update. That is
              // the intended behaviour — it is the same guard that stops a spreadsheet
              // granting credit standing — but it means the load can report rejections it
              // did not report before, and each one is a real disagreement worth reading.
              if (existing && lead.paymentTermsPresent && pt !== existing.paymentTerms) {
                // Either direction. CASH->CREDIT grants credit standing no approver saw.
                // CREDIT->CASH is worse than it looks: this lane, unlike the refresh lane,
                // never nulls creditLimit/paymentTermDays, so the flip would leave a CASH
                // customer carrying a live credit limit that lib/temix.ts then suppresses
                // on export -- the CRM and the ERP would disagree, silently.
                // Two ways to arrive here, and the message used to name only one. A
                // go-live row DOES carry a temix_code; it is the stored customer that
                // has none to match it against, so the refresh lane was closed to it.
                throw new Error(
                  lead.temixCode
                    ? 'CROSSWALK:payment_terms disagrees with the terms already recorded for this customer, and the customer has no Temix code on record for this row to refresh from — move the terms through the credit chain; steward review'
                    : 'CROSSWALK:payment_terms disagrees with the terms already recorded for this customer and the row carries no temix_code — refresh from Temix, or move the terms through the credit chain; steward review'
                );
              }
              if (!existing && pt === 'CREDIT' && !lead.temixCode) {
                throw new Error(
                  'CROSSWALK:payment_terms is CREDIT but the row carries no temix_code — credit terms and limits come from Temix or from the credit approval chain, not from an ordinary import; steward review'
                );
              }
              // F16 (auditor recheck 2026-09-27; owner decision 1, 2026-09-29): a
              // row that moves the customer to another channel used to leave the
              // old channel's sub-channel beside it — a pair CREATE refuses and
              // both reports and Temix read. It is cleared in the same write. A
              // sub-channel of the new channel is kept, and a blank channel cell
              // writes no channel, so it clears nothing. The sheet has no
              // sub-channel column, so the new one is picked on the customer page;
              // the lead row says so. Known costs (docs/OPERATIONS.md): -10
              // completeness, no Temix requeue on this lane, and under the FULL
              // gate a pending edit then fails approval asking for a sub-channel.
              const clearSub =
                !!existing &&
                subChannelClearedByChannelChange(
                  {
                    channelId: existing.channelId,
                    subChannelId: existing.subChannelId,
                    subChannelChannelId: existing.subChannel?.channelId ?? null,
                  },
                  groupChannelId
                );
              if (clearSub) {
                clearedSubChannelOf = existing!.id;
                rowNotes[plainIdx[0]] = {
                  ...rowNotes[plainIdx[0]],
                  subChannel: `the channel in this row (${lead.channelKey?.toUpperCase()}) replaces the customer's channel, so its sub-channel, which belongs to the old channel, was cleared — pick a sub-channel of the new channel on the customer page`,
                };
              }
              const customer = await tx.customer.upsert({
                where: { nmwcCode: custCode },
                update: {
                  // Re-import of an EXISTING customer via a non-Temix row must not
                  // clobber CRM-owned data (adversarial-review CONFIRMED). Presence-
                  // aware, mirroring the refresh lane: an ABSENT payment_terms column
                  // must NOT flip a CREDIT customer to CASH, and a BLANK phone/CR/
                  // contact cell must NOT null the stored value. `undefined` = "leave
                  // unchanged". cust_name is mandatory (a blank row is quarantined),
                  // so legalName is always a real value here.
                  legalName: lead.custName,
                  // SEC-03/09 (2): paymentTerms is deliberately NOT written here. On an
                  // EXISTING customer, terms are Temix-owned (the refresh lane above) or
                  // approval-owned (the credit create chain). The disagreement guard at
                  // the top of this branch already rejects any row that differs, so the
                  // only value that could reach this line is one that already matches what
                  // is stored -- writing it buys nothing and re-opens the hole if that
                  // guard is ever loosened. It also covers the one case the guard cannot
                  // see: if a concurrent insert made this upsert take the update path when
                  // `existing` read null, not writing terms fails in the safe direction.
                  // `undefined` = leave unchanged, same rule as phone/CR/contact below.
                  primaryPhone: lead.phone ?? undefined,
                  primaryPhoneNorm: lead.phone ?? undefined,
                  contactPerson: lead.contactPerson ?? undefined,
                  crNumber: lead.crNumber ?? undefined,
                  crNumberNorm: lead.crNumber ? normalizeCR(lead.crNumber) : undefined,
                  channelId: groupChannelId ?? undefined,
                  subChannelId: clearSub ? null : undefined,
                  // A status other than ACTIVE is settled after the branches are
                  // written, from every live branch (below).
                  status: statedStatus === 'ACTIVE' ? 'ACTIVE' : undefined,
                  lastEditedById: me.id,
                  // B-05: bump the optimistic version so a concurrent edit-approve
                  // sees VERSION_CONFLICT rather than a silently lost update.
                  version: { increment: 1 },
                },
                create: {
                  nmwcCode: custCode,
                  legalName: lead.custName,
                  paymentTerms: pt,
                  primaryPhone: lead.phone,
                  primaryPhoneNorm: lead.phone,
                  contactPerson: lead.contactPerson,
                  crNumber: lead.crNumber,
                  crNumberNorm: normalizeCR(lead.crNumber),
                  channelId: groupChannelId ?? null,
                  status: statedStatus ?? 'ACTIVE',
                  // Initial master load may carry the ERP code directly; credit
                  // figures land only on CREDIT rows.
                  temixCode: lead.temixCode ?? null,
                  // Customer.temixSyncState defaults to SYNCED, which is right for a
                  // row that arrived carrying an ERP code and wrong for one that did
                  // not. A customer imported without a temix_code was born claiming
                  // the ERP already knew it: never queued for an upload batch, absent
                  // from /temix (which counts only PENDING_UPLOAD and
                  // DEACTIVATE_PENDING), and showing a blank code beside the word
                  // "synced". It exists in the CRM, appears on a salesman's route,
                  // can be enriched — and Temix never learns it exists, so it cannot
                  // be invoiced. Queue it instead.
                  temixSyncState: lead.temixCode ? 'SYNCED' : 'PENDING_UPLOAD',
                  temixSyncPendingSince: lead.temixCode ? null : new Date(),
                  creditLimit: pt === 'CREDIT' ? (lead.creditLimit ?? null) : null,
                  paymentTermDays: pt === 'CREDIT' ? (lead.paymentTermDays ?? null) : null,
                  createdById: me.id,
                  lastEditedById: me.id,
                  importBatchId: batchId,
                },
              });
              customerId = customer.id;
            }
            if (fullLane) {
              for (const r of fullBranches) {
                // QA P-01 fix (branch-steal guard): branchCode is globally unique
                // and the upsert's update path includes customerId — without this
                // check, a sheet row claiming a code owned by ANOTHER customer
                // silently re-parents that customer's branch. Ownership moves are
                // steward-review territory, never a silent import side effect.
                // (Read-then-upsert inside this per-group tx; batch promote is
                // serialized by the atomic READY→PROMOTING claim, so the TOCTOU
                // window is not reachable through this action.)
                const branchOwner = await tx.branch.findUnique({
                  where: { branchCode: r.branchCode },
                  select: {
                    customerId: true,
                    customer: { select: { nmwcCode: true } },
                    // What the row would change (differingBranchCells) — the
                    // region too, which a route moved by the account import
                    // leaves behind on its branches.
                    branchName: true,
                    routeId: true,
                    regionId: true,
                    address: true,
                    dayOfVisit: true,
                    status: true,
                  },
                });
                if (branchOwner && branchOwner.customerId !== customerId) {
                  throw new Error(
                    `CROSSWALK:branch_code ${r.branchCode} already belongs to ${branchOwner.customer.nmwcCode} — steward review`
                  );
                }
                // If composition changed the sheet's code, also check the RAW code:
                // a sheet code that exists under ANOTHER customer means the row
                // referenced someone else's branch (a data error) — flag it for
                // steward review instead of silently minting a re-prefixed code.
                if (r.sheetCode && r.sheetCode !== r.branchCode) {
                  const rawOwner = await tx.branch.findUnique({
                    where: { branchCode: r.sheetCode },
                    select: { customerId: true, customer: { select: { nmwcCode: true } } },
                  });
                  if (rawOwner && rawOwner.customerId !== customerId) {
                    throw new Error(
                      `CROSSWALK:branch_code ${r.sheetCode} already belongs to ${rawOwner.customer.nmwcCode} — steward review`
                    );
                  }
                }
                // F21 (auditor recheck 2026-09-27): a branch this row would not
                // change is not written. The upsert rewrote every branch of the
                // file whether or not a cell differed, so Prisma moved updatedAt
                // — what the master export prints as the branch's last_edited_at
                // — on branches the load had not changed; and it never bumped
                // version on one it had changed, as an approved edit does (B-05).
                // The export's "updated since" filter reads the CUSTOMER's
                // updatedAt (services/exports.ts), which the upsert above moves
                // on every full-lane group whatever its branches do. A branch
                // left in the old region of a route the account import moved
                // is a change, and the write below repairs it.
                if (branchOwner && differingBranchCells(r, branchOwner).length === 0) continue;
                await tx.branch.upsert({
                  where: { branchCode: r.branchCode },
                  // Item 20 (owner decision): a blank cell keeps the stored value.
                  // This wrote the fallbacks unconditionally, so a re-import with an
                  // empty address or route replaced a salesman's approved address with
                  // "Address pending" and moved the branch to UNASSIGNED.
                  update: {
                    branchName: r.nameGiven ? r.branchName : undefined,
                    regionId: r.routeResolved ? r.regionId : undefined,
                    routeId: r.routeResolved ? r.routeId : undefined,
                    address: r.sheetAddress ?? undefined,
                    customerId,
                    dayOfVisit: (r.dayOfVisit as DayOfWeek | null) ?? undefined,
                    status: (r.status as CustomerStatus | null) ?? undefined,
                    // EL-11: a status the load changes is a real status change —
                    // and one it only restates is not (services/edits.ts and the
                    // refresh lane stamp the same way). Now that an unchanged
                    // branch is not written at all, a restated status stamping
                    // here would have depended on some other cell changing.
                    lastStatusChangeAt:
                      r.status && r.status !== branchOwner?.status ? new Date() : undefined,
                    lastEditedById: me.id,
                    // B-05 / F21: a writer that read this branch before the import
                    // committed (a versioned updateMany) fails instead of writing over it.
                    version: { increment: 1 },
                  },
                  create: {
                    branchCode: r.branchCode,
                    branchName: r.branchName,
                    regionId: r.regionId,
                    routeId: r.routeId,
                    address: r.address,
                    customerId,
                    dayOfVisit: (r.dayOfVisit as DayOfWeek | null) ?? null,
                    status: (r.status as CustomerStatus | null) ?? 'ACTIVE',
                    lastStatusChangeAt: r.status === 'CLOSED' ? new Date() : null,
                    createdById: me.id,
                    lastEditedById: me.id,
                  },
                });
              }
              // Merged, not replaced: the lead row may already carry the
              // sub-channel note (F16), which this used to wipe.
              for (const i of fullIdx) rowNotes[i] = { ...rowNotes[i], note: null, written: true };
            }
            if (laneIdx.length > 0) {
              const out = await refreshLaneBranches(tx, {
                customerId,
                custCode,
                resolved: laneIdx.map((i) => resolvedBranches[i]),
                me: me.id,
              });
              laneIdx.forEach((i, k) => {
                rowNotes[i] = { note: out.notes[k] ?? null, written: out.written[k] ?? false };
              });
            }
            // Item 20 (owner decision): the customer's status follows ALL its
            // live branches. Settled once every branch of this group is written —
            // the full lane's and the fixed rows' alike — over every live
            // branch: a row with a blank status cell keeps its branch's stored
            // status, and a branch it creates is ACTIVE; all count. Counting
            // only the branches outside the file closed a customer whose other
            // branch, in the same file, stayed ACTIVE (post-merge review); and
            // counting before the fixed rows' branches were written could leave
            // a customer CLOSED beside an ACTIVE branch (pre-merge review).
            if (fullLane && statedStatus && statedStatus !== 'ACTIVE') {
              const liveActive = await tx.branch.count({
                where: { customerId, deletedAt: null, status: 'ACTIVE' },
              });
              await tx.customer.update({
                where: { id: customerId },
                data: { status: liveActive > 0 ? 'ACTIVE' : statedStatus },
              });
            }
            // What a fixed row asked for and did not get: branch only writes none
            // of the customer's own fields — but an empty phone, below — and the
            // row read PROMOTED with nothing said: a released phone looked loaded
            // (post-merge review). Compared with the customer as it stands after
            // this group's own writes.
            if (linked && isFixed.some(Boolean)) {
              // Read now, under the customer's row lock (every lane holds it by
              // here): `existing` was read before it, so a phone approved on an
              // edit meanwhile read as none, and was overwritten (pre-merge review).
              const now = await tx.customer.findUnique({
                where: { id: customerId },
                select: {
                  legalName: true,
                  primaryPhoneNorm: true,
                  crNumberNorm: true,
                  contactPerson: true,
                  channel: { select: { key: true } },
                },
              });
              if (now) {
                // Owner decision 2026-09-27: the phone on a row fixed in the app
                // FILLS the customer's phone when it has none — every go-live
                // head-office row is the only row carrying the phone, and the row
                // held back for a shared phone, so a released one landed nowhere.
                // Never over a phone the customer has. Queued for Temix, like
                // any change to what Temix holds.
                let phoneNow = now.primaryPhoneNorm;
                // The phone the Steward released or corrected first, then any
                // fixed row's: the lowest row number used to win over the one the
                // Steward had acted on (pre-merge review).
                const fixedWithPhone = g.parsed
                  .map((p, i) => ({ p, i }))
                  .filter(({ p, i }) => isFixed[i] && p.phone);
                const chosen =
                  fixedWithPhone.find(({ i }) => {
                    const c = readCorrections(g.corrections[i]);
                    return !!c.phoneReleased || c.cells?.phone !== undefined;
                  }) ?? fixedWithPhone[0];
                const fill = phoneNow ? null : (chosen?.p.phone ?? null);
                if (fill) {
                  // Written only where the phone is still empty, whatever was read.
                  const wrote = await tx.customer.updateMany({
                    where: { id: customerId, OR: [{ primaryPhoneNorm: null }, { primaryPhoneNorm: '' }] },
                    data: {
                      primaryPhone: fill,
                      primaryPhoneNorm: fill,
                      lastEditedById: me.id,
                      // B-05: a writer that read this customer before the import
                      // committed (a versioned updateMany) fails instead of writing over it.
                      version: { increment: 1 },
                    },
                  });
                  if (wrote.count === 1) {
                    await tx.customer.updateMany({
                      where: { id: customerId, temixSyncState: { in: ['SYNCED', 'UPLOADED'] } },
                      data: { temixSyncState: 'PENDING_UPLOAD', temixSyncPendingSince: new Date() },
                    });
                    phoneNow = fill;
                  }
                }
                const stored = {
                  legalName: now.legalName,
                  primaryPhoneNorm: phoneNow,
                  crNumberNorm: now.crNumberNorm,
                  contactPerson: now.contactPerson,
                  channelKey: now.channel?.key ?? null,
                };
                g.parsed.forEach((p, i) => {
                  if (!isFixed[i]) return;
                  const extra = branchOnlyNote(
                    unwrittenCustomerCells(readCorrections(g.corrections[i]), p, stored)
                  );
                  if (extra) rowNotes[i] = { ...rowNotes[i], extra };
                });
              }
            }
            await tx.importRow.updateMany({
              where: { id: { in: g.rowIds } },
              data: { state: ImportRowState.PROMOTED, reviewedById: me.id, reviewedAt: new Date() },
            });
            // Compute completenessScore for the promoted customer. Without this,
            // every imported customer/branch stayed at 0, hiding them from
            // completeness-filtered worklists and skewing dashboard averages.
            // F21 (auditor recheck 2026-09-27): and every live branch's, in
            // every lane, under the lock held since the top. Only the customer
            // was rescored, so a branch the import created stayed at 0 and one
            // it changed kept its old score — the leaderboards read those.
            // lib/rescore.ts writes only the scores that differ, in raw SQL, so
            // a branch this group did not change keeps its updatedAt and version.
            await rescoreCustomerTx(tx, [customerId]);
          },
          // Bounded deliberately: the worst case a slice can produce is its budget
          // plus ONE long transaction, which still lands well inside maxDuration=60.
          { timeout: 20_000, maxWait: 10_000 }
        );
        promoted += g.rowIds.length;
        if (clearedSubChannelOf) {
          // Ids only: no name, phone or channel value.
          logger.info({ customerId: clearedSubChannelOf, batchId }, 'import.promote.subchannel_cleared');
        }
        // A full-lane row carries a note only when its customer's sub-channel
        // was cleared (F16, on the lead row).
        const noted = refreshedRow || rowNotes.some((n) => !!n?.extra || !!n?.subChannel);
        if (noted) {
          // The branch outcome of each row: a branch left as it was, and why, or
          // what a fixed row did not write. It used to be invisible — the row
          // read PROMOTED and the counts balanced while the branch it described
          // was never written.
          await writeLaneNotes(g.rowIds, rowNotes, groupResolveErrors).catch(() => undefined);
        }
        // Not when the notes were written: writeLaneNotes puts these same
        // warnings on every row whose branch was written, which on the full
        // lane is every row, and this would overwrite the note.
        if (groupResolveErrors.length > 0 && !noted) {
          // F-17: surface the phantom-region warning in the row's issues so the
          // Steward can fix the reference data and re-run the import. Row stays
          // PROMOTED (the customer landed) but with a visible warning.
          // Skipped for refresh rows — their branches were deliberately never
          // touched, so a "assigned to UNASSIGNED" warning would be false.
          await prisma.importRow
            .updateMany({
              where: { id: { in: g.rowIds } },
              data: {
                issues: groupResolveErrors.map((m) => ({
                  field: '_resolve',
                  message: m,
                })) as Prisma.InputJsonValue,
              },
            })
            .catch(() => undefined);
        }
      } catch (err) {
        // F-15: NEVER log the raw Prisma error message — it embeds the value
        // that triggered the constraint (phone, CR number) and would leak PII
        // into pino/Sentry. Log a structured short code + safe identifier
        // only.
        const code = (err as { code?: string })?.code ?? 'UNKNOWN';
        const meta = (err as { meta?: { target?: string[] } })?.meta?.target;
        // Phase 1 Temix crosswalk conflicts carry a deliberate, PII-safe
        // message (codes only, never phone/CR values) for the Steward.
        const crosswalk =
          err instanceof Error && err.message.startsWith('CROSSWALK:')
            ? err.message.slice('CROSSWALK:'.length)
            : null;

        // RK-3: a group that failed because the DATABASE hiccuped is NOT a rejected
        // customer. Rejecting it would be permanent — a REJECTED row leaves CLEAN,
        // so no later slice ever retries it and no screen offers to requeue it — and
        // the batch would still finish green, quietly short of customers.
        //
        // This matters far more now than before: promote used to be one short
        // request, and is now minutes of work across dozens of them, which is
        // exactly the window in which a pool timeout, a Neon compute resume or a
        // dropped connection shows up on go-live day.
        //
        // So: leave those rows CLEAN and let the next slice retry them. If the
        // failure is actually permanent the run stops on its own — the caller's
        // stall guard sees a slice that reduced nothing — which is a loud, visible,
        // retryable outcome instead of a silent loss.
        if (!crosswalk && isTransientDbError(err, code)) {
          deferred += g.rowIds.length;
          logger.warn({ code, custCode, batchId }, 'import.promote.row_deferred');
          continue;
        }

        // A CHECK violation carries NO Prisma code, so this used to read "promote
        // failed (UNKNOWN)" and tell the Steward nothing whatsoever — 26 customers
        // failed three consecutive loads on 2026-09-23 with that message and the
        // cause had to be found by hand, against the database, hours later.
        //
        // F-15 forbids putting the raw Prisma message in here, and rightly: it
        // embeds the value that broke the constraint, which for this table can be a
        // phone or a CR number. But the CONSTRAINT NAME is not a value — it is a
        // schema identifier, fixed at migration time and identical for every row
        // that trips it. Extracting just that name is PII-safe and is the whole
        // difference between "UNKNOWN" and "Branch_address_minlength".
        const constraintName = /constraint "([A-Za-z0-9_]+)"/.exec(
          err instanceof Error ? err.message : ''
        )?.[1];

        logger.warn(
          { code, target: meta, constraint: constraintName, custCode, batchId, crosswalk: !!crosswalk },
          'import.promote.row_failed'
        );
        // Mark the failed row(s) REJECTED in a SEPARATE transaction so the
        // failure persists even though the row-level promote rolled back.
        const reason =
          crosswalk ??
          (code === 'P2002'
            ? `duplicate ${(meta ?? []).join(', ')}`
            : constraintName
              ? `the database refused this row: ${constraintName} — steward review`
              : `promote failed (${code})`);
        try {
          await prisma.importRow.updateMany({
            where: { id: { in: g.rowIds } },
            data: {
              state: ImportRowState.REJECTED,
              issues: [{ field: '_promote', message: reason }] as Prisma.InputJsonValue,
              reviewedById: me.id,
              reviewedAt: new Date(),
            },
          });
        } catch (e) {
          logger.error({ err: (e as Error).message?.slice(0, 80), batchId }, 'import.mark_failed');
        }
        failures.push({ custCode, rowIds: g.rowIds, reason });
      }
    }

    // RK-3: rows leave CLEAN as they are promoted or rejected, so ONE grouped count
    // yields both the work remaining and the authoritative totals.
    //
    // The counters are DERIVED from the row states rather than incremented per
    // slice, which makes them self-healing. Incrementing loses count whenever a
    // slice commits its rows but dies before updating the batch — an interrupted
    // UAT load did exactly that and reported 294 promoted against 299 rows actually
    // promoted, understating a load the operator has to trust.
    const stateCounts = await prisma.importRow.groupBy({
      by: ['state'],
      where: { batchId },
      _count: { _all: true },
    });
    const countOf = (s: ImportRowState) => stateCounts.find((c) => c.state === s)?._count._all ?? 0;
    const remaining = countOf(ImportRowState.CLEAN);
    const done = remaining === 0;

    // GUARDED by our own token: if this slice ran long and the batch was taken over,
    // the new owner is authoritative and we must not write status, counters, or the
    // lease. Our committed rows are already durable and their counters are derived,
    // so the new owner's next slice reports them correctly.
    const finalize = await prisma.importBatch.updateMany({
      where: { id: batchId, promoteLeaseBy: leaseToken },
      data: {
        // Stay PROMOTING while work remains — that state now means "in progress or
        // interrupted, resumable". Only the slice that clears the last CLEAN row
        // finalises the batch.
        status: done ? 'PROMOTED' : 'PROMOTING',
        promotedRows: countOf(ImportRowState.PROMOTED),
        rejectedRows: countOf(ImportRowState.REJECTED),
        // Done → release outright. Otherwise hold a SHORT grace so the batch still
        // reads as "in progress" until this run comes back (it returns immediately,
        // carrying the token), while an abandoned run frees it in seconds.
        promoteLeaseBy: done ? null : leaseToken,
        promoteLeaseUntil: done ? null : new Date(Date.now() + PROMOTE_HANDOFF_GRACE_MS),
      },
    });
    if (finalize.count === 0) {
      logger.warn({ batchId }, 'import.promote.lease_lost');
    }

    // F-19: per-batch summary audit log. Without this, "what happened in last
    // week's import?" requires SQL spelunking. The row carries the actor, the
    // counts, and the failure list (codes only — no embedded values).
    // DG-06/07: the swallow stays — the durable record of this slice is the
    // ImportBatch counters written just above plus every ImportRow's own
    // PROMOTED/REJECTED state, and throwing here would abort a slice whose
    // customer rows are already committed, sending the batch down the catch
    // path that releases the lease. The loss is already logged, which is what
    // makes keeping it defensible.
    await writeAudit(null, env, {
      action: 'IMPORT',
      entityType: 'ImportBatch',
      entityId: batchId,
      after: {
        kind: 'CUSTOMER',
        totalGroups: groups.size,
        groupsInSlice: processedGroups,
        promoted,
        failed: failures.length,
        deferred,
        remaining,
        final: done,
        failureCustCodes: failures.map((f) => f.custCode).slice(0, 100),
      } as unknown as Prisma.InputJsonValue,
      // One audit row per slice: a resumed load leaves a complete, ordered trail
      // instead of a single summary that hides how the batch actually landed.
      reason: done ? 'customer_master_promote' : 'customer_master_promote_slice',
    }).catch((e) => {
      logger.warn({ err: (e as Error).message?.slice(0, 80) }, 'import.audit_failed');
    });

    // GAP-2 (2026-09-24): a load that rejected rows told nobody. The counters are
    // on the batch page and the reasons are on the rows, but a Steward who closed
    // the tab believing "promote finished" had no way to learn that 1,833 of them
    // did not land — which is exactly what happened on 2026-09-23, twice.
    //
    // ONE alert for the whole batch, never one per row: it fires only on the slice
    // that cleared the last CLEAN row (`done`) and only when that slice still held
    // the lease — a run that lost the batch must leave the alert to the owner that
    // finalised it, or a resumed load posts twice for the same finish. Rejections
    // are counted from the row states, which are the authoritative totals for the
    // whole batch rather than this slice's share.
    //
    // No customer identifiers: counts and the batch id, which is the /import/ URL
    // segment the operator needs. `failureCustCodes` stays in the audit row, where
    // it is behind authentication — a webhook is a third party.
    //
    // The decision is lib/import-rejection-alert.ts, tested by behaviour; what is
    // pinned here is only that it is handed THIS batch's row states and THIS
    // slice's finalize result.
    // A fixed batch is promoted again, and each finish used to re-send the
    // alert for every REJECTED row — including the ones already excluded.
    const excludedRejected =
      done && finalize.count > 0
        ? await prisma.importRow.count({
            where: { batchId, state: ImportRowState.REJECTED, excludedAt: { not: null } },
          })
        : 0;
    const rejectionAlert = importRejectionAlert({
      batchId,
      stateCounts,
      finalisedByThisSlice: finalize.count > 0,
      groups: groups.size,
      excludedRejected,
    });
    if (rejectionAlert) await sendAlert(rejectionAlert);

    // Only the FINAL slice revalidates. An intermediate slice revalidating would
    // re-render the batch page (and re-run its queries) after every pass — dozens of
    // wasted round trips during a big load, slowing the very loop it interrupts. The
    // button reports its own progress meanwhile, and refreshes when the loop ends.
    if (done) {
      revalidatePath('/import');
      revalidatePath(`/import/${batchId}`); // otherwise the detail page keeps the stale READY view + a live Promote button
    }
    return {
      promoted,
      failed: failures.length,
      deferred,
      remaining,
      done,
      // Only hand the token back while the run should continue, and only if we still
      // hold the batch — a lost lease must stop the run, not let it fight the new owner.
      ...(done || finalize.count === 0 ? {} : { leaseToken }),
    };
  } catch (err) {
    // Release the lease so the batch is never stranded (final-hunt #23). The status
    // stays PROMOTING, which under RK-3 means "interrupted, resumable" rather than a
    // dead end — the work already committed by earlier slices is kept, and the
    // Steward (or the expiring lease) can pick it up again. Marking it FAILED here
    // would throw away a half-finished master load.
    // Guard on status=PROMOTING so we never clobber a batch another action moved on.
    // Guarded by our token for the same reason as the success path: if the batch was
    // already taken over, releasing here would clear the NEW owner's lease.
    await prisma.importBatch
      .updateMany({
        where: { id: batchId, status: 'PROMOTING', promoteLeaseBy: leaseToken },
        data: { promoteLeaseBy: null, promoteLeaseUntil: null },
      })
      .catch(() => {});
    logger.error({ err: (err as Error).message?.slice(0, 120), batchId }, 'import.promote_aborted');
    throw err;
  }
}

// helper to format counter-style code if NMWC code is missing in input
export { formatCustomerCode };
