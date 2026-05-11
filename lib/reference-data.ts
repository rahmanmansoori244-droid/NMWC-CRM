/**
 * F1 (2026-05-11) — cached reference-data lookups.
 *
 * Before: `/customers` ran 6 Prisma queries on every page load just to
 * populate the filter dropdowns (regions, routes, channels, sub-channels,
 * supervisors, salesmen). At ~50-80 ms each (network round-trip to Neon
 * via fra1) this added ~300-500 ms to every navigation.
 *
 * After: each lookup is wrapped in `unstable_cache` with a 5-minute
 * revalidate window. Reference data barely changes day-to-day (a new
 * salesman is onboarded once a week; a new channel is added once a quarter)
 * so 5 minutes of staleness is invisible to the user but turns six
 * 80-ms queries into six near-zero-ms cache reads.
 *
 * Cache invalidation:
 *   - Time-based: `revalidate: 300` automatically refreshes every 5 min.
 *   - Tag-based: each entry has a tag (e.g. 'ref:routes'). Mutating
 *     services (e.g. routes/users when a manager onboards a salesman)
 *     should call `revalidateTag('ref:routes')` after the write so the
 *     change is reflected immediately for the manager who made it.
 *
 * Per-request memoization within a single render is layered on top via
 * React's `cache()` so each render only hits the unstable_cache once.
 *
 * IMPORTANT: scope-FILTERED lookups (routes-for-this-supervisor,
 * salesmen-for-this-supervisor) cannot share a global cache key. We cache
 * the FULL list once and filter in memory at the call site — the lists
 * are small (≤50 routes, ≤80 users) so in-memory filtering is free.
 */
import { unstable_cache } from 'next/cache';
import { cache as reactCache } from 'react';
import { prisma } from './db';
import { Role } from '@prisma/client';

export type RegionLite = { id: string; name: string; code: string };
export type RouteLite = { id: string; code: string; name: string; regionId: string };
export type ChannelLite = { id: string; label: string };
export type SubChannelLite = { id: string; label: string; channelId: string };
export type UserLite = { id: string; fullName: string; username: string; role: Role; ownedRouteId: string | null; supervisorId: string | null };

const REVALIDATE_SECS = 5 * 60; // 5 minutes

/** Active regions, sorted by name. ~7 rows. */
export const getAllActiveRegions = reactCache(
  unstable_cache(
    async (): Promise<RegionLite[]> => {
      return prisma.region.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, code: true },
      });
    },
    ['ref:regions:v1'],
    { revalidate: REVALIDATE_SECS, tags: ['ref:regions'] }
  )
);

/** Active routes, sorted by code. ~50 rows. */
export const getAllActiveRoutes = reactCache(
  unstable_cache(
    async (): Promise<RouteLite[]> => {
      return prisma.route.findMany({
        where: { isActive: true },
        orderBy: { code: 'asc' },
        select: { id: true, code: true, name: true, regionId: true },
      });
    },
    ['ref:routes:v1'],
    { revalidate: REVALIDATE_SECS, tags: ['ref:routes'] }
  )
);

/** Active channels, by display order. ~7 rows. */
export const getAllActiveChannels = reactCache(
  unstable_cache(
    async (): Promise<ChannelLite[]> => {
      return prisma.channel.findMany({
        where: { isActive: true },
        orderBy: { displayOrder: 'asc' },
        select: { id: true, label: true },
      });
    },
    ['ref:channels:v1'],
    { revalidate: REVALIDATE_SECS, tags: ['ref:channels'] }
  )
);

/** Active sub-channels, alphabetical. ~30 rows. */
export const getAllActiveSubChannels = reactCache(
  unstable_cache(
    async (): Promise<SubChannelLite[]> => {
      return prisma.subChannel.findMany({
        where: { isActive: true },
        orderBy: { label: 'asc' },
        select: { id: true, label: true, channelId: true },
      });
    },
    ['ref:subchannels:v1'],
    { revalidate: REVALIDATE_SECS, tags: ['ref:subchannels'] }
  )
);

/**
 * Every active user with a hierarchy-relevant role (Salesman, Supervisor,
 * Manager). Returned with `supervisorId` and `ownedRouteId` so callers can
 * filter to "salesmen who report to X" in memory. ~80 rows in the pilot.
 */
export const getAllHierarchyUsers = reactCache(
  unstable_cache(
    async (): Promise<UserLite[]> => {
      return prisma.user.findMany({
        where: {
          isActive: true,
          role: { in: [Role.SALESMAN, Role.SUPERVISOR, Role.MANAGER] },
        },
        orderBy: { fullName: 'asc' },
        select: {
          id: true,
          fullName: true,
          username: true,
          role: true,
          ownedRouteId: true,
          supervisorId: true,
        },
      });
    },
    ['ref:users:v1'],
    { revalidate: REVALIDATE_SECS, tags: ['ref:users'] }
  )
);

/**
 * Helper to invalidate every reference-data tag at once — useful after a
 * bulk import that touched routes + users + channels in one shot.
 */
export const REFERENCE_DATA_TAGS = [
  'ref:regions',
  'ref:routes',
  'ref:channels',
  'ref:subchannels',
  'ref:users',
] as const;
