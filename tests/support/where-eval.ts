/**
 * Evaluates a flat Prisma `where` against a plain row, for unit fakes of a paged
 * query (benchmark item 28). The fake must read the predicate WHOLE: one that
 * picked out the two fields it expected passed a page predicate that loops forever
 * in production (the post-merge review of 3e775d4). Anything it does not model
 * throws, so a new predicate shape fails the test instead of matching everything.
 */
type Where = Record<string, unknown>;

export function matchesWhere(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Where[]).every((w) => matchesWhere(row, w));
    if (key === 'OR') return (cond as Where[]).some((w) => matchesWhere(row, w));
    if (!(key in row)) throw new Error(`where-eval: the row has no field "${key}"`);
    const value = row[key] as string | number;
    if (cond === null || typeof cond !== 'object') return value === cond;
    return Object.entries(cond as Record<string, unknown>).every(([op, arg]) => {
      const x = arg as string | number;
      switch (op) {
        case 'equals':
          return value === x;
        case 'gt':
          return value > x;
        case 'gte':
          return value >= x;
        case 'lt':
          return value < x;
        case 'lte':
          return value <= x;
        case 'in':
          return (arg as unknown[]).includes(value);
        default:
          throw new Error(`where-eval: operator "${op}" is not modelled`);
      }
    });
  });
}
