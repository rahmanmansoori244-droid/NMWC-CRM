'use server';

import { prisma } from '@/lib/db';
import { Role, ImportRowState, type Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { parseWorkbook } from '@/lib/excel';
import { normalizePhone, isValidPhoneFormat } from '@/lib/phone';
import { normalizeCR } from '@/lib/cr';
import { formatCustomerCode, formatBranchCode } from '@/lib/codes';
import bcrypt from 'bcryptjs';
import { logger } from '@/lib/logger';

async function requireSteward() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  if (session.user.role !== Role.STEWARD && session.user.role !== Role.MANAGER) {
    throw new ForbiddenError('Only the Data Steward or a Manager can run imports.');
  }
  return session.user;
}

// ── Account master import (regions, routes, users) ────────────────────────
//
// Expected sheets (any subset, in this order of dependencies):
//   1. "Regions"   — columns: code, name
//   2. "Routes"    — columns: code, name, region_code
//   3. "Users"     — columns: username, full_name, role, password,
//                                 supervisor_username (opt), route_code (opt for SALESMAN),
//                                 region_codes (opt comma-separated for MANAGER), email (opt), phone (opt)

const VALID_ROLES: Role[] = [Role.SALESMAN, Role.SUPERVISOR, Role.MANAGER, Role.STEWARD, Role.VIEWER];

function lc(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}
function uc(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}

// QA-012: hard cap on uploaded xlsx (zip-bomb defense)
const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB

export async function uploadAccountMasterAction(formData: FormData) {
  const me = await requireSteward();
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

  // 1) Regions
  const regionsSheet = sheets.find((s) => s.name.toLowerCase() === 'regions');
  if (regionsSheet) {
    for (const [i, row] of regionsSheet.rows.entries()) {
      const code = uc(row.code ?? row.Code);
      const name = String(row.name ?? row.Name ?? '').trim();
      if (!code || !name) {
        issues.push({ sheet: 'Regions', row: i + 2, message: 'code and name required' });
        continue;
      }
      try {
        await prisma.region.upsert({
          where: { code },
          update: { name },
          create: { code, name },
        });
        cleanCount++;
      } catch (err) {
        issues.push({ sheet: 'Regions', row: i + 2, message: (err as Error).message });
      }
    }
  }

  // 2) Routes
  const routesSheet = sheets.find((s) => s.name.toLowerCase() === 'routes');
  if (routesSheet) {
    for (const [i, row] of routesSheet.rows.entries()) {
      const code = uc(row.code ?? row.Code);
      const name = String(row.name ?? row.Name ?? '').trim();
      const regionCode = uc(row.region_code ?? row.regionCode ?? row.region);
      if (!code || !name || !regionCode) {
        issues.push({
          sheet: 'Routes',
          row: i + 2,
          message: 'code, name, region_code required',
        });
        continue;
      }
      const region = await prisma.region.findUnique({ where: { code: regionCode } });
      if (!region) {
        issues.push({ sheet: 'Routes', row: i + 2, message: `region "${regionCode}" not found` });
        continue;
      }
      try {
        await prisma.route.upsert({
          where: { code },
          update: { name, regionId: region.id },
          create: { code, name, regionId: region.id },
        });
        cleanCount++;
      } catch (err) {
        issues.push({ sheet: 'Routes', row: i + 2, message: (err as Error).message });
      }
    }
  }

  // 3) Users (two passes — supervisors first, then everyone else linking by username)
  const usersSheet = sheets.find((s) => s.name.toLowerCase() === 'users');
  if (usersSheet) {
    const sortedRows = [...usersSheet.rows].sort((a, b) => {
      const ra = uc(a.role);
      const rb = uc(b.role);
      const order = ['MANAGER', 'STEWARD', 'SUPERVISOR', 'SALESMAN', 'VIEWER'];
      return order.indexOf(ra) - order.indexOf(rb);
    });
    for (const [i, row] of sortedRows.entries()) {
      const username = lc(row.username);
      const fullName = String(row.full_name ?? row.fullName ?? row.name ?? '').trim();
      const roleStr = uc(row.role);
      const passwordRaw = String(row.password ?? '').trim();
      // QA-010: passwords must be EXPLICITLY requested via reset_password column,
      // OR provided ONLY for new users. Existing users keep their existing hash.
      const wantsReset = String(row.reset_password ?? row.resetPassword ?? '')
        .trim()
        .toLowerCase() === 'yes';
      // QA-011: role changes must be EXPLICITLY requested via change_role column.
      const wantsRoleChange = String(row.change_role ?? row.changeRole ?? '')
        .trim()
        .toLowerCase() === 'yes';
      const supUsername = lc(row.supervisor_username ?? row.supervisorUsername ?? '');
      const routeCode = uc(row.route_code ?? row.routeCode ?? '');
      const regionCodesRaw = String(row.region_codes ?? row.regionCodes ?? '').trim();
      const email = String(row.email ?? '').trim() || null;
      const phone = String(row.phone ?? '').trim() || null;

      if (!username || !fullName || !roleStr) {
        issues.push({
          sheet: 'Users',
          row: i + 2,
          message: 'username, full_name, role required',
        });
        continue;
      }
      if (!VALID_ROLES.includes(roleStr as Role)) {
        issues.push({
          sheet: 'Users',
          row: i + 2,
          message: `role "${roleStr}" not one of ${VALID_ROLES.join(', ')}`,
        });
        continue;
      }
      if (passwordRaw && passwordRaw.length < 12) {
        issues.push({ sheet: 'Users', row: i + 2, message: 'password must be 12+ chars' });
        continue;
      }

      // QA-011 — Steward cannot escalate themselves. Block any row that tries
      // to change the calling user's own role.
      if (username === me.username && wantsRoleChange && roleStr !== me.role) {
        issues.push({
          sheet: 'Users',
          row: i + 2,
          message: 'cannot change your own role via import',
        });
        continue;
      }

      const role = roleStr as Role;
      let supervisorId: string | null = null;
      if (supUsername) {
        const sup = await prisma.user.findUnique({ where: { username: supUsername } });
        if (!sup) {
          issues.push({
            sheet: 'Users',
            row: i + 2,
            message: `supervisor "${supUsername}" not found`,
          });
          continue;
        }
        supervisorId = sup.id;
      }

      let ownedRouteId: string | null = null;
      if (role === Role.SALESMAN) {
        if (!routeCode) {
          issues.push({ sheet: 'Users', row: i + 2, message: 'salesman needs route_code' });
          continue;
        }
        const route = await prisma.route.findUnique({ where: { code: routeCode } });
        if (!route) {
          issues.push({
            sheet: 'Users',
            row: i + 2,
            message: `route "${routeCode}" not found`,
          });
          continue;
        }
        // Detach previous owner if reassigning
        await prisma.user.updateMany({
          where: { ownedRouteId: route.id, NOT: { username } },
          data: { ownedRouteId: null },
        });
        ownedRouteId = route.id;
      }

      // QA-010 / QA-011: only set passwordHash + role on INSERT or when
      // explicitly requested. On a normal re-import, existing users keep
      // their existing password and role.
      const existing = await prisma.user.findUnique({ where: { username } });
      let passwordHash: string;
      if (existing) {
        if (wantsReset) {
          if (!passwordRaw) {
            issues.push({
              sheet: 'Users',
              row: i + 2,
              message: 'reset_password=yes but no password provided',
            });
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
            row: i + 2,
            message: 'new user needs a password',
          });
          continue;
        }
        passwordHash = await bcrypt.hash(passwordRaw, 12);
      }

      const update: Prisma.UserUpdateInput = {
        fullName,
        email,
        phone,
        supervisor: supervisorId ? { connect: { id: supervisorId } } : { disconnect: true },
        ownedRoute: ownedRouteId ? { connect: { id: ownedRouteId } } : { disconnect: true },
      };
      // Only rotate password / role when explicitly authorised
      if (wantsReset) update.passwordHash = passwordHash;
      if (!existing || wantsRoleChange) update.role = role;

      const data: Prisma.UserCreateInput = {
        username,
        passwordHash,
        fullName,
        role,
        email,
        phone,
      };
      if (supervisorId) data.supervisor = { connect: { id: supervisorId } };
      if (ownedRouteId) data.ownedRoute = { connect: { id: ownedRouteId } };

      try {
        const user = await prisma.user.upsert({
          where: { username },
          update,
          create: data,
        });
        // Audit any sensitive change
        if (existing && wantsReset) {
          await prisma.auditLog.create({
            data: {
              actorId: me.id,
              action: 'UPDATE',
              entityType: 'User',
              entityId: user.id,
              reason: 'password_reset_via_import',
            },
          });
        }
        if (existing && wantsRoleChange && existing.role !== role) {
          await prisma.auditLog.create({
            data: {
              actorId: me.id,
              action: 'UPDATE',
              entityType: 'User',
              entityId: user.id,
              before: { role: existing.role } as unknown as Prisma.InputJsonValue,
              after: { role } as unknown as Prisma.InputJsonValue,
              reason: 'role_change_via_import',
            },
          });
        }

        // Manager region assignments
        if (role === Role.MANAGER && regionCodesRaw) {
          const codes = regionCodesRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
          const regions = await prisma.region.findMany({ where: { code: { in: codes } } });
          await prisma.user.update({
            where: { id: user.id },
            data: { managedRegions: { set: regions.map((r) => ({ id: r.id })) } },
          });
        }
        cleanCount++;
      } catch (err) {
        issues.push({ sheet: 'Users', row: i + 2, message: (err as Error).message });
      }
    }
  }

  await prisma.importBatch.update({
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
    await prisma.importRow.createMany({
      data: issues.map((iss, idx) => ({
        batchId: batch.id,
        rowNumber: idx + 1,
        raw: iss as unknown as Prisma.InputJsonValue,
        state: ImportRowState.QUARANTINED,
        issues: [{ message: iss.message, sheet: iss.sheet, row: iss.row }] as Prisma.InputJsonValue,
      })),
    });
  }

  logger.info(
    { batchId: batch.id, clean: cleanCount, issues: issues.length },
    'import.account.complete'
  );
  revalidatePath('/import');
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

export async function uploadCustomerMasterAction(formData: FormData) {
  const me = await requireSteward();
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
  for (const [i, row] of sheet.rows.entries()) {
    const issues: { field: string; message: string }[] = [];
    const custCode = String(
      row.cust_code ?? row.custcode ?? row.CUSTCODE ?? row.code ?? row.Code ?? ''
    ).trim();
    const custName = String(row.cust_name ?? row['CUST NAME'] ?? row.name ?? '').trim();
    const phone = normalizePhone(
      String(row.phone ?? row.PHONE ?? row['Primary Phone'] ?? '').trim() || null
    );
    const phoneRaw = String(row.phone ?? '').trim();

    if (!custCode) issues.push({ field: 'cust_code', message: 'required' });
    if (!custName) issues.push({ field: 'cust_name', message: 'required' });
    if (phoneRaw && !isValidPhoneFormat(phoneRaw)) {
      issues.push({ field: 'phone', message: 'invalid format' });
    }

    const parsed = {
      custCode,
      custName,
      branchCode: String(row.branch_code ?? row['CUST BRANCH'] ?? '').trim() || null,
      branchName: String(row.branch_name ?? row['CUST BRANCH'] ?? row.branch ?? '').trim() || null,
      regionCode: String(row.sales_region ?? row['SALES REGION'] ?? row.region ?? '').trim() || null,
      routeCode: String(row.route ?? row['ROUTE'] ?? '').trim() || null,
      address: String(row.address ?? row.ADDRSS ?? row.ADDRESS ?? '').trim() || null,
      phone,
      contactPerson: String(row.contact_person ?? row['CONTACT PERSON'] ?? '').trim() || null,
      crNumber: String(row.cr_no ?? row['CR NO'] ?? '').trim() || null,
      paymentTerms: String(row.payment_terms ?? row['PAYMENT TERMS'] ?? 'CASH')
        .trim()
        .toUpperCase(),
    };

    importRows.push({
      batchId: batch.id,
      rowNumber: i + 2,
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

export async function promoteCustomerBatchAction(formData: FormData) {
  const me = await requireSteward();
  const batchId = String(formData.get('batchId') ?? '');
  if (!batchId) throw new ValidationError({ batchId: 'required' });
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new ValidationError({ batchId: 'not found' });
  if (batch.kind !== 'CUSTOMER') throw new ValidationError({ batchId: 'not a customer import' });

  const cleanRows = await prisma.importRow.findMany({
    where: { batchId, state: ImportRowState.CLEAN },
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
  };
  const groups = new Map<string, { rowIds: string[]; parsed: ParsedShape[] }>();
  for (const row of cleanRows) {
    const p = row.parsed as unknown as ParsedShape | null;
    if (!p?.custCode) continue;
    const g = groups.get(p.custCode) ?? { rowIds: [], parsed: [] };
    g.rowIds.push(row.id);
    g.parsed.push(p);
    groups.set(p.custCode, g);
  }

  // Build region+route caches and ensure UNASSIGNED route exists
  let unassignedRoute = await prisma.route.findUnique({ where: { code: 'UNASSIGNED' } });
  if (!unassignedRoute) {
    let unassignedRegion = await prisma.region.findUnique({ where: { code: 'UNASSIGNED' } });
    if (!unassignedRegion) {
      unassignedRegion = await prisma.region.create({
        data: { code: 'UNASSIGNED', name: 'Unassigned' },
      });
    }
    unassignedRoute = await prisma.route.create({
      data: { code: 'UNASSIGNED', name: 'Unassigned', regionId: unassignedRegion.id },
    });
  }

  // QA-019: each customer's promotion (parent + branches + row state) runs
  // in its own transaction so a partial failure leaves no half-state.
  let promoted = 0;
  for (const [custCode, g] of groups) {
    const first = g.parsed[0];

    // Pre-resolve regions and routes outside the transaction (these are upserts
    // that can be repeated safely across batches).
    const resolvedBranches: Array<{
      branchCode: string;
      branchName: string;
      regionId: string;
      routeId: string;
      address: string;
    }> = [];
    for (const [bi, p] of g.parsed.entries()) {
      const region = p.regionCode
        ? await prisma.region.upsert({
            where: { code: p.regionCode.toUpperCase() },
            update: {},
            create: { code: p.regionCode.toUpperCase(), name: p.regionCode },
          })
        : null;
      const route = p.routeCode
        ? await prisma.route.upsert({
            where: { code: p.routeCode.toUpperCase() },
            update: {},
            create: {
              code: p.routeCode.toUpperCase(),
              name: p.routeCode,
              regionId: (region ?? unassignedRoute!).id,
            },
          })
        : unassignedRoute!;
      resolvedBranches.push({
        branchCode: p.branchCode
          ? p.branchCode.toUpperCase()
          : formatBranchCode(custCode, bi + 1),
        branchName: p.branchName ?? 'Main',
        regionId: (region ?? unassignedRoute!).id,
        routeId: (route ?? unassignedRoute!).id,
        address:
          p.address ??
          [p.branchName, p.regionCode].filter(Boolean).join(', ') ??
          'Address pending',
      });
    }

    try {
      await prisma.$transaction(async (tx) => {
        const customer = await tx.customer.upsert({
          where: { nmwcCode: custCode },
          update: {
            legalName: first.custName,
            paymentTerms: first.paymentTerms === 'CREDIT' ? 'CREDIT' : 'CASH',
            primaryPhone: first.phone,
            primaryPhoneNorm: first.phone,
            contactPerson: first.contactPerson,
            crNumber: first.crNumber,
            crNumberNorm: normalizeCR(first.crNumber),
            lastEditedById: me.id,
          },
          create: {
            nmwcCode: custCode,
            legalName: first.custName,
            paymentTerms: first.paymentTerms === 'CREDIT' ? 'CREDIT' : 'CASH',
            primaryPhone: first.phone,
            primaryPhoneNorm: first.phone,
            contactPerson: first.contactPerson,
            crNumber: first.crNumber,
            crNumberNorm: normalizeCR(first.crNumber),
            createdById: me.id,
            lastEditedById: me.id,
            importBatchId: batchId,
          },
        });
        for (const r of resolvedBranches) {
          await tx.branch.upsert({
            where: { branchCode: r.branchCode },
            update: {
              branchName: r.branchName,
              regionId: r.regionId,
              routeId: r.routeId,
              address: r.address,
              customerId: customer.id,
              lastEditedById: me.id,
            },
            create: {
              branchCode: r.branchCode,
              branchName: r.branchName,
              regionId: r.regionId,
              routeId: r.routeId,
              address: r.address,
              customerId: customer.id,
              createdById: me.id,
              lastEditedById: me.id,
            },
          });
        }
        await tx.importRow.updateMany({
          where: { id: { in: g.rowIds } },
          data: { state: ImportRowState.PROMOTED, reviewedById: me.id, reviewedAt: new Date() },
        });
      });
      promoted += g.rowIds.length;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message?.slice(0, 200), custCode },
        'import.promote.row_failed'
      );
    }
  }

  await prisma.importBatch.update({
    where: { id: batchId },
    data: { status: 'PROMOTED', promotedRows: promoted },
  });
  revalidatePath('/import');
  return { promoted };
}

// helper to format counter-style code if NMWC code is missing in input
export { formatCustomerCode };
