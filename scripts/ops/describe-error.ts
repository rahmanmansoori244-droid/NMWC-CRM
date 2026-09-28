/**
 * N08 (auditor recheck, 2026-09-27): what an operator script may print about an
 * error it did not raise itself.
 *
 * scripts/ops/restore-verify.ts runs in the restore drill and in CI, and its
 * console output and --json file land in a PUBLIC repository's job log and
 * artifact. The message of an error the database raised can quote a row: Prisma
 * carries the server's DETAIL in the text ("Failing row contains (…)",
 * "Key (col)=(value) already exists"). So such an error is described by its
 * class name and its codes — the SQLSTATE, Prisma's own — and its message stays
 * on the runner, unread.
 *
 * Every piece is shape-checked, so a field that is not what it claims to be is
 * left out rather than printed.
 */
export function describeError(err: unknown): string {
  const e = (err ?? {}) as { name?: unknown; code?: unknown; meta?: { code?: unknown }; message?: unknown };
  const name = typeof e.name === 'string' && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'Error';
  const codes = [e.code, e.meta?.code].filter(
    (c): c is string => typeof c === 'string' && /^[0-9A-Z_]{1,32}$/.test(c)
  );
  // Prisma's raw-query error spells the SQLSTATE into its text, as Code: followed
  // by the five characters in backticks, ahead of the message it quotes.
  const quoted = typeof e.message === 'string' ? /Code: `([0-9A-Z]{5})`/.exec(e.message)?.[1] : undefined;
  if (quoted && !codes.includes(quoted)) codes.push(quoted);
  return codes.length ? `${name} ${codes.join(' ')}` : name;
}
