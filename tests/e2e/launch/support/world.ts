/**
 * Fixture worlds: createWorld() and standardWorld().
 *
 * A world is synthetic TEST data under one suffix (sfx = tag + RUN_ID + worker +
 * project initial), built straight into the UAT database through Prisma. Every
 * typed value carries the suffix (usernames, codes, names) so the cleanup and
 * the residue check can find rows by it, and every id is minted client-side and
 * written to the crash registry before its row is inserted. The exceptions —
 * two-character route codes and their salesmen's usernames — are found by id
 * only: another world, or a later real route or user, may hold the same code.
 *
 * Build worlds in a describe-level beforeAll, never at module level; call
 * world.cleanup() in afterAll. Never touch a row that is not the world's own.
 */
import { test } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DayOfWeek, PaymentTerms, Prisma, Role } from '@prisma/client';
import { normalizeCR } from '../../../../lib/cr';
import { scoreBranch, scoreCustomer, type BranchForScore, type CustomerForScore } from '../../../../lib/completeness';
import { cleanupRegistry, residue } from './cleanup';
import { assertNotProduction, db, REGISTRY_DIR, RUN_ID, safeError, hasR2 } from './env';
import { FIXTURE_PASSWORD_SHAPE } from './secret-scan';
import { makeRunId, newId, smallHash } from './ids';
import { assertOmanDayUnchanged, OMAN_TODAY, omanDayAfter } from './oman';
import { seedPhotos, type PhotoSpec } from './photos';
import { Registry } from './registry';
import type {
  BranchSpec,
  CustomerSpec,
  FixtureBranch,
  FixtureCustomer,
  FixtureRegion,
  FixtureRoute,
  FixtureUser,
  UserSpec,
  World,
  WorldSpec,
} from './types';

/** The real hand-out password the account master gives every new account. */
export const INITIAL_PASSWORD = '12345';
/** Muscat, the shop GPS the phone project reports (±9 m). */
export const MUSCAT = { lat: 23.5881, lng: 58.3829, accuracy: 9 } as const;

// ── per-worker secrets and caches ─────────────────────────────────────────────

/**
 * The run's known password for every fixture account: generated in memory,
 * at least 16 characters, never logged. Typing it into http://localhost's
 * sign-in page is the only place it goes.
 */
const RUN_PASSWORD = `E2e-${randomBytes(12).toString('base64url')}-9a`;
// The secret scan finds a leaked run password by this shape (it never knows the value).
if (!FIXTURE_PASSWORD_SHAPE.test(RUN_PASSWORD)) throw new Error('the run password does not have the shape secret-scan.ts looks for');
const hashCache = new Map<string, Promise<string>>();
function hashOnce(password: string): Promise<string> {
  let h = hashCache.get(password);
  if (!h) {
    h = bcrypt.hash(password, 12);
    hashCache.set(password, h);
  }
  return h;
}

let channelCache: Promise<Map<string, { id: string; subIds: string[] }>> | undefined;
function channels() {
  channelCache ??= db.channel
    .findMany({ select: { id: true, key: true, subChannels: { where: { isActive: true }, select: { id: true }, orderBy: { key: 'asc' } } } })
    .then((rows) => new Map(rows.map((c) => [c.key, { id: c.id, subIds: c.subChannels.map((s) => s.id) }])));
  return channelCache;
}

const FIRST_NAME: Record<Role, string> = {
  SALESMAN: 'Salim',
  SUPERVISOR: 'Sami',
  ACCOUNTANT: 'Aisha',
  FINANCE_MANAGER: 'Fatma',
  GM: 'Ghalib',
  MANAGER: 'Marwan',
  STEWARD: 'Sara',
  VIEWER: 'Vikram',
};

const PROJECTS = ['phone', 'desktop', 'exclusive'] as const;

function testContext(): { workerIndex: number; project: string } {
  try {
    const info = test.info();
    return { workerIndex: info.workerIndex, project: info.project.name };
  } catch {
    return { workerIndex: Number(process.env.TEST_WORKER_INDEX ?? 0), project: 'global' };
  }
}

const usedSuffixes = new Set<string>();
let worldCounter = 0;

function makeSuffix(tag: string): { sfx: string; workerIndex: number; projectIdx: number } {
  const t = tag.toLowerCase();
  if (!/^[a-z][a-z0-9]{0,3}$/.test(t)) throw new Error(`world tag "${tag}": 1-4 letters/digits, starting with a letter`);
  const runId = RUN_ID || makeRunId();
  const { workerIndex, project } = testContext();
  const projectIdx = Math.max(0, PROJECTS.indexOf(project as (typeof PROJECTS)[number]));
  const initial = project === 'global' ? 'g' : project[0]!.toLowerCase();
  const base = `${t}${runId}${(workerIndex % 36).toString(36)}${initial}`;
  let sfx = base;
  for (let i = 1; usedSuffixes.has(sfx) || fs.existsSync(path.join(REGISTRY_DIR, runId, `${sfx}.json`)); i++) {
    sfx = `${base}${i.toString(36)}`;
  }
  usedSuffixes.add(sfx);
  if (sfx.length > 16) throw new Error(`world suffix "${sfx}" is too long for 20-character route codes`);
  return { sfx, workerIndex, projectIdx: project === 'global' ? 3 : projectIdx };
}

// ── the world ────────────────────────────────────────────────────────────────

class WorldImpl implements World {
  readonly SFX: string;
  readonly runId: string;
  private readonly regions = new Map<string, FixtureRegion>();
  private readonly routes = new Map<string, FixtureRoute>();
  private readonly usersByKey = new Map<string, FixtureUser>();
  private readonly customersByKey = new Map<string, FixtureCustomer>();
  private counters = { region: 0, route: 0, customer: 0, cr: 0, phone: 0 };
  private readonly ipBase: string;
  private readonly ipOffset: number;
  private readonly phoneBase: string;

  constructor(
    readonly sfx: string,
    readonly tag: string,
    readonly registry: Registry,
    slot: { workerIndex: number; projectIdx: number; counter: number }
  ) {
    this.SFX = sfx.toUpperCase();
    this.runId = RUN_ID;
    // Addresses: unique among the run's worlds alive at the same time (one slot
    // per worker, project and world parity), below the probe's 198.1x.248+ block.
    // The run id turns the slot block and the last octet, so a run from another
    // checkout rarely lands on the same addresses (and its cleanup on our buckets).
    const h = smallHash(`ip:${RUN_ID}`);
    const octet2 = 18 + (h % 2);
    const slotNo = (slot.workerIndex % 30) * 8 + slot.projectIdx * 2 + (slot.counter % 2);
    const octet3 = (slotNo + (h >>> 1)) % 248;
    this.ipBase = `198.${octet2}.${octet3}`;
    this.ipOffset = (h >>> 9) % 254;
    // Phones: +968 9 <run> <worker 2> <project> <world> <seq 2>.
    this.phoneBase = `9${smallHash(RUN_ID) % 10}${String(slot.workerIndex % 100).padStart(2, '0')}${slot.projectIdx}${slot.counter % 10}`;
  }

  ip(n = 1): string {
    if (!Number.isInteger(n) || n < 1 || n > 254) throw new Error('world.ip(n): 1..254');
    const ip = `${this.ipBase}.${((n - 1 + this.ipOffset) % 254) + 1}`;
    this.registry.add('ips', ip);
    return ip;
  }

  name(base: string): string {
    return `${base} ${this.sfx}`;
  }

  private get<T>(m: Map<string, T>, k: string, what: string): T {
    const v = m.get(k);
    if (!v) throw new Error(`world ${this.sfx} has no ${what} "${k}"`);
    return v;
  }
  region(k: string) {
    return this.get(this.regions, k, 'region');
  }
  route(k: string) {
    return this.get(this.routes, k, 'route');
  }
  user(k: string) {
    return this.get(this.usersByKey, k, 'user');
  }
  customer(k: string) {
    return this.get(this.customersByKey, k, 'customer');
  }
  branch(k: string): FixtureBranch {
    const [c, b] = k.split('.');
    const cust = this.customer(c!);
    if (!b) return cust.branch;
    const br = cust.branches[b];
    if (!br) throw new Error(`world ${this.sfx}: customer ${c} has no branch ${b}`);
    return br;
  }
  users() {
    return [...this.usersByKey.values()];
  }
  customers() {
    return [...this.customersByKey.values()];
  }
  fixtureUserIds() {
    return new Set([...this.usersByKey.values()].map((u) => u.id).concat(this.registry.data.userIds));
  }

  // ── regions and routes ──
  async addRegion(key: string): Promise<FixtureRegion> {
    return (await this.addRegions([key]))[0]!;
  }

  async addRegions(keys: string[]): Promise<FixtureRegion[]> {
    const rows = keys.map((key) => {
      if (this.regions.has(key)) throw new Error(`region ${key} exists`);
      const n = ++this.counters.region;
      return { key, id: newId(), code: `E2R${this.SFX}${n}`, name: `E2E Region ${key} ${this.sfx}` };
    });
    if (rows.length === 0) return [];
    this.registry.add('regionIds', ...rows.map((r) => r.id));
    this.registry.add('regionCodes', ...rows.map((r) => r.code));
    await db.region.createMany({ data: rows.map(({ id, code, name }) => ({ id, code, name })) });
    rows.forEach((r) => this.regions.set(r.key, r));
    return rows;
  }

  async addRoute(s: { key: string; region: string; twoChar?: boolean; isActive?: boolean }): Promise<FixtureRoute> {
    if (s.twoChar) return this.allocTwoCharRoute(s.region, s.key);
    return (await this.addRoutes([s]))[0]!;
  }

  async addRoutes(specs: { key: string; region: string; twoChar?: boolean; isActive?: boolean }[]): Promise<FixtureRoute[]> {
    const plain = specs.filter((s) => !s.twoChar);
    const rows = plain.map((s) => {
      if (this.routes.has(s.key)) throw new Error(`route ${s.key} exists`);
      const n = ++this.counters.route;
      const region = this.region(s.region);
      return {
        key: s.key,
        id: newId(),
        code: `E2${this.SFX}${n}`,
        name: `E2E Route ${s.key} ${this.sfx}`,
        regionId: region.id,
        regionKey: s.region,
        isActive: s.isActive ?? true,
      };
    });
    if (rows.length > 0) {
      this.registry.add('routeIds', ...rows.map((r) => r.id));
      this.registry.add('routeCodes', ...rows.map((r) => r.code));
      await db.route.createMany({
        data: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, regionId: r.regionId, isActive: r.isActive })),
      });
      rows.forEach((r) =>
        this.routes.set(r.key, { key: r.key, id: r.id, code: r.code, name: r.name, regionId: r.regionId, regionKey: r.regionKey })
      );
    }
    const out: FixtureRoute[] = rows.map((r) => this.route(r.key));
    for (const s of specs.filter((x) => x.twoChar)) out.push(await this.allocTwoCharRoute(s.region, s.key));
    return out;
  }

  async allocTwoCharRoute(regionKey: string, key = `TWO${this.counters.route + 1}`): Promise<FixtureRoute> {
    const region = this.region(regionKey);
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const candidates = ['Z', 'Y'].flatMap((p) => [...alphabet].map((c) => `${p}${c}`));
    for (let attempt = 0; attempt < 6; attempt++) {
      const [routes, users] = await Promise.all([
        db.route.findMany({ where: { code: { in: candidates } }, select: { code: true } }),
        db.user.findMany({ where: { username: { in: candidates.map((c) => c.toLowerCase()) } }, select: { username: true } }),
      ]);
      const taken = new Set([...routes.map((r) => r.code), ...users.map((u) => u.username.toUpperCase())]);
      const free = candidates.filter((c) => !taken.has(c));
      if (free.length === 0) throw new Error('no free Z?/Y? two-character route code on this database');
      const code = free[Math.floor(Math.random() * free.length)]!;
      const id = newId();
      // The id first (a crash between here and the insert leaves it findable).
      // The code carries no suffix: it is recorded only once the insert has
      // succeeded — a P2002 means another world or a real route holds it — and
      // cleanup never looks a route up by it.
      this.registry.add('routeIds', id);
      try {
        await db.route.create({ data: { id, code, name: `E2E Route ${key} ${this.sfx}`, regionId: region.id } });
        this.registry.add('routeCodes', code);
        this.counters.route++;
        const r: FixtureRoute = { key, id, code, name: `E2E Route ${key} ${this.sfx}`, regionId: region.id, regionKey };
        this.routes.set(key, r);
        return r;
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw safeError(err, 'allocTwoCharRoute');
      }
    }
    throw new Error('allocTwoCharRoute: kept clashing — try again');
  }

  // ── users ──
  async addUser(s: UserSpec): Promise<FixtureUser> {
    return (await this.addUsers([s]))[0]!;
  }

  async addUsers(specs: UserSpec[]): Promise<FixtureUser[]> {
    if (specs.length === 0) return [];
    const planned = await Promise.all(
      specs.map(async (s) => {
        if (this.usersByKey.has(s.key)) throw new Error(`user ${s.key} exists`);
        const route = s.route ? this.route(s.route) : undefined;
        const username = (s.username ?? (s.role === 'SALESMAN' && route ? route.code : `e2e.${s.key}.${this.sfx}`)).toLowerCase();
        // A forced-change account gets the real hand-out password, as the account master issues it.
        const password = (s.initialPassword ?? s.mustChangePassword) ? INITIAL_PASSWORD : RUN_PASSWORD;
        return {
          s,
          route,
          id: newId(),
          username,
          fullName: s.fullName ?? `${FIRST_NAME[s.role]} ${s.key} ${this.sfx}`,
          password,
          hash: await hashOnce(password),
          regionIds: (s.regions ?? []).map((k) => this.region(k).id),
        };
      })
    );
    const clash = await db.user.findMany({
      where: { username: { in: planned.map((p) => p.username) } },
      select: { username: true },
    });
    if (clash.length > 0) {
      throw new Error(`username(s) already on the database: ${clash.map((c) => c.username).join(', ')} — a fixture never reuses a row`);
    }
    // Ids first. A username that carries the suffix is recorded first too; one
    // that does not (a two-character route's salesman) only after its insert.
    this.registry.add('userIds', ...planned.map((p) => p.id));
    this.registry.add('usernames', ...planned.map((p) => p.username).filter((n) => this.carriesSuffix(n)));

    const idOf = (key: string | null | undefined): string | null => {
      if (!key) return null;
      const known = this.usersByKey.get(key)?.id ?? planned.find((p) => p.s.key === key)?.id;
      if (!known) throw new Error(`supervisor "${key}" is not a user of this world`);
      return known;
    };
    // Insert in waves so a supervisor row exists before his reports.
    const done = new Set<string>([...this.usersByKey.values()].map((u) => u.id));
    let pending = planned;
    while (pending.length > 0) {
      const wave = pending.filter((p) => {
        const sup = idOf(p.s.supervisor);
        return !sup || done.has(sup);
      });
      if (wave.length === 0) throw new Error('supervisor cycle in the world spec');
      await db.user.createMany({
        data: wave.map((p) => ({
          id: p.id,
          username: p.username,
          passwordHash: p.hash,
          fullName: p.fullName,
          role: p.s.role,
          isActive: p.s.isActive ?? true,
          email: p.s.email ?? null,
          mustChangePassword: p.s.mustChangePassword ?? false,
          supervisorId: idOf(p.s.supervisor),
          ownedRouteId: p.route?.id ?? null,
        })),
      });
      wave.forEach((p) => done.add(p.id));
      this.registry.add('usernames', ...wave.map((p) => p.username).filter((n) => !this.carriesSuffix(n)));
      pending = pending.filter((p) => !wave.includes(p));
    }
    const links = planned.flatMap((p) => p.regionIds.map((r) => [r, p.id] as const));
    if (links.length > 0) {
      const regionIds = links.map((l) => l[0]);
      const userIds = links.map((l) => l[1]);
      // The implicit many-to-many table: A = Region.id, B = User.id.
      await db.$executeRaw`INSERT INTO "_ManagerRegions" ("A", "B") SELECT * FROM UNNEST(${regionIds}::text[], ${userIds}::text[]) ON CONFLICT DO NOTHING`;
    }
    return planned.map((p) => {
      const u: FixtureUser = {
        key: p.s.key,
        id: p.id,
        username: p.username,
        fullName: p.fullName,
        role: p.s.role,
        password: p.password,
        regionIds: p.regionIds,
        routeId: p.route?.id,
        routeCode: p.route?.code,
        supervisorId: idOf(p.s.supervisor),
        mustChangePassword: p.s.mustChangePassword ?? false,
      };
      this.usersByKey.set(u.key, u);
      return u;
    });
  }

  // ── customers ──
  async allocPhones(n: number): Promise<string[]> {
    const out: string[] = [];
    while (out.length < n) {
      const want = n - out.length;
      const batch: string[] = [];
      for (let i = 0; i < want + 5; i++) {
        const seq = this.counters.phone++;
        if (seq > 99) throw new Error('world phone counter exhausted (100 per world)');
        batch.push(`+968${this.phoneBase}${String(seq).padStart(2, '0')}`);
      }
      const used = await db.customer.findMany({ where: { primaryPhoneNorm: { in: batch } }, select: { primaryPhoneNorm: true } });
      const usedSet = new Set(used.map((u) => u.primaryPhoneNorm));
      out.push(...batch.filter((p) => !usedSet.has(p)).slice(0, want));
    }
    return out;
  }

  async addCustomer(s: CustomerSpec): Promise<FixtureCustomer> {
    return (await this.addCustomers([s]))[0]!;
  }

  async addCustomers(specs: CustomerSpec[]): Promise<FixtureCustomer[]> {
    if (specs.length === 0) return [];
    assertOmanDayUnchanged();
    const chans = await channels();
    const phones = await this.allocPhones(specs.filter((s) => s.phone === true).length);
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    const photoSpecs: Array<{ customerKey: string; photo: PhotoSpec }> = [];

    const customers: Prisma.CustomerCreateManyInput[] = [];
    const branches: Prisma.BranchCreateManyInput[] = [];
    const fixtures: FixtureCustomer[] = [];

    for (const s of specs) {
      if (this.customersByKey.has(s.key)) throw new Error(`customer ${s.key} exists`);
      if (s.branches.length === 0) throw new Error(`customer ${s.key} needs at least one branch`);
      const n = ++this.counters.customer;
      const id = newId();
      const code = s.code ?? `000E2E${this.SFX}-${String(n).padStart(3, '0')}`;
      const legalName = s.legalName ?? `${s.key} Trading ${this.sfx}`;
      const paymentTerms: PaymentTerms = s.paymentTerms ?? 'CASH';
      const phone = s.phone === true ? phones.shift()! : typeof s.phone === 'string' ? s.phone : null;
      const cr = s.crNumber === true ? `CR${this.SFX}${String(++this.counters.cr).padStart(2, '0')}` : typeof s.crNumber === 'string' ? s.crNumber : null;
      const channelKey = s.channel === undefined ? 'GENERAL_TRADE' : s.channel;
      const ch = channelKey ? chans.get(channelKey) : undefined;
      if (channelKey && !ch) throw new Error(`channel ${channelKey} is not on this database`);
      const subChannelId = s.subChannel && ch ? (ch.subIds[0] ?? null) : null;
      const archivedAt = s.archived ? now : null;
      const wantsCrPhoto = Boolean(s.crPhoto && hasR2);
      const photoBy = s.photoBy ?? this.salesmanKeyOf(s.branches[0]!.route) ?? this.anyUploaderKey();

      const fbranches: Record<string, FixtureBranch> = {};
      const scoreRows: BranchForScore[] = [];
      s.branches.forEach((b: BranchSpec, i) => {
        const route = this.route(b.route);
        const bid = newId();
        const day: DayOfWeek | null = b.day === 'TODAY' ? OMAN_TODAY : (b.day ?? null);
        const photos = hasR2 ? (b.photos ?? []) : [];
        const row = {
          id: bid,
          customerId: id,
          branchCode: `${code}-${String(i + 1).padStart(2, '0')}`,
          branchName: `${legalName} ${b.key}`,
          regionId: route.regionId,
          routeId: route.id,
          address: b.address ?? 'Way 3012, Al Ghubra North, Muscat',
          gpsLat: b.gps ? b.gps.lat : null,
          gpsLng: b.gps ? b.gps.lng : null,
          gpsAccuracy: b.gps ? b.gps.accuracy : null,
          gpsCapturedAt: b.gps ? yesterday : null,
          dayOfVisit: day,
          openingHours: b.openingHours ?? null,
          coolersCount: b.coolersCount ?? 0,
          equipmentConfirmed: b.equipmentConfirmed ?? false,
          status: b.status ?? 'ACTIVE',
          lastStatusChangeAt: b.lastStatusChangeAt ?? (b.status === 'CLOSED' ? yesterday : null),
          deletedAt: b.deleted || archivedAt ? (archivedAt ?? now) : null,
          completenessScore: 0,
        };
        const score: BranchForScore = {
          gpsLat: row.gpsLat,
          gpsLng: row.gpsLng,
          address: row.address,
          shopPhotoId: photos.includes('SHOP') ? 'planned' : null,
          signboardPhotoId: photos.includes('SIGNBOARD') ? 'planned' : null,
          dayOfVisit: row.dayOfVisit,
          coolersCount: row.coolersCount,
          standsCount: 0,
          emptyBottlesCount: 0,
          equipmentConfirmed: row.equipmentConfirmed,
          openingHours: row.openingHours,
          deliveryWindow: null,
          status: row.status,
        };
        row.completenessScore = scoreBranch(score);
        if (!row.deletedAt) scoreRows.push(score);
        branches.push(row);
        for (const kind of photos) photoSpecs.push({ customerKey: s.key, photo: { kind, capturedBy: photoBy, branchId: bid, wire: kind } });
        fbranches[b.key] = {
          key: b.key,
          id: bid,
          code: row.branchCode,
          name: row.branchName,
          customerId: id,
          customerKey: s.key,
          routeId: route.id,
          regionId: route.regionId,
          day,
          deleted: Boolean(row.deletedAt),
        };
      });
      if (wantsCrPhoto) photoSpecs.push({ customerKey: s.key, photo: { kind: 'CR', capturedBy: photoBy, customerId: id, wire: 'CR' } });

      const forScore: CustomerForScore = {
        channelId: ch?.id ?? null,
        subChannelId,
        primaryPhone: phone,
        contactPerson: s.contact ?? null,
        crNumber: cr,
        crPhotoId: wantsCrPhoto ? 'planned' : null,
        paymentTerms,
        notes: s.notes ?? null,
      };
      customers.push({
        id,
        nmwcCode: code,
        legalName,
        paymentTerms,
        crNumber: cr,
        crNumberNorm: normalizeCR(cr),
        channelId: ch?.id ?? null,
        subChannelId,
        primaryPhone: phone,
        primaryPhoneNorm: phone,
        contactPerson: s.contact ?? null,
        notes: s.notes ?? null,
        completenessScore: scoreCustomer(forScore, scoreRows),
        creditLimit: paymentTerms === 'CREDIT' ? (s.creditLimit ?? '500.000') : null,
        paymentTermDays: paymentTerms === 'CREDIT' ? (s.termDays ?? 30) : null,
        temixCode: s.temixCode === undefined ? code : s.temixCode,
        // Archived fixtures stay SYNCED by default, so no world joins the UAT
        // Temix queue unless a test asks for it (it is org-wide).
        temixSyncState: s.temixSyncState ?? 'SYNCED',
        temixSyncPendingSince: s.temixSyncState === 'PENDING_UPLOAD' || s.temixSyncState === 'DEACTIVATE_PENDING' ? now : null,
        deletedAt: archivedAt,
      });
      const first = fbranches[s.branches[0]!.key]!;
      fixtures.push({
        key: s.key,
        id,
        code,
        legalName,
        paymentTerms,
        phone,
        crNumber: cr,
        archived: Boolean(archivedAt),
        branches: fbranches,
        branch: first,
        photos: [],
      });
    }

    this.registry.add('customerIds', ...customers.map((c) => c.id!));
    this.registry.add('branchIds', ...branches.map((b) => b.id!));
    try {
      await db.customer.createMany({ data: customers });
      await db.branch.createMany({ data: branches });
    } catch (err) {
      throw safeError(err, 'creating fixture customers failed');
    }
    fixtures.forEach((c) => this.customersByKey.set(c.key, c));

    if (photoSpecs.length > 0) {
      const seeded = await seedPhotos(this, photoSpecs.map((p) => p.photo));
      seeded.forEach((p, i) => this.customer(photoSpecs[i]!.customerKey).photos.push(p));
    }
    return fixtures;
  }

  private salesmanKeyOf(routeKey: string): string | undefined {
    const route = this.routes.get(routeKey);
    return [...this.usersByKey.values()].find((u) => u.role === 'SALESMAN' && u.routeId === route?.id)?.key;
  }

  private anyUploaderKey(): string {
    const u = [...this.usersByKey.values()].find((x) => x.role === 'STEWARD' || x.role === 'SALESMAN' || x.role === 'MANAGER');
    if (!u) throw new Error('photos need a fixture user to capture them (a salesman, manager or steward)');
    return u.key;
  }

  /** Whether a typed value (username, code, name) carries this world's suffix. */
  carriesSuffix(value: string): boolean {
    return value.toLowerCase().includes(this.sfx);
  }

  /** A username or code may be adopted by value only when it carries the suffix. */
  private bySuffix(what: 'user' | 'routeCode' | 'regionCode', value: string): string {
    if (!this.carriesSuffix(value)) {
      const byId = { user: 'userId', routeCode: 'routeId', regionCode: 'regionId' }[what];
      throw new Error(
        `world.adopt.${what}("${value}") — it does not carry the world suffix ${this.sfx}, so cleanup could match ` +
          `someone else's row by it. Type the suffix into it (world.name()), or adopt the row by id (adopt.${byId}).`
      );
    }
    return value;
  }

  readonly adopt = {
    user: (username: string) => this.registry.add('usernames', this.bySuffix('user', username).toLowerCase()),
    userId: (id: string) => this.registry.add('userIds', id),
    customer: (id: string) => this.registry.add('customerIds', id),
    edit: (id: string) => this.registry.add('editIds', id),
    attachment: (id: string) => this.registry.add('attachmentIds', id),
    importBatch: (id: string) => this.registry.add('importBatchIds', id),
    temixBatch: (id: string) => this.registry.add('temixBatchIds', id),
    routeCode: (code: string) => this.registry.add('routeCodes', this.bySuffix('routeCode', code)),
    routeId: (id: string) => this.registry.add('routeIds', id),
    regionCode: (code: string) => this.registry.add('regionCodes', this.bySuffix('regionCode', code)),
    regionId: (id: string) => this.registry.add('regionIds', id),
    ip: (ip: string) => {
      if (!/^198\.(18|19)\.\d{1,3}\.\d{1,3}$/.test(ip)) throw new Error(`world.adopt.ip: ${ip} is not a test address (198.18.0.0/15)`);
      this.registry.add('ips', ip);
    },
  };

  async cleanup() {
    return cleanupRegistry(this.registry);
  }

  async residue() {
    return residue(this.registry.data);
  }
}

/** Builds a world from a spec. Call it in a describe-level beforeAll. */
export async function createWorld(tag: string, spec: WorldSpec): Promise<World> {
  assertNotProduction();
  assertOmanDayUnchanged();
  if (!RUN_ID) throw new Error('E2E_RUN_ID is not set — run through playwright.launch.config.ts');
  const { sfx, workerIndex, projectIdx } = makeSuffix(tag);
  const registry = Registry.create({ runId: RUN_ID, name: sfx, sfx, tag });
  const w = new WorldImpl(sfx, tag, registry, { workerIndex, projectIdx, counter: worldCounter++ });
  try {
    await w.addRegions((spec.regions ?? []).map((r) => r.key));
    await w.addRoutes(spec.routes ?? []);
    await w.addUsers(spec.users ?? []);
    await w.addCustomers(spec.customers ?? []);
  } catch (err) {
    // Whatever was written is in the registry; afterAll (or the sweep) removes it.
    throw safeError(err, `building world ${sfx} failed`);
  }
  return w;
}

function mergeByKey<T extends { key: string }>(base: T[], extra: T[] | undefined): T[] {
  if (!extra?.length) return base;
  const replaced = new Map(extra.map((e) => [e.key, e]));
  return [...base.map((b) => replaced.get(b.key) ?? b), ...extra.filter((e) => !base.some((b) => b.key === e.key))];
}

/**
 * The standard shape (plan "FIXTURES"): regions R1 (MCT-like, managers M1 and M2
 * share it) and R2 (M5); routes A, A2 and FREE (unowned) in R1, B in R2;
 * salesmen SA (A, supervisor M1), SA2 (A2, M2), SB (B, M5); ACC1/ACC2, FM1, FM2,
 * GM1, STW, VW and SUP (a SUPERVISOR with no reports — production salesmen
 * report to Managers; pass {key:'SA', …, supervisor:'SUP'} in extra.users to put
 * SA under him). Customers: GAPS, FULL, CRED, MULTI, CLOSEDB, ARCH, DUE1, DUE2,
 * OTHERDAY, NODAY1, NODAY2, DELETED, BONLY.
 *
 * `extra` entries with an existing key REPLACE that entry; new keys are added.
 */
export async function standardWorld(tag: string, extra: Partial<WorldSpec> = {}): Promise<World> {
  const regions = mergeByKey([{ key: 'R1' }, { key: 'R2' }], extra.regions);
  const routes = mergeByKey(
    [
      { key: 'A', region: 'R1' },
      { key: 'A2', region: 'R1' },
      { key: 'FREE', region: 'R1' },
      { key: 'B', region: 'R2' },
    ],
    extra.routes
  );
  const users = mergeByKey<UserSpec>(
    [
      { key: 'M1', role: 'MANAGER', regions: ['R1'] },
      { key: 'M2', role: 'MANAGER', regions: ['R1'] },
      { key: 'M5', role: 'MANAGER', regions: ['R2'] },
      { key: 'SA', role: 'SALESMAN', route: 'A', supervisor: 'M1' },
      { key: 'SA2', role: 'SALESMAN', route: 'A2', supervisor: 'M2' },
      { key: 'SB', role: 'SALESMAN', route: 'B', supervisor: 'M5' },
      { key: 'ACC1', role: 'ACCOUNTANT', regions: ['R1'] },
      { key: 'ACC2', role: 'ACCOUNTANT', regions: ['R2'] },
      { key: 'FM1', role: 'FINANCE_MANAGER' },
      { key: 'FM2', role: 'FINANCE_MANAGER' },
      { key: 'GM1', role: 'GM' },
      { key: 'STW', role: 'STEWARD' },
      { key: 'VW', role: 'VIEWER' },
      { key: 'SUP', role: 'SUPERVISOR' },
    ],
    extra.users
  );
  const gps = { lat: MUSCAT.lat, lng: MUSCAT.lng, accuracy: MUSCAT.accuracy };
  const customers = mergeByKey<CustomerSpec>(
    [
      { key: 'GAPS', phone: null, contact: null, branches: [{ key: 'S', route: 'A' }] },
      {
        key: 'FULL',
        phone: true,
        contact: 'Salim Al Balushi',
        crNumber: true,
        crPhoto: true,
        subChannel: true,
        branches: [
          {
            key: 'S',
            route: 'A',
            gps,
            // A visit day too, so FULL passes even SALESMAN_SUBMIT_GATE=FULL — not today's.
            day: omanDayAfter(2),
            photos: ['SHOP', 'SIGNBOARD'],
            openingHours: '08:00-22:00',
            coolersCount: 1,
            equipmentConfirmed: true,
            address: 'Way 3012, Al Ghubra North, Muscat — opposite the bakery',
          },
        ],
      },
      {
        key: 'CRED',
        paymentTerms: 'CREDIT',
        creditLimit: '500.000',
        termDays: 30,
        phone: true,
        contact: 'Khalid Al Harthy',
        crNumber: true,
        branches: [{ key: 'S', route: 'A' }],
      },
      {
        key: 'MULTI',
        phone: true,
        contact: 'Nasser Al Rawahi',
        branches: [
          { key: 'A1', route: 'A' },
          { key: 'A2', route: 'A' },
          { key: 'B1', route: 'B' },
        ],
      },
      {
        key: 'CLOSEDB',
        phone: true,
        branches: [{ key: 'S', route: 'A', status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - 86_400_000) }],
      },
      { key: 'ARCH', phone: true, archived: true, branches: [{ key: 'S', route: 'A' }] },
      { key: 'DUE1', phone: true, contact: 'Hamed Al Siyabi', branches: [{ key: 'S', route: 'A', day: 'TODAY' }] },
      { key: 'DUE2', phone: true, contact: 'Yusuf Al Kindi', branches: [{ key: 'S', route: 'A', day: 'TODAY' }] },
      { key: 'OTHERDAY', phone: true, branches: [{ key: 'S', route: 'A', day: omanDayAfter(1) }] },
      { key: 'NODAY1', phone: true, branches: [{ key: 'S', route: 'A', day: null }] },
      { key: 'NODAY2', phone: true, branches: [{ key: 'S', route: 'A', day: null }] },
      { key: 'DELETED', phone: true, branches: [{ key: 'S', route: 'A', deleted: true }] },
      { key: 'BONLY', phone: true, branches: [{ key: 'S', route: 'B', day: 'TODAY' }] },
    ],
    extra.customers
  );
  return createWorld(tag, { regions, routes, users, customers });
}
