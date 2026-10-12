// @vitest-environment node
/**
 * Gap 16, restated by the owner on 2026-10-11: a route NEVER moves to another
 * region. The database refuses it (route_region_fixed) and the account import
 * holds such a row back first — in the same words, so the Steward reads one
 * sentence whichever layer refuses. This pins the words in both places, and that
 * the import's row rule uses them (lib/route-region.ts).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ROUTE_REGION_FIXED_MESSAGE,
  isRouteRegionRefusal,
  routeRegionHeldMessage,
} from '@/lib/route-region';
import { stripComments } from '../support/strip-comments';

const MIGRATION = 'prisma/migrations/20261015100100_route_region_fixed/migration.sql';

describe('a route never changes region', () => {
  it('says the owner’s rule in plain words', () => {
    expect(ROUTE_REGION_FIXED_MESSAGE).toBe(
      'Routes never move to another region. Close this route and open a new one in the other region.'
    );
  });

  it('the database raises exactly those words, for every change of Route.regionId, with no override', () => {
    const sql = readFileSync(MIGRATION, 'utf8').replace(/--[^\n]*/g, '');
    expect(sql).toContain(`RAISE EXCEPTION '${ROUTE_REGION_FIXED_MESSAGE}'`);
    expect(sql).toMatch(/BEFORE UPDATE OF "regionId" ON "Route"/);
    expect(sql).not.toMatch(/audit_maintenance/);
  });

  it('the account import’s issue says the rule, the route, both regions, and whether its name was saved', () => {
    expect(routeRegionHeldMessage({ routeCode: 'MCT-02', storedRegionCode: 'MCT', sheetRegionCode: 'BAT', renamed: false })).toBe(
      `${ROUTE_REGION_FIXED_MESSAGE} Route MCT-02 is in region MCT; this row says BAT.`
    );
    expect(
      routeRegionHeldMessage({ routeCode: 'MCT-02', storedRegionCode: 'MCT', sheetRegionCode: 'BAT', renamed: true })
    ).toMatch(/Its new name was saved\.$/);
  });

  it('tells the database refusal apart from any other error', () => {
    expect(isRouteRegionRefusal(new Error(`Invalid update: ${ROUTE_REGION_FIXED_MESSAGE}`))).toBe(true);
    expect(isRouteRegionRefusal(new Error('B-19: Branch.regionId must match Route.regionId'))).toBe(false);
  });

  it('the account import holds the row back before any region is written, and only renames', () => {
    const src = stripComments(readFileSync('services/imports.ts', 'utf8'), 'imports.ts');
    // From the Routes row's cause to the end of that row (its applied()).
    const routes = src.slice(src.indexOf("src.importAccount(batch.id, 'Routes', sheetRow)"));
    const block = routes.slice(0, routes.indexOf('applied();') + 'applied();'.length);
    // The only Route update writes the name; a region is set only on create.
    expect(block.match(/tx\.route\.update\(/g)).toHaveLength(1);
    expect(block).toMatch(/tx\.route\.update\(\{ where: \{ id: before\.id \}, data: \{ name \} \}\)/);
    expect(block).toMatch(/before\.regionId !== region\.id\s*\?\s*routeRegionHeldMessage\(/);
    expect(block).toMatch(/if \(regionHeld\) \{\s*issues\.push\(\{ sheet: 'Routes', row: sheetRow, message: regionHeld \}\);\s*continue;\s*\}/);
  });
});
