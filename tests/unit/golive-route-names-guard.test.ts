// @vitest-environment node
/**
 * No route in the go-live master may be named anything but its canonical code.
 *
 * Found by the owner walking https://nmwc-cm.vercel.app/routes on load day: under
 * region "Al Wafi" the three routes read AW01 / AW02 / "Al Wafi Route 3". Of the 44
 * loaded routes, three had a name that differed from their code — AW03 "Al Wafi
 * Route 3", DQ01 "DQ1", NIZD "NZ05".
 *
 * The builder canonicalises the route CODE (NZ05 and NIZDIR both become NIZD, DQ1
 * becomes DQ01) but took the NAME verbatim from the dashboard's
 * `dim_route.route_name`, which is the pre-canonicalisation spelling. NIZD named
 * "NZ05" therefore printed one source system's identifier for a route under
 * another's, which reads as a merge gone wrong. It was not one — but nothing in the
 * build said so, and NIZD's name depended on which `dim_route` row SQLite returned
 * first, so two runs over the same sources could produce two different masters.
 *
 * Structural, not behavioural: the builder needs a SQLite dashboard and four files
 * on a specific Desktop to run at all, so the thing worth pinning is that the rule
 * exists, that the builder is the caller of it, and that the dashboard label cannot
 * get back into the name column. When the built master happens to be present, its
 * Routes sheet is checked too — for staleness only; see that block for what that
 * check does not prove.
 *
 * This file also guards the builder's supersede list, because making the change
 * above meant re-running the builder, and the re-run destroyed the account master
 * that had been imported into production 53 minutes earlier.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { routeMasterName, routeNameIssue } from '@/lib/ops/golive-routes';

const BUILDER = 'scripts/golive/build-masters.ts';
const raw = readFileSync(BUILDER, 'utf8');
/**
 * Strip comments before asserting on the source. This file's own explanation, and
 * the builder's, quote the identifiers being matched; a comment must never be the
 * thing that makes an assertion pass.
 */
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the go-live route-name rule', () => {
  it('accepts a name that is the canonical code', () => {
    expect(routeNameIssue('NIZD', routeMasterName('NIZD'))).toBeNull();
    expect(routeNameIssue('AW03', 'AW03')).toBeNull();
  });

  it.each([
    ['AW03', 'Al Wafi Route 3'],
    ['DQ01', 'DQ1'],
    ['NIZD', 'NZ05'],
    ['NIZD', 'NIZDIR'],
    ['BMU01Y', 'BMU01'],
    ['WAC-S0', 'WAC/S0'],
  ])('rejects %s named "%s" and says which route it is', (routeCode, name) => {
    const issue = routeNameIssue(routeCode, name);
    expect(issue).not.toBeNull();
    expect(issue).toContain(routeCode);
    expect(issue).toContain(name);
  });

  it('rejects a route with no code rather than accepting an empty name', () => {
    expect(routeNameIssue('', '')).not.toBeNull();
  });
});

describe('the builder still applies the rule', () => {
  it('reads the builder being guarded', () => {
    // Without this the whole file can pass against a renamed or deleted builder.
    expect(code).toMatch(/const routes:\s*Array</);
    expect(code).toMatch(/addSheet\(\s*acct,\s*'Routes'/);
  });

  it('names routes through the shared rule, not by re-spelling it', () => {
    // The same trap lib/ops/golive-accounts.ts exists for: a rule the builder does
    // not call is a rule that does not run.
    expect(code).toMatch(/from '\.\.\/\.\.\/lib\/ops\/golive-routes'/);
  });

  it('never puts the dashboard label back in the name column', () => {
    // The defect verbatim: `if (!routeName.has(code)) routeName.set(code, S(r.route_name) || code)`
    // feeding `name: routeName.get(code) ?? code`. Pinned at the push itself rather
    // than by banning an identifier across the file — a ban on /routeName/ would go
    // red the day someone legitimately calls routeNameIssue() here, which is a guard
    // failing for the wrong reason.
    //
    // indexOf, then a bounds check. `code.slice(code.indexOf(x))` with x absent is
    // slice(-1) — the file's LAST CHARACTER, not '' — so the "it is gone" assertion
    // below used to be unfirable, and a rename of the `routes` accumulator failed on
    // the naming assertion instead, pointing the next engineer at a rule nobody had
    // broken.
    const at = code.indexOf('routes.push(');
    expect(
      at,
      'the routes.push being guarded is gone — was the accumulator renamed?'
    ).toBeGreaterThan(-1);
    const end = code.indexOf('});', at);
    expect(end, 'the routes.push object literal is not closed with `});`').toBeGreaterThan(-1);
    const literal = code.slice(at, end + 3);
    expect(literal).toMatch(/name:\s*routeMasterName\(code\)/);
    expect(literal).not.toMatch(/route_name/);
    // The map that carried the label into the name column must not come back under
    // its old name either.
    expect(code).not.toMatch(/\brouteName\s*\.\s*(?:get|set|has)\b/);
  });

  it('keeps the discarded source spellings as evidence', () => {
    // The labels are not lost, they are demoted. dq/route-code-aliases.csv is what
    // answers "do two systems disagree about this route's identifier" next time.
    expect(code).toMatch(/routeAliasEvidence/);
    expect(code).toMatch(/route-code-aliases\.csv/);
  });

  it('tells the owner the rule stops at the routes this build emits', () => {
    // The rule cannot reach a route the Routes sheet omits: services/imports.ts
    // upserts by code and never deletes. The build emits 43; the owner counts 44
    // on /routes. A reconciliation that does not say so invites the owner to read
    // "fixed" over a route the import will not touch.
    expect(code).toMatch(/NOT applied to production/i);
    expect(code).toMatch(/misnamedOutsideBuild/);
  });
});

/**
 * The supersede list, which is the thing that failed.
 *
 * build-masters.ts has moved the previous build aside rather than overwriting it
 * since 2026-09-22 — but only credentials.xlsx and managers.json, the two files
 * that incident was about. On 2026-09-23 the builder was re-run at 16:39 and
 * 16:42, 53 minutes after account-master.xlsx and customer-master.xlsx had been
 * imported into production, and both workbooks were overwritten in place. The
 * guard existed and ran; the LIST did not keep up. So the list is what gets
 * pinned, against the writes themselves.
 */
describe('a rebuild cannot destroy the record of what was loaded', () => {
  // Every literal path under golive-data/ the builder names, minus the one that is
  // the dq DIRECTORY rather than a file it writes. Taken from the `const DQ = …`
  // line rather than by matching the string 'dq', so renaming the directory does
  // not silently drop a file from this comparison.
  const dqDir = /const DQ = path\.join\(\s*OUT\s*,\s*'([^']+)'\s*\)/.exec(code)?.[1];
  const artefacts = new Set(
    [...code.matchAll(/path\.join\(\s*OUT\s*,\s*'([^']+)'\s*\)/g)]
      .map((m) => m[1])
      .filter((n) => n !== dqDir)
  );
  const listed = new Set(
    (/const SUPERSEDE_ON_REBUILD = \[([\s\S]*?)\]/.exec(code)?.[1] ?? '')
      .match(/'[^']+'/g)
      ?.map((s) => s.slice(1, -1)) ?? []
  );

  it('reads both halves of the comparison', () => {
    // Without this, an empty match on either side makes the two tests below pass
    // by agreeing about nothing — the fail-open shape CLAUDE.md warns about.
    expect(artefacts.size, 'no path.join(OUT, …) found — did the writes move?').toBeGreaterThan(0);
    expect(
      listed.size,
      'SUPERSEDE_ON_REBUILD is gone or no longer a literal array'
    ).toBeGreaterThan(0);
    expect(dqDir, 'the dq directory is no longer defined as path.join(OUT, …)').toBeTruthy();
  });

  it('supersedes every artefact it writes into golive-data/', () => {
    const missing = [...artefacts].filter((f) => !listed.has(f)).sort();
    expect(
      missing,
      `${missing.join(', ')} is written into golive-data/ but is not in SUPERSEDE_ON_REBUILD, so a rebuild overwrites it. That is exactly how the account-master.xlsx imported into production on 2026-09-23 was lost.`
    ).toEqual([]);
  });

  it('does not list artefacts it no longer writes', () => {
    const stale = [...listed].filter((f) => !artefacts.has(f)).sort();
    expect(
      stale,
      `SUPERSEDE_ON_REBUILD names ${stale.join(', ')}, which the builder no longer writes — a list that has stopped matching the writes is the defect this guard is for, in either direction.`
    ).toEqual([]);
  });

  it('moves the previous build aside BEFORE the first artefact is written', () => {
    // The whole defect in one line: the old loop sat beside the credentials write,
    // 90 lines after account-master.xlsx had already been replaced.
    const callAt = code.search(/\n\s*supersedePreviousBuild\(\);/);
    const firstWriteAt = code.indexOf('acct.xlsx.writeFile');
    expect(callAt, 'nothing calls supersedePreviousBuild()').toBeGreaterThan(-1);
    expect(firstWriteAt, 'the account master is no longer written here').toBeGreaterThan(-1);
    expect(
      callAt,
      'supersedePreviousBuild() runs after the first artefact is written, which preserves nothing'
    ).toBeLessThan(firstWriteAt);
  });

  it('keeps the previous dq/ CSVs without needing a second list', () => {
    // dq/ is deliberately NOT in SUPERSEDE_ON_REBUILD: ~20 CSVs given a stamped
    // sibling on every rebuild would bury golive-data/ (there are already 15
    // superseded credentials.xlsx), and other scripts write their own evidence
    // into dq/, which this builder must not move. writeDq moves only the file it
    // is about to overwrite, into one directory per build — so there is no second
    // list to fall behind.
    const at = code.indexOf('function writeDq(');
    expect(at, 'writeDq is gone').toBeGreaterThan(-1);
    const body = code.slice(at, code.indexOf('\n}', at));
    expect(body).toMatch(/renameSync/);
    expect(body).toMatch(/superseded-/);
    expect(
      listed.has(dqDir ?? 'dq'),
      'dq is a directory; it is handled in writeDq, not by this list'
    ).toBe(false);
  });
});

/**
 * The workbook sitting in golive-data/, when there is one — a staleness check, and
 * NOT evidence about production.
 *
 * What it cannot tell you: routeMasterName() is the identity function and the
 * builder writes `name: routeMasterName(code)`, so against any master the CURRENT
 * builder produced this is true by construction. It passed here on 2026-09-23
 * against a file the same session had just built. It says nothing about the
 * database — the three wrong names live there until account-master.xlsx is
 * re-imported (RECONCILIATION.md item 17) — and it could not cover the whole of
 * production even in principle: the builder emits 43 routes, the owner counts 44,
 * and services/imports.ts leaves a route absent from the sheet exactly as it is.
 *
 * What it still catches: a master built BEFORE the rule existed, left in
 * golive-data/ and waiting for somebody to import it. That is worth a check, and
 * it is the only claim being made here.
 */
describe('the workbook on disk is not a pre-rule build', () => {
  const MASTER = process.env.GOLIVE_DIR
    ? `${process.env.GOLIVE_DIR}/account-master.xlsx`
    : 'golive-data/account-master.xlsx';

  it.runIf(existsSync(MASTER))('every route in it is named by its code', async () => {
    // Imported here rather than at the top: an exceljs load at collection time is
    // the first-run Windows timeout CLAUDE.md records, and this test usually skips.
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(MASTER);
    const ws = wb.getWorksheet('Routes');
    expect(ws, `${MASTER} has no "Routes" sheet`).toBeTruthy();

    const header = (ws!.getRow(1).values as unknown[]).map((h) =>
      typeof h === 'string' ? h.trim().toLowerCase() : ''
    );
    const codeCol = header.indexOf('code');
    const nameCol = header.indexOf('name');
    expect(codeCol, 'Routes sheet has no code column').toBeGreaterThan(0);
    expect(nameCol, 'Routes sheet has no name column').toBeGreaterThan(0);

    const issues: string[] = [];
    let rows = 0;
    ws!.eachRow((row, n) => {
      if (n === 1) return;
      rows++;
      const cell = (i: number) => {
        const v = row.getCell(i).value;
        return v == null ? '' : String(v).trim();
      };
      const issue = routeNameIssue(cell(codeCol), cell(nameCol));
      if (issue) issues.push(issue);
    });
    // Only route codes reach this message. golive-data/ holds customer PII; the
    // Routes sheet is codes, names and region codes, and nothing else is read here.
    expect(issues, issues.join('; ')).toEqual([]);
    expect(rows, 'the Routes sheet is empty, so nothing was checked').toBeGreaterThan(0);
    // The budget is for the READ. The whole go-live workbook loads in a few seconds
    // on its own and took over 10 s under the full suite on Windows — past vitest's
    // 5 s default — so it failed as a flake in two of four full runs on 2026-09-24.
    // A wrong route name still fails at once.
  }, 60_000);
});
