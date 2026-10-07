/**
 * The shapes of a launch-suite world. Kept apart from world.ts so photos.ts and
 * seeds.ts can use them without an import cycle.
 */
import type { AttachmentKind, DayOfWeek, PaymentTerms, Role, TemixSyncState } from '@prisma/client';
import type { CleanupResult, Residue } from './cleanup';
import type { Registry } from './registry';

export type DeviceKind = 'phone' | 'phone360' | 'tablet' | 'desktop';

export interface UserSpec {
  key: string;
  role: Role;
  /** Region keys: managedRegions of a MANAGER or ACCOUNTANT. */
  regions?: string[];
  /** Route key a SALESMAN owns; his username is then the route code in lower case. */
  route?: string;
  /** User key of his supervisor (a MANAGER in production). */
  supervisor?: string | null;
  /** Forced password change at the next sign-in. Such a fixture gets '12345' unless initialPassword is false. */
  mustChangePassword?: boolean;
  /** Use the real hand-out password '12345'. Defaults to mustChangePassword; else the run's password. */
  initialPassword?: boolean;
  username?: string;
  fullName?: string;
  email?: string;
  isActive?: boolean;
}

export interface BranchSpec {
  key: string;
  /** Route key. The branch's region is the route's region. */
  route: string;
  /** 'TODAY' = the run's Oman day (OMAN_TODAY); null/omitted = no visit day. */
  day?: DayOfWeek | 'TODAY' | null;
  gps?: { lat: number; lng: number; accuracy: number } | null;
  address?: string;
  status?: 'ACTIVE' | 'CLOSED';
  lastStatusChangeAt?: Date;
  /** Soft-deleted branch (deletedAt set). */
  deleted?: boolean;
  /** Seeded photos wired to the branch's slots (skipped when R2 is not configured). */
  photos?: ('SHOP' | 'SIGNBOARD')[];
  openingHours?: string | null;
  coolersCount?: number;
  equipmentConfirmed?: boolean;
}

export interface CustomerSpec {
  key: string;
  paymentTerms?: PaymentTerms;
  /** true = a fresh unique +9689… number; a string = that number; null/omitted = none. */
  phone?: string | boolean | null;
  contact?: string | null;
  /** true = CR<SFX>NN; a string = that number; null/omitted = none. */
  crNumber?: string | boolean | null;
  crPhoto?: boolean;
  /** Archived (customer and branches soft-deleted), as archiveCustomerAction leaves it. */
  archived?: boolean;
  temixCode?: string | null;
  temixSyncState?: TemixSyncState;
  creditLimit?: string;
  termDays?: number;
  code?: string;
  legalName?: string;
  /** Channel key (default GENERAL_TRADE); subChannel picks its first sub-channel. */
  channel?: string | null;
  subChannel?: boolean;
  notes?: string | null;
  /** User key that captured the seeded photos (default: the salesman of the first branch's route). */
  photoBy?: string;
  branches: BranchSpec[];
}

export interface WorldSpec {
  regions?: { key: string }[];
  routes?: { key: string; region: string; twoChar?: boolean; isActive?: boolean }[];
  users?: UserSpec[];
  customers?: CustomerSpec[];
}

export interface FixtureRegion {
  key: string;
  id: string;
  code: string;
  name: string;
}

export interface FixtureRoute {
  key: string;
  id: string;
  code: string;
  name: string;
  regionId: string;
  regionKey: string;
}

export interface FixtureUser {
  key: string;
  id: string;
  username: string;
  fullName: string;
  role: Role;
  /** The current known password. Never log it. */
  password: string;
  regionIds: string[];
  routeId?: string;
  routeCode?: string;
  supervisorId: string | null;
  mustChangePassword: boolean;
}

export interface FixtureBranch {
  key: string;
  id: string;
  code: string;
  name: string;
  customerId: string;
  customerKey: string;
  routeId: string;
  regionId: string;
  day: DayOfWeek | null;
  deleted: boolean;
}

export interface SeededPhoto {
  id: string;
  r2Key: string;
  kind: AttachmentKind;
  /** The exact bytes stored in R2 (unique per photo). */
  bytes: Buffer;
  size: number;
  sha256: string;
  capturedById: string;
  customerId: string | null;
  branchId: string | null;
  editId: string | null;
  wire: 'CR' | 'SHOP' | 'SIGNBOARD' | null;
}

export interface FixtureCustomer {
  key: string;
  id: string;
  code: string;
  legalName: string;
  paymentTerms: PaymentTerms;
  phone: string | null;
  crNumber: string | null;
  archived: boolean;
  branches: Record<string, FixtureBranch>;
  /** The first branch (most customers have one). */
  branch: FixtureBranch;
  photos: SeededPhoto[];
}

export interface World {
  readonly sfx: string;
  readonly SFX: string;
  readonly tag: string;
  readonly runId: string;
  readonly registry: Registry;
  /** 198.18.x.n / 198.19.x.n — this world's sign-in addresses (x-forwarded-for). */
  ip(n?: number): string;
  /** `${base} ${sfx}` — every typed value embeds the suffix. */
  name(base: string): string;
  region(k: string): FixtureRegion;
  route(k: string): FixtureRoute;
  user(k: string): FixtureUser;
  customer(k: string): FixtureCustomer;
  /** 'CUST' = its first branch; 'CUST.BRANCH' = a named branch. */
  branch(k: string): FixtureBranch;
  users(): FixtureUser[];
  customers(): FixtureCustomer[];
  /** Fixture user ids — the only folders the R2 guard lets the suite touch. */
  fixtureUserIds(): Set<string>;
  addRegion(key: string): Promise<FixtureRegion>;
  addRoute(s: { key: string; region: string; twoChar?: boolean; isActive?: boolean }): Promise<FixtureRoute>;
  addUser(s: UserSpec): Promise<FixtureUser>;
  addCustomer(s: CustomerSpec): Promise<FixtureCustomer>;
  /** A free Z?/Y? two-character route in the region (retries on a clash). */
  allocTwoCharRoute(region: string, key?: string): Promise<FixtureRoute>;
  /** Unique +9689… numbers, checked unused on the database. */
  allocPhones(n: number): Promise<string[]>;
  /** Registers rows the UI created, so cleanup finds them. */
  adopt: {
    user(username: string): void;
    customer(id: string): void;
    edit(id: string): void;
    attachment(id: string): void;
    importBatch(id: string): void;
    temixBatch(id: string): void;
    routeCode(code: string): void;
    regionCode(code: string): void;
    ip(ip: string): void;
  };
  /** Idempotent. Deletes everything, returns what is left (all zero when clean). */
  cleanup(): Promise<CleanupResult>;
  /** What is left now, by id and by suffix, without deleting. */
  residue(): Promise<Residue>;
}
