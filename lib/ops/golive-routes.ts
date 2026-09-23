/**
 * What a route is CALLED in the go-live master.
 *
 * A CRM Route row carries a `code` and a `name`. Nothing keys a route by its name:
 * the journey plan, the sales upload, dq/routes-active.csv and the salesman's own
 * login all use the code. So the name column adds no information — but it did add
 * something worse.
 *
 * `scripts/golive/build-masters.ts` canonicalises the route CODE. RoutePro's
 * "NZ05 -DIRECT" and the dashboard's "NIZDIR" and "NZ05" all collapse to NIZD
 * (journey-plan brain, law 8); the dashboard's "DQ1" collapses to DQ01. The NAME,
 * though, was copied straight out of the dashboard's `dim_route.route_name`, which
 * is the spelling from BEFORE that collapse — so the losing alias survived in the
 * name column. Of the 44 routes loaded on 2026-09-23, three read name ≠ code:
 * AW03 named "Al Wafi Route 3", DQ01 named "DQ1", NIZD named "NZ05".
 *
 * The owner read the third as two routes merged by mistake. It is not — NZ05 and
 * NIZD are one route and the merge is deliberate — but a master that prints one
 * system's identifier for a route under another system's is what raises the
 * question. And NIZD's name depended on whether SQLite returned the "NZ05" row or
 * a "NIZDIR" row first, so the same sources could build two different masters on
 * two runs.
 *
 * The rule, therefore: a route's name is its canonical code. No label from a
 * source system may become a second identifier for a route.
 *
 * It governs the routes the BUILDER EMITS, and nothing else. services/imports.ts
 * upserts a Route by `code` and never deletes, so a route that is already in the
 * CRM but absent from this build's Routes sheet keeps the name it was loaded
 * with — this rule never reaches it. The build of 2026-09-23 16:42 emits 43
 * routes and the owner counts 44 on /routes, so at least one production route is
 * outside it; RECONCILIATION.md item 17 says how to find which.
 *
 * The labels are not dropped silently, but dq/route-code-aliases.csv is narrower
 * than that sentence used to claim. Only two of the eight places
 * build-masters.ts canonicalises a route code record what they saw: the
 * dashboard's `dim_route` and the RoutePro route master. fact_sales_lines,
 * agg_route, the daily sales upload, JP_MASTER_CURRENT, the Code-Branch master
 * and the RoutePro CUSTOMER master all canonicalise without writing evidence, so
 * a disagreement that exists only in one of those is not in that file. (The
 * customer master's variants are counted, by a different route, in
 * dq/routepro-route-variants-merged.csv.)
 */

/** The name the go-live master gives the route whose canonical code is `code`. */
export const routeMasterName = (code: string): string => code;

/**
 * Why `name` is not an acceptable name for route `code`, or null if it is.
 *
 * Returns a sentence rather than a boolean so a failing guard names the route and
 * quotes what it actually read — the three that diverged were only found because
 * someone read the screen, and the next one should be found by the build.
 */
export function routeNameIssue(code: string, name: string): string | null {
  if (!code) return 'a route was built with no code';
  if (name !== routeMasterName(code))
    return `route ${code} is named "${name}"; the go-live master names every route by its canonical code`;
  return null;
}
