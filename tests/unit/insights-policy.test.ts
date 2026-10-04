// @vitest-environment node
/**
 * F2: lib/insights/policy.ts holds the dashboard's owner decisions, none of them
 * answered yet. Two kinds of entry live there, and this file keeps each honest:
 *
 *   - a SWITCH is read by the dashboard's code, so changing it changes the page —
 *     proved here by finding each one read outside the policy module;
 *   - a RECORD names a default the code implements in its structure, with ONE
 *     supported value — pinned here, so editing the line alone (say, after the
 *     owner answers) fails and points at the code that must change with it.
 *
 * Also: the Manager's "Pending approval" counts the steps /status counts for him
 * (lib/service-levels.ts MANAGER_VIEW_ROLES), and the policy module's pointer to
 * the open questions names the section that holds them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';
import {
  ATTRIBUTION,
  MANAGER_PENDING_STEP_ROLES,
  MANAGER_SEES_COMPANY_FIGURES,
  NEW_CUSTOMERS,
  ROUTE_LEVEL_ONLY,
} from '@/lib/insights/policy';
import { MANAGER_VIEW_ROLES } from '@/lib/service-levels';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p.replace(/\\/g, '/')] : [];
  });
}

/** The dashboard's code, comments stripped, without the policy module itself. */
const code = [...files('lib/insights'), ...files('app/(app)/dashboard'), ...files('components/insights')]
  .filter((f) => f !== 'lib/insights/policy.ts')
  .map((f) => stripComments(readFileSync(f, 'utf8'), f))
  .join('\n');

describe('a RECORD has one supported value: the code, not this line, implements it', () => {
  it('new customers are counted as finalized new-customer requests', () => {
    expect(
      NEW_CUSTOMERS.counts,
      'lib/insights/load.ts createdSql counts finalized CREATE requests; another answer means a new statement there'
    ).toBe('requests-finalized');
  });

  it('activity is attributed to the current route and region', () => {
    expect(
      ATTRIBUTION,
      'the joins in lib/insights/load.ts and sql.ts read the current Branch.routeId and Route.regionId; another answer is a schema change'
    ).toBe('current-route-and-region');
  });

  it('figures are route-level only, never per salesman', () => {
    expect(ROUTE_LEVEL_ONLY, 'no statement in lib/insights/load.ts groups by person; per-salesman figures are new statements').toBe(true);
  });

  it('a Manager sees no company figure', () => {
    expect(
      MANAGER_SEES_COMPANY_FIGURES,
      'lib/insights/scope.ts scopes every statement to the viewer; a benchmark is a second, unscoped wave and a privacy review'
    ).toBe(false);
  });

  it.each(['NEW_CUSTOMERS.counts', 'ATTRIBUTION', 'ROUTE_LEVEL_ONLY', 'MANAGER_SEES_COMPANY_FIGURES'])(
    '%s is read by no code, so nobody mistakes it for a switch that works',
    (name) => {
      expect(code).not.toMatch(new RegExp(`\\b${name.replace('.', '\\.')}\\b`));
    }
  );
});

describe('a SWITCH is read by the dashboard, so changing it changes the page', () => {
  it.each(['DASHBOARD_ROLES|isDashboardRole', 'NEW_CUSTOMERS\\.showImported', 'UPDATED_CUSTOMERS\\.includeDirectWrites', 'MANAGER_PENDING_STEP_ROLES', 'MAP\\.'])(
    '%s',
    (pattern) => {
      expect(code).toMatch(new RegExp(`\\b(${pattern})`));
    }
  );
});

describe('the Manager’s "Pending approval" counts what /status counts for him', () => {
  it('the same step roles as lib/service-levels.ts MANAGER_VIEW_ROLES', () => {
    expect(
      [...MANAGER_PENDING_STEP_ROLES],
      'the dashboard says its Pending tile matches /status and the /approvals queue: change both together'
    ).toEqual([...MANAGER_VIEW_ROLES]);
  });
});

describe('the pointer to the open questions', () => {
  it('names the section of docs/handover/04-PENDING-WORK.md that lists them', () => {
    const policy = readFileSync('lib/insights/policy.ts', 'utf8');
    const pending = readFileSync('docs/handover/04-PENDING-WORK.md', 'utf8');
    expect(policy).toMatch(/04-PENDING-WORK\.md section A6/);
    expect(pending).toMatch(/^### A6\. Insights dashboard \(F2\)/m);
  });
});
