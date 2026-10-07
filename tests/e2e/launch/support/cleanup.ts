/**
 * Cleanup and the crash sweep.
 *
 * cleanupRegistry() is idempotent and re-runnable after a crash: it rebuilds the
 * world's rows from its registry file PLUS a search by the world's suffix (so a
 * row created after the last registry write is still found), deletes in
 * foreign-key order on the table owner's connection, then counts what is left by
 * id and by suffix in every table the suite touches. Only a zero count marks the
 * registry clean.
 *
 * WHICH rows are the world's (and may be deleted) — nothing else is:
 *  - rows whose id the registry holds: minted by the world before the insert, or
 *    adopted by the test after the UI created them;
 *  - rows whose typed value carries the world's suffix (username, full name,
 *    code, name, workbook filename, a request's drafted name);
 *  - what hangs off those: branches and requests of a world customer, the
 *    customer a world CREATE request or import batch made, photos on world rows,
 *    rows of world import batches, notifications to and export jobs, password
 *    history, saved views and rate-limit buckets of world users.
 * Never by a bare code or username (a two-character route code and its
 * salesman's username carry no suffix: another world or a later real route or
 * user may hold the same one), and never because a row was merely submitted,
 * uploaded, captured or decided BY a world user or sits in a world route or
 * region: other UAT suites pick users, routes and regions at random and may
 * pick ours. Such rows are FOREIGN: counted as `foreign*` leftovers (the world
 * stays dirty, a person decides), and every world user, route or region they
 * point at is kept — deleting it would fail, or silently null or cascade into
 * the foreign row (supervisor, route owner, reviewer, manager links).
 *
 * R2: objects are deleted only under the folders of the registry's users (ids
 * minted, adopted or carrying the suffix), and never the object of a foreign
 * photo; r2.ts checks the key layout before every DeleteObject.
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
  regions: Set<string>;
  routes: Set<string>;
  customers: Set<string>;
  branches: Set<string>;
  edits: Set<string>;
  attachments: Map<string, { r2Key: string; capturedById: string }>;
  importBatches: Set<string>;
  importRows: Set<string>;
  temixBatches: Set<string>;
  exportJobs: Set<string>;
  /** Login names whose buckets are the world's: suffix-carrying ones, and the names of world users that exist now. */
  usernames: Set<string>;
  ips: Set<string>;
  ymds: Set<string>;
  /** The only users whose R2 day folders may be listed or emptied: ids the registry holds, or suffix-matched. */
  r2Owners: Set<string>;
};

/** Rows that are not the world's but point at it, and the world rows they hold. */
type Foreign = {
  counts: Residue;
  users: Set<string>;
  routes: Set<string>;
  regions: Set<string>;
  /** R2 keys of photos a world user captured for someone else's row: never deleted. */
  keys: Set<string>;
};

const CHUNK = 400;
const LOCALHOST_IPS = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];
/** Audit rows whose entity is the actor's own act, not another record. */
const ACTOR_OWNED_AUDIT = ['Export'];

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

/** Every object under the world users' day folders — the only listing the suite performs. */
async function listFixtureObjects(f: Fixture): Promise<string[]> {
  const pairs = [...f.ymds].flatMap((ymd) => [...f.r2Owners].map((u) => [ymd, u] as const));
  const lists = await mapLimit(pairs, 8, ([ymd, u]) => listFixturePrefix(ymd, u, f.r2Owners));
  return lists.flat();
}

const ci = (s: string) => ({ contains: s, mode: 'insensitive' as const });
const ids = (s: Set<string> | Map<string, unknown>) => [...s.keys()];

async function collect(reg: RegistryData, p: PrismaClient): Promise<Fixture> {
  assertSafeSuffix(reg.sfx);
  const sfx = reg.sfx;
  const hasSfx = (v: string) => v.toLowerCase().includes(sfx);
  const f: Fixture = {
    sfx,
    SFX: sfx.toUpperCase(),
    users: new Set(reg.userIds),
    regions: new Set(reg.regionIds),
    routes: new Set(reg.routeIds),
    customers: new Set(reg.customerIds),
    branches: new Set(reg.branchIds),
    edits: new Set(reg.editIds),
    attachments: new Map(),
    importBatches: new Set(reg.importBatchIds),
    importRows: new Set(),
    temixBatches: new Set(reg.temixBatchIds),
    exportJobs: new Set(),
    usernames: new Set(reg.usernames.filter(hasSfx)),
    ips: new Set(reg.ips),
    ymds: new Set([...reg.ymds, ...daysSince(reg.createdAt)]),
    r2Owners: new Set(),
  };

  // 1. Regions, routes, users: a registered id, or a value carrying the suffix.
  //    Never a bare code or username (see the header).
  const [regions, routes, users] = await Promise.all([
    p.region.findMany({ where: { OR: [{ id: { in: ids(f.regions) } }, { code: ci(sfx) }, { name: ci(sfx) }] }, select: { id: true } }),
    p.route.findMany({ where: { OR: [{ id: { in: ids(f.routes) } }, { code: ci(sfx) }, { name: ci(sfx) }] }, select: { id: true } }),
    p.user.findMany({
      where: { OR: [{ id: { in: ids(f.users) } }, { username: ci(sfx) }, { fullName: ci(sfx) }] },
      select: { id: true, username: true },
    }),
  ]);
  regions.forEach((r) => f.regions.add(r.id));
  routes.forEach((r) => f.routes.add(r.id));
  users.forEach((u) => {
    f.users.add(u.id);
    // Their login buckets are the world's while they exist (a suffix-less name included).
    f.usernames.add(u.username);
  });
  f.r2Owners = new Set(f.users);

  // 2. Import batches: registered, or a workbook named with the suffix. Temix batches: registered.
  const batches = await p.importBatch.findMany({
    where: { OR: [{ id: { in: ids(f.importBatches) } }, { filename: ci(sfx) }] },
    select: { id: true },
  });
  batches.forEach((b) => f.importBatches.add(b.id));
  const temix = await p.temixSyncBatch.findMany({ where: { id: { in: ids(f.temixBatches) } }, select: { id: true } });
  f.temixBatches = new Set(temix.map((t) => t.id));

  // 3. Requests: registered, or drafted with the suffix. A world CREATE request
  //    names the customer it made.
  const requests = await p.customerEdit.findMany({
    where: {
      OR: [
        { id: { in: ids(f.edits) } },
        { customerDraft: { is: { legalName: ci(sfx) } } },
        { branchDrafts: { some: { branchName: ci(sfx) } } },
      ],
    },
    select: { id: true, process: true, customerId: true },
  });
  requests.forEach((e) => {
    f.edits.add(e.id);
    if (e.process === 'CREATE' && e.customerId) f.customers.add(e.customerId);
  });

  // 4. Customers: registered, the suffix, a world request's or a world import's.
  const customers = await p.customer.findMany({
    where: {
      OR: [
        { id: { in: ids(f.customers) } },
        { nmwcCode: ci(sfx) },
        { legalName: ci(sfx) },
        { importBatchId: { in: ids(f.importBatches) } },
      ],
    },
    select: { id: true },
  });
  customers.forEach((c) => f.customers.add(c.id));

  // 5. Branches: registered, the suffix, or of a world customer.
  const branches = await p.branch.findMany({
    where: { OR: [{ id: { in: ids(f.branches) } }, { branchCode: ci(sfx) }, { branchName: ci(sfx) }, { customerId: { in: ids(f.customers) } }] },
    select: { id: true },
  });
  branches.forEach((b) => f.branches.add(b.id));

  // 6. Requests ABOUT a world customer or branch, whoever submitted them: they cannot outlive it.
  const about = await p.customerEdit.findMany({
    where: { OR: [{ customerId: { in: ids(f.customers) } }, { branchId: { in: ids(f.branches) } }] },
    select: { id: true },
  });
  about.forEach((e) => f.edits.add(e.id));

  // 7. Photos: registered (id or key), or on a world customer, branch or request.
  //    NOT "captured by a world user" alone — that is someone else's photo.
  const atts = await p.attachment.findMany({
    where: {
      OR: [
        { id: { in: reg.attachmentIds } },
        { r2Key: { in: reg.r2Keys } },
        { customerId: { in: ids(f.customers) } },
        { branchId: { in: ids(f.branches) } },
        { branchExtraId: { in: ids(f.branches) } },
        { editId: { in: ids(f.edits) } },
      ],
    },
    select: { id: true, r2Key: true, capturedById: true },
  });
  atts.forEach((a) => f.attachments.set(a.id, { r2Key: a.r2Key, capturedById: a.capturedById }));

  // 8. Ids an audit row can name: rows of world import batches, export jobs of world users.
  const [rows, exports] = await Promise.all([
    p.importRow.findMany({ where: { batchId: { in: ids(f.importBatches) } }, select: { id: true } }),
    p.exportJob.findMany({ where: { requestedById: { in: ids(f.users) } }, select: { id: true } }),
  ]);
  f.importRows = new Set(rows.map((r) => r.id));
  f.exportJobs = new Set(exports.map((e) => e.id));
  return f;
}

/** Ids of every world row — the entity ids an audit row can name. */
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
    ...f.importRows,
    ...f.temixBatches,
    ...f.exportJobs,
  ];
}

/** 'unknown:<name>' audit sentinels (failed sign-ins as a name no user has): suffix-carrying names only. */
function unknownSentinels(f: Fixture): string[] {
  return [...f.usernames].filter((u) => u.toLowerCase().includes(f.sfx)).map((u) => `unknown:${u.slice(0, 50)}`);
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

/**
 * Rows that are NOT the world's but point at a world user, route or region —
 * another suite (or a person) worked as or with a fixture. They are never
 * deleted; they are counted, and the world rows they point at are kept.
 */
async function foreignRows(f: Fixture, p: PrismaClient): Promise<Foreign> {
  const users = ids(f.users);
  const routes = ids(f.routes);
  const regions = ids(f.regions);
  const notIn = (s: Set<string> | Map<string, unknown>) => ({ notIn: ids(s) });
  const out: Foreign = { counts: {}, users: new Set(), routes: new Set(), regions: new Set(), keys: new Set() };
  const holdUser = (id: string | null | undefined) => id && f.users.has(id) && out.users.add(id);
  const holdRoute = (id: string | null | undefined) => id && f.routes.has(id) && out.routes.add(id);
  const holdRegion = (id: string | null | undefined) => id && f.regions.has(id) && out.regions.add(id);
  const ownAuditIds = [...allIds(f), ...unknownSentinels(f)];

  const [fUsers, fRoutes, fBranches, fCustomers, fEdits, fSteps, fAtts, fBatches, fRows, fTemix, fAudit, fLinks] = await Promise.all([
    p.user.findMany({
      where: { id: notIn(f.users), OR: [{ ownedRouteId: { in: routes } }, { supervisorId: { in: users } }] },
      select: { ownedRouteId: true, supervisorId: true },
    }),
    p.route.findMany({ where: { id: notIn(f.routes), regionId: { in: regions } }, select: { regionId: true } }),
    p.branch.findMany({
      where: { id: notIn(f.branches), OR: [{ routeId: { in: routes } }, { regionId: { in: regions } }] },
      select: { routeId: true, regionId: true },
    }),
    p.customer.count({ where: { id: notIn(f.customers), createdById: { in: users } } }),
    p.customerEdit.findMany({
      where: {
        id: notIn(f.edits),
        OR: [
          { submittedById: { in: users } },
          { reviewedById: { in: users } },
          { newRouteId: { in: routes } },
          { branchDrafts: { some: { OR: [{ routeId: { in: routes } }, { regionId: { in: regions } }] } } },
        ],
      },
      select: { submittedById: true, reviewedById: true, newRouteId: true, branchDrafts: { select: { routeId: true, regionId: true } } },
    }),
    p.editApproval.findMany({ where: { actorId: { in: users }, editId: notIn(f.edits) }, select: { actorId: true } }),
    p.attachment.findMany({ where: { id: notIn(f.attachments), capturedById: { in: users } }, select: { capturedById: true, r2Key: true } }),
    p.importBatch.findMany({ where: { id: notIn(f.importBatches), uploadedById: { in: users } }, select: { uploadedById: true } }),
    p.importRow.findMany({
      where: { batchId: notIn(f.importBatches), OR: [{ reviewedById: { in: users } }, { excludedById: { in: users } }] },
      select: { reviewedById: true, excludedById: true },
    }),
    p.temixSyncBatch.findMany({ where: { id: notIn(f.temixBatches), createdById: { in: users } }, select: { createdById: true } }),
    p.auditLog.findMany({
      where: { actorId: { in: users }, entityId: { notIn: ownAuditIds }, entityType: { notIn: ACTOR_OWNED_AUDIT } },
      select: { actorId: true, entityType: true, entityId: true },
    }),
    regions.length
      ? p.$queryRaw<{ A: string }[]>`SELECT "A" FROM "_ManagerRegions" WHERE "A" = ANY(${regions}::text[]) AND NOT ("B" = ANY(${users}::text[]))`
      : Promise.resolve([] as { A: string }[]),
  ]);

  fUsers.forEach((u) => {
    holdRoute(u.ownedRouteId);
    holdUser(u.supervisorId);
  });
  fRoutes.forEach((r) => holdRegion(r.regionId));
  fBranches.forEach((b) => {
    holdRoute(b.routeId);
    holdRegion(b.regionId);
  });
  fEdits.forEach((e) => {
    holdUser(e.submittedById);
    holdUser(e.reviewedById);
    holdRoute(e.newRouteId);
    e.branchDrafts.forEach((d) => {
      holdRoute(d.routeId);
      holdRegion(d.regionId);
    });
  });
  fSteps.forEach((s) => holdUser(s.actorId));
  fAtts.forEach((a) => {
    holdUser(a.capturedById);
    out.keys.add(a.r2Key);
  });
  fBatches.forEach((b) => holdUser(b.uploadedById));
  fRows.forEach((r) => {
    holdUser(r.reviewedById);
    holdUser(r.excludedById);
  });
  fTemix.forEach((t) => holdUser(t.createdById));
  // A duplicate-pair decision naming a world customer is the world's.
  const audit = fAudit.filter((a) => !(a.entityType === 'CustomerPair' && a.entityId.split('|').some((id) => f.customers.has(id))));
  audit.forEach((a) => holdUser(a.actorId));
  fLinks.forEach((l) => holdRegion(l.A));
  // A kept route keeps its region.
  if (out.routes.size) {
    const kept = await p.route.findMany({ where: { id: { in: [...out.routes] } }, select: { regionId: true } });
    kept.forEach((r) => holdRegion(r.regionId));
  }

  out.counts = {
    foreignUser: fUsers.length,
    foreignManagerLink: fLinks.length,
    foreignRoute: fRoutes.length,
    foreignBranch: fBranches.length,
    foreignCustomer: fCustomers,
    foreignCustomerEdit: fEdits.length,
    foreignEditApproval: fSteps.length,
    foreignAttachment: fAtts.length,
    foreignImportBatch: fBatches.length,
    foreignImportRow: fRows.length,
    foreignTemixSyncBatch: fTemix.length,
    foreignAuditLog: audit.length,
  };
  return out;
}

async function deleteR2(
  f: Fixture,
  reg: RegistryData,
  foreign: Foreign,
  warnings: string[]
): Promise<{ deleted: Set<string>; refused: Set<string> }> {
  const refused = new Set<string>();
  const deleted = new Set<string>();
  if (!hasR2) {
    if (f.attachments.size > 0 || reg.r2Keys.length > 0) warnings.push('R2 is not configured: objects were not checked');
    return { deleted, refused };
  }
  const keys = new Set<string>([...reg.r2Keys]);
  for (const a of f.attachments.values()) keys.add(a.r2Key);
  // Presigned but never finalized (the browser PUT and then stopped): list each
  // world user's day folders — the only listing the suite ever performs.
  for (const k of await listFixtureObjects(f)) keys.add(k);
  // A photo a world user captured for someone else's row stays with that row.
  for (const k of foreign.keys) keys.delete(k);
  await mapLimit([...keys], 8, async (key) => {
    try {
      await deleteFixtureObject(key, f.r2Owners);
      deleted.add(key);
    } catch (err) {
      refused.add(key);
      warnings.push(redact(String((err as Error).message)));
    }
  });
  return { deleted, refused };
}

async function deleteRows(
  f: Fixture,
  reg: RegistryData,
  foreign: Foreign,
  refusedKeys: Set<string>,
  warnings: string[]
): Promise<Record<string, number>> {
  const p = ownerDb();
  const n: Record<string, number> = {};
  const add = (k: string, c: number) => (n[k] = (n[k] ?? 0) + c);
  const allUsers = [...f.users];
  // World rows a foreign row points at are kept (see the header).
  const users = allUsers.filter((id) => !foreign.users.has(id));
  const routes = [...f.routes].filter((id) => !foreign.routes.has(id));
  const regions = [...f.regions].filter((id) => !foreign.regions.has(id));
  const customers = [...f.customers];
  const branches = [...f.branches];
  const edits = [...f.edits];
  if (foreign.users.size) warnings.push(`kept ${foreign.users.size} world user(s) that foreign rows point at: ${[...foreign.users].join(', ')}`);
  if (foreign.routes.size) warnings.push(`kept ${foreign.routes.size} world route(s) that foreign rows point at: ${[...foreign.routes].join(', ')}`);
  if (foreign.regions.size) warnings.push(`kept ${foreign.regions.size} world region(s) that foreign rows point at: ${[...foreign.regions].join(', ')}`);

  // 0. Out of every org-wide audience first: CREATE finalize notifies every
  //    ACTIVE Steward, the FM/GM steps every active FM/GM — whoever's request it
  //    is (a real one, another suite's). A fixture Steward/FM/GM that stays
  //    active keeps receiving rows while this runs, and a row that lands after
  //    step 1 blocks the user's delete in step 8. Kept users are deactivated too.
  for (const c of chunks(allUsers)) await p.user.updateMany({ where: { id: { in: c } }, data: { isActive: false } });

  // 1. Notifications — to world users, about world requests or customers. CREATE
  //    finalize and the FM/GM steps notify REAL users; those rows are found
  //    through editId only.
  const notes = await p.notification.findMany({
    where: {
      OR: [
        { id: { in: reg.notificationIds } },
        { userId: { in: allUsers } },
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

  // 3. Step ledger and requests (drafts cascade), in the maintenance window, batched.
  for (const c of chunks(edits)) {
    await inMaintenance(async (tx) => {
      add('EditApproval', (await tx.editApproval.deleteMany({ where: { editId: { in: c } } })).count);
      add('CustomerEdit', (await tx.customerEdit.deleteMany({ where: { id: { in: c } } })).count);
    });
  }

  // 4. Temix batches and export jobs of the world.
  add('TemixSyncBatch', (await p.temixSyncBatch.deleteMany({ where: { id: { in: [...f.temixBatches] } } })).count);
  add('ExportJob', (await p.exportJob.deleteMany({ where: { id: { in: [...f.exportJobs] } } })).count);

  // 5. Attachments (not the ones whose object the R2 guard refused), branches, customers, imports.
  const attIds = [...f.attachments.entries()].filter(([, a]) => !refusedKeys.has(a.r2Key)).map(([id]) => id);
  for (const c of chunks(attIds)) add('Attachment', (await p.attachment.deleteMany({ where: { id: { in: c } } })).count);
  for (const c of chunks(branches)) add('Branch', (await p.branch.deleteMany({ where: { id: { in: c } } })).count);
  for (const c of chunks(customers)) add('Customer', (await p.customer.deleteMany({ where: { id: { in: c } } })).count);
  for (const c of chunks([...f.importBatches])) {
    add('ImportRow', (await p.importRow.deleteMany({ where: { batchId: { in: c } } })).count);
    add('ImportBatch', (await p.importBatch.deleteMany({ where: { id: { in: c } } })).count);
  }

  // 6. Audit rows naming a world row (whoever the actor), the 'unknown:<name>'
  //    sentinel of suffix-carrying names, a world user's own exports, and
  //    duplicate-pair rows ('aId|bId') naming a world customer. NOT every row a
  //    world user acted in: one about a real record is foreign (counted, kept).
  const entityIds = [...allIds(f), ...unknownSentinels(f)];
  await inMaintenance(async (tx) => {
    for (const c of chunks(entityIds)) add('AuditLog', (await tx.auditLog.deleteMany({ where: { entityId: { in: c } } })).count);
    for (const c of chunks(allUsers))
      add('AuditLog', (await tx.auditLog.deleteMany({ where: { actorId: { in: c }, entityType: { in: ACTOR_OWNED_AUDIT } } })).count);
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
  });

  // 7. Password history, saved views, rate-limit buckets.
  add('PasswordHistory', (await p.passwordHistory.deleteMany({ where: { userId: { in: allUsers } } })).count);
  add('SavedView', (await p.savedView.deleteMany({ where: { userId: { in: allUsers } } })).count);
  for (const c of chunks(rateLimitKeys(f)))
    add('RateLimit', (await p.rateLimit.deleteMany({ where: { key: { in: c } } })).count);
  add('RateLimit', (await p.rateLimit.deleteMany({ where: { key: ci(f.sfx) } })).count);

  // 8. Users: unlink their own pointers, then delete — one by one when the batch
  //    fails, reporting the one a row still points at instead of forcing it.
  if (allUsers.length > 0) {
    await p.user.updateMany({ where: { id: { in: allUsers } }, data: { supervisorId: null, ownedRouteId: null } });
    await p.$executeRaw`DELETE FROM "_ManagerRegions" WHERE "B" = ANY(${users}::text[])`;
    // Again, right before the delete: anything addressed to them since step 1.
    for (const c of chunks(allUsers)) add('Notification', (await p.notification.deleteMany({ where: { userId: { in: c } } })).count);
  }
  await deleteEach('User', users, (c) => p.user.deleteMany({ where: { id: { in: c } } }), add, warnings);

  // 9. Routes, then regions (same fallback).
  await deleteEach('Route', routes, (c) => p.route.deleteMany({ where: { id: { in: c } } }), add, warnings);
  await deleteEach('Region', regions, (c) => p.region.deleteMany({ where: { id: { in: c } } }), add, warnings);
  return n;
}

/** Deletes in chunks; a chunk that fails is retried one row at a time, and a row that still fails is reported. */
async function deleteEach(
  table: string,
  idList: string[],
  del: (c: string[]) => Promise<{ count: number }>,
  add: (k: string, c: number) => void,
  warnings: string[]
): Promise<void> {
  for (const c of chunks(idList)) {
    try {
      add(table, (await del(c)).count);
    } catch {
      for (const id of c) {
        try {
          add(table, (await del([id])).count);
        } catch (err) {
          warnings.push(`${table.toLowerCase()} ${id} kept: ${redact(String((err as Error).message)).split('\n').slice(-1)[0]}`);
        }
      }
    }
  }
}

/**
 * What is left of a world — by id AND by suffix in every table the suite
 * touches — plus the foreign rows that point at it (`foreign*`, never deleted).
 */
export async function residue(reg: RegistryData, known?: { f: Fixture; foreign?: Foreign }): Promise<Residue> {
  const p = ownerDb();
  const f = known?.f ?? (await collect(reg, p));
  const sfx = f.sfx;
  const users = [...f.users];
  const keys = rateLimitKeys(f).filter((k) => !LOCALHOST_IPS.some((ip) => k === `login:ip:${ip}`));
  const entityIds = [...allIds(f), ...unknownSentinels(f)];
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
    SavedView,
    ImportBatch,
    ImportRow,
    TemixSyncBatch,
    ExportJob,
  ] = await Promise.all([
    p.user.count({ where: { OR: [{ id: { in: users } }, { username: ci(sfx) }, { fullName: ci(sfx) }] } }),
    p.region.count({ where: { OR: [{ id: { in: [...f.regions] } }, { code: ci(sfx) }, { name: ci(sfx) }] } }),
    p.route.count({ where: { OR: [{ id: { in: [...f.routes] } }, { code: ci(sfx) }, { name: ci(sfx) }] } }),
    p.customer.count({ where: { OR: [{ id: { in: [...f.customers] } }, { nmwcCode: ci(sfx) }, { legalName: ci(sfx) }] } }),
    p.branch.count({ where: { OR: [{ id: { in: [...f.branches] } }, { branchCode: ci(sfx) }, { branchName: ci(sfx) }] } }),
    p.customerEdit.count({
      where: {
        OR: [
          { id: { in: [...f.edits] } },
          { customerDraft: { is: { legalName: ci(sfx) } } },
          { branchDrafts: { some: { branchName: ci(sfx) } } },
        ],
      },
    }),
    p.editApproval.count({ where: { editId: { in: [...f.edits] } } }),
    p.attachment.count({ where: { id: { in: [...f.attachments.keys()] } } }),
    p.notification.count({
      where: { OR: [{ userId: { in: users } }, { editId: { in: [...f.edits] } }, { customerId: { in: [...f.customers] } }, { title: ci(sfx) }, { body: ci(sfx) }] },
    }),
    p.auditLog.count({ where: { OR: [{ entityId: { in: entityIds } }, { actorId: { in: users }, entityType: { in: ACTOR_OWNED_AUDIT } }] } }),
    p.rateLimit.count({ where: { OR: [{ key: { in: keys } }, { key: ci(sfx) }] } }),
    p.passwordHistory.count({ where: { userId: { in: users } } }),
    p.savedView.count({ where: { userId: { in: users } } }),
    p.importBatch.count({ where: { OR: [{ id: { in: [...f.importBatches] } }, { filename: ci(sfx) }] } }),
    p.importRow.count({ where: { batchId: { in: [...f.importBatches] } } }),
    p.temixSyncBatch.count({ where: { id: { in: [...f.temixBatches] } } }),
    p.exportJob.count({ where: { requestedById: { in: users } } }),
  ]);
  const foreign = known?.foreign ?? (await foreignRows(f, p));
  const r2Objects = hasR2 ? (await listFixtureObjects(f)).filter((k) => !foreign.keys.has(k)).length : 0;
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
    SavedView,
    ImportBatch,
    ImportRow,
    TemixSyncBatch,
    ExportJob,
    r2Objects,
    ...foreign.counts,
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
  // Remember the world's rows, so a re-run after a crash finds them by id even
  // once what led to them is gone. Every one is registered, suffix-matched or
  // hangs off such a row (collect); never a bare code or username.
  registry.add('userIds', ...f.users);
  registry.add('usernames', ...[...f.usernames].filter((u) => u.toLowerCase().includes(f.sfx)));
  registry.add('regionIds', ...f.regions);
  registry.add('routeIds', ...f.routes);
  registry.add('customerIds', ...f.customers);
  registry.add('branchIds', ...f.branches);
  registry.add('editIds', ...f.edits);
  registry.add('attachmentIds', ...f.attachments.keys());
  registry.add('importBatchIds', ...f.importBatches);
  registry.add('temixBatchIds', ...f.temixBatches);
  registry.add('ymds', ...f.ymds);
  const foreign = await foreignRows(f, p);
  const r2 = await deleteR2(f, reg, foreign, warnings);
  const deleted = await deleteRows(f, reg, foreign, r2.refused, warnings);
  // Counted again after the deletes: a foreign row may have arrived meanwhile.
  return { leftovers: await residue(reg, { f }), deleted, r2Keys: r2.deleted };
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
      else report.dirty.push({ file, leftovers: Object.fromEntries(Object.entries(out.leftovers).filter(([, n]) => n !== 0)) });
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
 * machine — its runner's heartbeat fresh (runlock.ts) — is left alone.
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
