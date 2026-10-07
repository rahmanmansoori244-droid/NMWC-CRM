/**
 * Cleanup and the crash sweep.
 *
 * cleanupRegistry() is idempotent and re-runnable after a crash: it rebuilds the
 * world's fixture set from its registry file PLUS a search by the world's suffix
 * (so a row created after the last registry write is still found), deletes in
 * foreign-key order on the table owner's connection, then counts what is left by
 * id and by suffix in every table the suite touches. Only a zero count marks the
 * registry clean.
 *
 * What it will NOT delete, by design:
 *  - an R2 object whose key is not <ymd>/<fixture user id>/… (r2.ts refuses);
 *  - an edit, approval or import row that belongs to a REAL request and was only
 *    decided or reviewed by a fixture user (the FM/GM/Steward queues are
 *    org-wide). Such rows are counted as `foreign*` leftovers instead, and the
 *    fixture user they point at is left in place for a person to look at.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { hasR2, ownerDb, redact, RUN_ID } from './env';
import { utcYmd } from './oman';
import { deleteFixtureObject, listFixturePrefix } from './r2';
import { Registry, listRegistryFiles, ownedByLiveRun, type RegistryData } from './registry';

export type Residue = Record<string, number>;
export type CleanupResult = { leftovers: Residue; deleted: Record<string, number>; warnings: string[] };

type Fixture = {
  sfx: string;
  SFX: string;
  users: Set<string>;
  usernames: Set<string>;
  regions: Set<string>;
  routes: Set<string>;
  routeCodes: Set<string>;
  customers: Set<string>;
  branches: Set<string>;
  edits: Set<string>;
  attachments: Map<string, { r2Key: string; capturedById: string }>;
  notifications: Set<string>;
  importBatches: Set<string>;
  temixBatches: Set<string>;
  ips: Set<string>;
  ymds: Set<string>;
};

const CHUNK = 400;
const LOCALHOST_IPS = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];

function chunks<T>(xs: readonly T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** A suffix that could match real rows (empty, short, odd characters) stops everything. */
function assertSafeSuffix(sfx: string): void {
  if (!/^[a-z0-9]{6,20}$/.test(sfx)) throw new Error(`cleanup refused: unsafe world suffix "${sfx}"`);
}

/** Inside the owner's audit-maintenance window (the only way AuditLog/EditApproval rows can go). */
async function inMaintenance<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return ownerDb().$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL nmwc.audit_maintenance = 'on'`);
      return fn(tx);
    },
    { timeout: 120_000, maxWait: 30_000 }
  );
}

/** Every UTC day between the world's creation and now, as R2 lays keys out. */
function daysSince(createdAt: string): string[] {
  const out: string[] = [];
  // Ten minutes either side: the server and this process share one clock, but a
  // presign just before UTC midnight lands on the earlier day.
  const start = Date.parse(createdAt) - 600_000;
  for (let t = start; t <= Date.now() + 600_000; t += 86_400_000) out.push(utcYmd(new Date(t)));
  out.push(utcYmd(new Date(Date.now() + 600_000)), utcYmd());
  return [...new Set(out)];
}

/** Runs `fn` over `xs` with at most `n` in flight. */
async function mapLimit<T, R>(xs: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, worker));
  return out;
}

/** Every object under the fixture users' day folders — the only listing the suite performs. */
async function listFixtureObjects(f: Fixture): Promise<string[]> {
  const users = new Set(f.users);
  const pairs = [...f.ymds].flatMap((ymd) => [...users].map((u) => [ymd, u] as const));
  const lists = await mapLimit(pairs, 8, ([ymd, u]) => listFixturePrefix(ymd, u, users));
  return lists.flat();
}

const ci = (s: string) => ({ contains: s, mode: 'insensitive' as const });

async function collect(reg: RegistryData, p: PrismaClient): Promise<Fixture> {
  assertSafeSuffix(reg.sfx);
  const sfx = reg.sfx;
  const SFX = sfx.toUpperCase();
  const f: Fixture = {
    sfx,
    SFX,
    users: new Set(reg.userIds),
    usernames: new Set(reg.usernames),
    regions: new Set(reg.regionIds),
    routes: new Set(reg.routeIds),
    routeCodes: new Set(reg.routeCodes),
    customers: new Set(reg.customerIds),
    branches: new Set(reg.branchIds),
    edits: new Set(reg.editIds),
    attachments: new Map(),
    notifications: new Set(reg.notificationIds),
    importBatches: new Set(reg.importBatchIds),
    temixBatches: new Set(reg.temixBatchIds),
    ips: new Set(reg.ips),
    ymds: new Set([...reg.ymds, ...daysSince(reg.createdAt)]),
  };

  const regions = await p.region.findMany({
    where: {
      OR: [
        { id: { in: [...f.regions] } },
        { code: { startsWith: `E2R${SFX}` } },
        { code: { in: reg.regionCodes } },
        { name: ci(sfx) },
      ],
    },
    select: { id: true },
  });
  regions.forEach((r) => f.regions.add(r.id));

  const routes = await p.route.findMany({
    where: {
      OR: [
        { id: { in: [...f.routes] } },
        { code: { contains: SFX } },
        { code: { in: [...f.routeCodes] } },
        { name: ci(sfx) },
        { regionId: { in: [...f.regions] } },
      ],
    },
    select: { id: true, code: true },
  });
  routes.forEach((r) => {
    f.routes.add(r.id);
    f.routeCodes.add(r.code);
  });

  const users = await p.user.findMany({
    where: {
      OR: [
        { id: { in: [...f.users] } },
        { username: { in: [...f.usernames] } },
        { username: ci(sfx) },
        { fullName: ci(sfx) },
        { ownedRouteId: { in: [...f.routes] } },
      ],
    },
    select: { id: true, username: true },
  });
  users.forEach((u) => {
    f.users.add(u.id);
    f.usernames.add(u.username);
  });

  const [batches, temix] = await Promise.all([
    p.importBatch.findMany({
      where: { OR: [{ id: { in: [...f.importBatches] } }, { uploadedById: { in: [...f.users] } }] },
      select: { id: true },
    }),
    p.temixSyncBatch.findMany({
      where: { OR: [{ id: { in: [...f.temixBatches] } }, { createdById: { in: [...f.users] } }] },
      select: { id: true },
    }),
  ]);
  batches.forEach((b) => f.importBatches.add(b.id));
  temix.forEach((b) => f.temixBatches.add(b.id));

  // Branches on fixture routes make their customers fixtures (a real customer
  // can only reach a fixture route if a test moved it — which the rules forbid).
  const onRoutes = await p.branch.findMany({
    where: { OR: [{ routeId: { in: [...f.routes] } }, { branchCode: { contains: SFX } }, { branchName: ci(sfx) }] },
    select: { id: true, customerId: true },
  });
  onRoutes.forEach((b) => {
    f.branches.add(b.id);
    f.customers.add(b.customerId);
  });

  // Created through the CREATE chain: the finalized edit names its customer.
  const createdBy = await p.customerEdit.findMany({
    where: { submittedById: { in: [...f.users] }, process: 'CREATE', customerId: { not: null } },
    select: { customerId: true },
  });
  createdBy.forEach((e) => e.customerId && f.customers.add(e.customerId));

  const customers = await p.customer.findMany({
    where: {
      OR: [
        { id: { in: [...f.customers] } },
        { nmwcCode: { contains: SFX } },
        { legalName: ci(sfx) },
        { importBatchId: { in: [...f.importBatches] } },
        { createdById: { in: [...f.users] } },
      ],
    },
    select: { id: true },
  });
  customers.forEach((c) => f.customers.add(c.id));

  const branches = await p.branch.findMany({
    where: { OR: [{ id: { in: [...f.branches] } }, { customerId: { in: [...f.customers] } }] },
    select: { id: true },
  });
  branches.forEach((b) => f.branches.add(b.id));

  // Edits: submitted by a fixture user, or about a fixture customer/branch, or a
  // CREATE request whose drafted branch sits on a fixture route. NOT "decided by a
  // fixture user" alone — that would reach real requests in org-wide queues.
  const edits = await p.customerEdit.findMany({
    where: {
      OR: [
        { id: { in: [...f.edits] } },
        { submittedById: { in: [...f.users] } },
        { customerId: { in: [...f.customers] } },
        { branchId: { in: [...f.branches] } },
        { branchDrafts: { some: { OR: [{ routeId: { in: [...f.routes] } }, { regionId: { in: [...f.regions] } }] } } },
      ],
    },
    select: { id: true },
  });
  edits.forEach((e) => f.edits.add(e.id));

  const atts = await p.attachment.findMany({
    where: {
      OR: [
        { id: { in: reg.attachmentIds } },
        { capturedById: { in: [...f.users] } },
        { customerId: { in: [...f.customers] } },
        { branchId: { in: [...f.branches] } },
        { branchExtraId: { in: [...f.branches] } },
        { editId: { in: [...f.edits] } },
      ],
    },
    select: { id: true, r2Key: true, capturedById: true },
  });
  atts.forEach((a) => f.attachments.set(a.id, { r2Key: a.r2Key, capturedById: a.capturedById }));

  return f;
}

/** Ids of every fixture row — the entity ids an audit row can name. */
function allIds(f: Fixture): string[] {
  return [
    ...f.users,
    ...f.regions,
    ...f.routes,
    ...f.customers,
    ...f.branches,
    ...f.edits,
    ...f.attachments.keys(),
    ...f.importBatches,
    ...f.temixBatches,
  ];
}

function rateLimitKeys(f: Fixture): string[] {
  const keys: string[] = [];
  for (const u of f.usernames) keys.push(`login:user:${u}`);
  for (const ip of [...f.ips, ...LOCALHOST_IPS]) keys.push(`login:ip:${ip}`);
  for (const id of f.users) {
    for (const p of ['edit', 'photo', 'import', 'temix', 'temix-download', 'passwordreset']) keys.push(`${p}:${id}`);
  }
  return keys;
}

async function deleteR2(f: Fixture, reg: RegistryData, warnings: string[]): Promise<{ deleted: Set<string>; refused: Set<string> }> {
  const refused = new Set<string>();
  const deleted = new Set<string>();
  if (!hasR2) {
    if (f.attachments.size > 0 || reg.r2Keys.length > 0) warnings.push('R2 is not configured: objects were not checked');
    return { deleted, refused };
  }
  const users = new Set(f.users);
  const keys = new Set<string>([...reg.r2Keys]);
  for (const a of f.attachments.values()) keys.add(a.r2Key);
  // Presigned but never finalized (the browser PUT and then stopped): list each
  // fixture user's day folders — the only listing the suite ever performs.
  for (const k of await listFixtureObjects(f)) keys.add(k);
  await mapLimit([...keys], 8, async (key) => {
    try {
      await deleteFixtureObject(key, users);
      deleted.add(key);
    } catch (err) {
      refused.add(key);
      warnings.push(redact(String((err as Error).message)));
    }
  });
  return { deleted, refused };
}

async function deleteRows(f: Fixture, reg: RegistryData, refusedKeys: Set<string>, warnings: string[]): Promise<Record<string, number>> {
  const p = ownerDb();
  const n: Record<string, number> = {};
  const add = (k: string, c: number) => (n[k] = (n[k] ?? 0) + c);
  const users = [...f.users];
  const customers = [...f.customers];
  const branches = [...f.branches];
  const edits = [...f.edits];

  // 0. Out of every org-wide audience first: CREATE finalize notifies every
  //    ACTIVE Steward, the FM/GM steps every active FM/GM — whoever's request it
  //    is (a real one, another suite's). A fixture Steward/FM/GM that stays
  //    active keeps receiving rows while this runs, and a row that lands after
  //    step 1 blocks the user's delete in step 8.
  for (const c of chunks(users)) await p.user.updateMany({ where: { id: { in: c } }, data: { isActive: false } });

  // 1. Notifications — by user, by edit, by customer. CREATE finalize and the
  //    FM/GM steps notify REAL users; those rows are found through editId only.
  const notes = await p.notification.findMany({
    where: {
      OR: [
        { id: { in: reg.notificationIds } },
        { userId: { in: users } },
        { editId: { in: edits } },
        { customerId: { in: customers } },
      ],
    },
    select: { id: true },
  });
  for (const c of chunks(notes.map((x) => x.id))) add('Notification', (await p.notification.deleteMany({ where: { id: { in: c } } })).count);

  // 2. Photo slot pointers, so the attachments can go.
  for (const c of chunks(customers)) await p.customer.updateMany({ where: { id: { in: c } }, data: { crPhotoId: null } });
  for (const c of chunks(branches))
    await p.branch.updateMany({ where: { id: { in: c } }, data: { shopPhotoId: null, signboardPhotoId: null } });

  // 3. Step ledger and edits (drafts cascade), in the maintenance window, batched.
  for (const c of chunks(edits)) {
    await inMaintenance(async (tx) => {
      add('EditApproval', (await tx.editApproval.deleteMany({ where: { editId: { in: c } } })).count);
      add('CustomerEdit', (await tx.customerEdit.deleteMany({ where: { id: { in: c } } })).count);
    });
  }

  // 4. Temix batches, export jobs, import rows and batches of fixture users.
  add('TemixSyncBatch', (await p.temixSyncBatch.deleteMany({ where: { id: { in: [...f.temixBatches] } } })).count);
  add('ExportJob', (await p.exportJob.deleteMany({ where: { requestedById: { in: users } } })).count);

  // 5. Attachments (not the ones whose object the R2 guard refused), branches, customers.
  const attIds = [...f.attachments.entries()].filter(([, a]) => !refusedKeys.has(a.r2Key)).map(([id]) => id);
  for (const c of chunks(attIds)) add('Attachment', (await p.attachment.deleteMany({ where: { id: { in: c } } })).count);
  for (const c of chunks(branches)) add('Branch', (await p.branch.deleteMany({ where: { id: { in: c } } })).count);
  for (const c of chunks(customers)) add('Customer', (await p.customer.deleteMany({ where: { id: { in: c } } })).count);
  for (const c of chunks([...f.importBatches])) {
    add('ImportRow', (await p.importRow.deleteMany({ where: { batchId: { in: c } } })).count);
    add('ImportBatch', (await p.importBatch.deleteMany({ where: { id: { in: c } } })).count);
  }

  // 6. Audit rows: by actor, by any fixture entity id, the 'unknown:<name>'
  //    sentinel, and duplicate-pair rows ('aId|bId') naming a fixture customer.
  const ids = allIds(f);
  const unknown = [...f.usernames].map((u) => `unknown:${u.slice(0, 50)}`);
  await inMaintenance(async (tx) => {
    for (const c of chunks(users)) add('AuditLog', (await tx.auditLog.deleteMany({ where: { actorId: { in: c } } })).count);
    for (const c of chunks([...ids, ...unknown]))
      add('AuditLog', (await tx.auditLog.deleteMany({ where: { entityId: { in: c } } })).count);
    for (const c of chunks(customers, 50)) {
      add(
        'AuditLog',
        (
          await tx.auditLog.deleteMany({
            where: { entityType: 'CustomerPair', OR: c.map((id) => ({ entityId: { contains: id } })) },
          })
        ).count
      );
    }
    // Fixture users' approvals on fixture edits are gone with the edits; any left
    // here sit on REAL requests and are reported, not deleted.
  });

  // 7. Password history, saved views, rate-limit buckets.
  add('PasswordHistory', (await p.passwordHistory.deleteMany({ where: { userId: { in: users } } })).count);
  add('SavedView', (await p.savedView.deleteMany({ where: { userId: { in: users } } })).count);
  for (const c of chunks(rateLimitKeys(f)))
    add('RateLimit', (await p.rateLimit.deleteMany({ where: { key: { in: c } } })).count);
  add('RateLimit', (await p.rateLimit.deleteMany({ where: { key: ci(f.sfx) } })).count);

  // 8. Users: unlink, then delete. One that a real request still points at
  //    (see the header) fails its foreign key and is reported, not forced.
  if (users.length > 0) {
    await p.user.updateMany({ where: { id: { in: users } }, data: { supervisorId: null, ownedRouteId: null } });
    await p.$executeRaw`DELETE FROM "_ManagerRegions" WHERE "B" = ANY(${users}::text[])`;
    // Again, right before the delete: anything addressed to them since step 1.
    for (const c of chunks(users)) add('Notification', (await p.notification.deleteMany({ where: { userId: { in: c } } })).count);
    try {
      add('User', (await p.user.deleteMany({ where: { id: { in: users } } })).count);
    } catch {
      for (const id of users) {
        try {
          add('User', (await p.user.deleteMany({ where: { id } })).count);
        } catch (err) {
          warnings.push(`user ${id} kept: ${redact(String((err as Error).message)).split('\n').slice(-1)[0]}`);
        }
      }
    }
  }

  // 9. Routes, then regions.
  for (const c of chunks([...f.routes])) add('Route', (await p.route.deleteMany({ where: { id: { in: c } } })).count);
  for (const c of chunks([...f.regions])) add('Region', (await p.region.deleteMany({ where: { id: { in: c } } })).count);
  return n;
}

/** What is left of a world, by id AND by suffix, in every table the suite touches. */
export async function residue(reg: RegistryData, known?: Fixture): Promise<Residue> {
  const p = ownerDb();
  const f = known ?? (await collect(reg, p));
  const sfx = f.sfx;
  const SFX = f.SFX;
  const users = [...f.users];
  const ids = allIds(f);
  const keys = rateLimitKeys(f);
  const [
    User,
    Region,
    Route,
    Customer,
    Branch,
    CustomerEdit,
    EditApproval,
    Attachment,
    Notification,
    AuditLog,
    RateLimit,
    PasswordHistory,
    ImportBatch,
    TemixSyncBatch,
  ] = await Promise.all([
    p.user.count({ where: { OR: [{ id: { in: users } }, { username: ci(sfx) }, { fullName: ci(sfx) }, { username: { in: [...f.usernames] } }] } }),
    p.region.count({ where: { OR: [{ id: { in: [...f.regions] } }, { code: { contains: SFX } }, { name: ci(sfx) }] } }),
    p.route.count({ where: { OR: [{ id: { in: [...f.routes] } }, { code: { contains: SFX } }, { code: { in: [...f.routeCodes] } }, { name: ci(sfx) }] } }),
    p.customer.count({ where: { OR: [{ id: { in: [...f.customers] } }, { nmwcCode: { contains: SFX } }, { legalName: ci(sfx) }] } }),
    p.branch.count({ where: { OR: [{ id: { in: [...f.branches] } }, { branchCode: { contains: SFX } }, { branchName: ci(sfx) }] } }),
    p.customerEdit.count({ where: { OR: [{ id: { in: [...f.edits] } }, { submittedById: { in: users } }, { reviewedById: { in: users } }] } }),
    p.editApproval.count({ where: { OR: [{ editId: { in: [...f.edits] } }, { actorId: { in: users } }] } }),
    p.attachment.count({ where: { OR: [{ id: { in: [...f.attachments.keys()] } }, { capturedById: { in: users } }] } }),
    p.notification.count({
      where: { OR: [{ userId: { in: users } }, { editId: { in: [...f.edits] } }, { customerId: { in: [...f.customers] } }, { title: ci(sfx) }, { body: ci(sfx) }] },
    }),
    p.auditLog.count({ where: { OR: [{ actorId: { in: users } }, { entityId: { in: ids } }] } }),
    p.rateLimit.count({ where: { OR: [{ key: { in: keys.filter((k) => !LOCALHOST_IPS.some((ip) => k === `login:ip:${ip}`)) } }, { key: ci(sfx) }] } }),
    p.passwordHistory.count({ where: { userId: { in: users } } }),
    p.importBatch.count({ where: { OR: [{ id: { in: [...f.importBatches] } }, { uploadedById: { in: users } }] } }),
    p.temixSyncBatch.count({ where: { OR: [{ id: { in: [...f.temixBatches] } }, { createdById: { in: users } }] } }),
  ]);
  const r2Objects = hasR2 ? (await listFixtureObjects(f)).length : 0;
  return {
    User,
    Region,
    Route,
    Customer,
    Branch,
    CustomerEdit,
    EditApproval,
    Attachment,
    Notification,
    AuditLog,
    RateLimit,
    PasswordHistory,
    ImportBatch,
    TemixSyncBatch,
    r2Objects,
  };
}

export function totalOf(r: Residue): number {
  return Object.values(r).reduce((a, b) => a + b, 0);
}

/** One pass: collect by registry AND suffix, delete R2 then rows, count what is left. */
async function cleanupPass(
  registry: Registry,
  warnings: string[]
): Promise<{ leftovers: Residue; deleted: Record<string, number>; r2Keys: Set<string> }> {
  const reg = registry.data;
  const p = ownerDb();
  const f = await collect(reg, p);
  // Remember every id found, so the residue check and a re-run see the same set.
  registry.add('userIds', ...f.users);
  registry.add('usernames', ...f.usernames);
  registry.add('regionIds', ...f.regions);
  registry.add('routeIds', ...f.routes);
  registry.add('routeCodes', ...f.routeCodes);
  registry.add('customerIds', ...f.customers);
  registry.add('branchIds', ...f.branches);
  registry.add('editIds', ...f.edits);
  registry.add('attachmentIds', ...f.attachments.keys());
  registry.add('importBatchIds', ...f.importBatches);
  registry.add('temixBatchIds', ...f.temixBatches);
  registry.add('ymds', ...f.ymds);
  const r2 = await deleteR2(f, reg, warnings);
  const deleted = await deleteRows(f, reg, r2.refused, warnings);
  return { leftovers: await residue(reg, f), deleted, r2Keys: r2.deleted };
}

const PASSES = 3;

/**
 * Deletes everything a world created and marks its registry clean when nothing
 * is left. Safe to call again (afterAll, teardown, the sweep CLI). A pass that
 * leaves something is repeated (up to three, a few seconds apart): a request the
 * server was still finishing — a released action, a best-effort notification —
 * can write a row for a fixture after the first pass deleted its kind. Every
 * pass is recorded in the registry file's `attempts`.
 */
export async function cleanupRegistry(registry: Registry): Promise<CleanupResult> {
  const reg = registry.data;
  const warnings: string[] = [];
  const deleted: Record<string, number> = {};
  // DeleteObject is idempotent, so a later pass "deletes" the same keys again:
  // r2Objects counts distinct keys, rows count what each pass really removed.
  const r2Keys = new Set<string>();
  try {
    for (let pass = 1; ; pass++) {
      const passWarnings: string[] = [];
      const out = await cleanupPass(registry, passWarnings);
      for (const [k, n] of Object.entries(out.deleted)) deleted[k] = (deleted[k] ?? 0) + n;
      out.r2Keys.forEach((k) => r2Keys.add(k));
      deleted.r2Objects = r2Keys.size;
      if (totalOf(out.leftovers) === 0) {
        warnings.push(...passWarnings);
        registry.markClean(out.leftovers);
        return { leftovers: out.leftovers, deleted, warnings };
      }
      registry.markDirty(out.leftovers, passWarnings.join(' | ') || undefined);
      if (pass >= PASSES) {
        warnings.push(...passWarnings);
        return { leftovers: out.leftovers, deleted, warnings };
      }
      await new Promise((r) => setTimeout(r, 2_000 * pass));
    }
  } catch (err) {
    const message = redact(String((err as Error)?.message ?? err));
    registry.markDirty(undefined, message);
    throw new Error(`cleanup of world ${reg.name} failed: ${message}`);
  }
}

export type SweepReport = {
  swept: number;
  clean: number;
  dirty: Array<{ file: string; leftovers?: Residue; error?: string }>;
  /** What each swept world's file said BEFORE this sweep (why it was not clean). */
  found: Array<{ file: string; leftovers?: Residue; error?: string }>;
};

async function sweepFiles(files: string[]): Promise<SweepReport> {
  const report: SweepReport = { swept: 0, clean: 0, dirty: [], found: [] };
  for (const file of files) {
    report.swept++;
    try {
      const registry = Registry.load(file);
      const last = registry.data.attempts?.at(-1);
      report.found.push({
        file,
        leftovers: last?.leftovers ?? registry.data.leftovers,
        error: last?.error ?? registry.data.lastError ?? (last ? undefined : 'never cleaned (the worker stopped first)'),
      });
      const out = await cleanupRegistry(registry);
      if (totalOf(out.leftovers) === 0) report.clean++;
      else report.dirty.push({ file, leftovers: out.leftovers });
    } catch (err) {
      report.dirty.push({ file, error: redact(String((err as Error).message)) });
    }
  }
  return report;
}

/** Cleans every not-yet-clean world of one run. */
export async function sweepRun(runId: string = RUN_ID): Promise<SweepReport> {
  const files = listRegistryFiles().filter((file) => {
    const r = Registry.load(file).data;
    return r.runId === runId && !r.clean;
  });
  return sweepFiles(files);
}

/**
 * Cleans every not-yet-clean world of runs that are over (a crashed run, a
 * killed worker), whatever their run id. A run still in progress on this
 * machine — its runner process alive — is left alone.
 */
export async function sweepStale(currentRunId: string = RUN_ID): Promise<SweepReport> {
  const files = listRegistryFiles().filter((file) => {
    try {
      const r = Registry.load(file).data;
      return !r.clean && r.runId !== currentRunId && !ownedByLiveRun(r, currentRunId);
    } catch {
      return false;
    }
  });
  return sweepFiles(files);
}
