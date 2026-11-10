/**
 * The one door to zod in this app: every schema imports `z` from here, never
 * from 'zod' itself (eslint.config.mjs refuses that import elsewhere), so the
 * settings below are in force before anything is parsed — on the server and in
 * every browser bundle that carries a schema.
 *
 * Why it exists: zod 3.25.76 carried GHSA-mrhx-c7xc-m3w5, and the fix is zod 4.
 * Zod 4 words every default message differently ("Required" became "Invalid
 * input: expected string, received undefined"), and changed when an issue
 * stops the rest of a parse. Most refusals users read are zod's own words, and
 * each service maps zod's issues onto the form by its own rule (the last issue
 * on a key wins; the signed-form upload reads the first). So this module keeps
 * what users see as zod 3 gave it — tests/unit/validation-messages.test.ts holds
 * every form, upload, export and sign-in to a record taken under zod 3.25.76:
 *
 *   - `zod3Message` is zod 3's English error map, fed zod 4's issues. A schema's
 *     own message (`.min(2, '…')`, `{ message }`) still wins over it.
 *   - `legacy` is what zod 3 did with `invalid_type_error` / `required_error`,
 *     which zod 4 dropped.
 *   - `number3`, `coerceNumber3` and `int3`: zod 3's number. It took ±Infinity
 *     (zod 4 refuses it as "not a number", before any bound is checked), and its
 *     `.int()` did not stop the bounds after it (zod 4's does), so "-1.5 coolers"
 *     still reads "cannot be below 0", the last issue, as it did.
 *   - `cuid3`, `uuid3`, `email3` and `DATETIME_OFFSET3`: zod 3's patterns. Zod 4
 *     reads a cuid, a UUID, an e-mail and a capture time with an offset by
 *     different rules (its cuid takes 7 characters and refuses capitals; its
 *     uuid wants an RFC version digit; its offset needs a colon, so "+0400" was
 *     refused).
 *   - `nativeEnum3` / `enum3`: zod 3 told a value of the wrong type ("Expected
 *     'CASH' | 'CREDIT', received number", or "Required") from a value outside
 *     the list ("Invalid enum value. …"); zod 4 raises one issue for both.
 *   - `array3`: zod 3's bounded array, whose count is reported BEFORE its
 *     elements and does not stop them being read (users.ts shows the last issue
 *     under "regionIds"; the signed-form upload reads the first) — up to a
 *     ceiling far past any form; a longer list is refused on its count alone.
 *   - `string3` / `stopUnless3`: zod 3 read no length bound of a value of the
 *     wrong type; zod 4 reads one on anything with a length (an array sent for a
 *     name also got "Array must contain at least 1 element(s)").
 *   - `object3`: zod 3 did not take a Date, Map or Set for an object.
 *   - `{ abort: true }` on a bound a transform follows (lib/validation/fields.ts
 *     strippedStr) and `.prefault` for `.default` (lib/validation/create.ts) are
 *     zod 3's rules too, written where they apply.
 *
 * `jitless`: zod 4 compiles object parsers with `new Function` when it can. The
 * CSP allows no 'unsafe-eval' (next.config.ts), so in the browser the attempt
 * would be refused and reported as a violation; the interpreted path gives the
 * same answers, and the server takes it too, so the tests read what runs.
 */
import { z } from 'zod';

type RawIssue = z.core.$ZodRawIssue;

/** zod 3's name for a value's type (its getParsedType), which its messages print. */
export function parsedType3(v: unknown): string {
  switch (typeof v) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return 'string';
    case 'number':
      return Number.isNaN(v) ? 'nan' : 'number';
    case 'boolean':
      return 'boolean';
    case 'function':
      return 'function';
    case 'bigint':
      return 'bigint';
    case 'symbol':
      return 'symbol';
    case 'object': {
      if (Array.isArray(v)) return 'array';
      if (v === null) return 'null';
      const o = v as { then?: unknown; catch?: unknown };
      if (o.then && typeof o.then === 'function' && o.catch && typeof o.catch === 'function')
        return 'promise';
      if (typeof Map !== 'undefined' && v instanceof Map) return 'map';
      if (typeof Set !== 'undefined' && v instanceof Set) return 'set';
      if (typeof Date !== 'undefined' && v instanceof Date) return 'date';
      return 'object';
    }
    default:
      return 'unknown';
  }
}

/** zod 3's util.joinValues: strings quoted, the rest as they print. */
function joinValues(values: readonly unknown[], separator = ' | '): string {
  return values.map((v) => (typeof v === 'string' ? `'${v}'` : v)).join(separator);
}

/** zod 3's JSON.stringify replacer for a literal (a bigint prints as its digits). */
const jsonReplacer = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/** The zod 4 type names zod 3 printed differently. */
const EXPECTED3: Record<string, string> = { int: 'integer', tuple: 'array', record: 'object' };

/** Enums that are zod 3 nativeEnums (nativeEnum3): a number in the list's type is a value, not a type error. */
const NATIVE_ENUMS = new WeakSet<object>();
/**
 * An enum3's values in the order written. Zod 4 keeps a z.enum as an object, and
 * JavaScript lists integer-like keys first and in numeric order, so ['1', '0']
 * would print as "'0' | '1'"; zod 3 printed them as written.
 */
const ENUM_ORDER = new WeakMap<object, readonly unknown[]>();

/** The values an enum issue names, in zod 3's order. */
function enumValues(iss: RawIssue & Record<string, unknown>): unknown[] {
  return [...(ENUM_ORDER.get(iss.inst as object) ?? (iss.values as unknown[]))];
}

/**
 * The issue zod 3 would have raised: `invalid_type` (the value is not of the
 * type at all) or `invalid_enum_value` for an enum, else zod 4's own code.
 */
function zod3Code(iss: RawIssue): string {
  if (iss.code === 'invalid_value') {
    const inst = iss.inst as { _zod?: { def?: { type?: string } } } | undefined;
    if (inst?._zod?.def?.type === 'enum') {
      const t = parsedType3(iss.input); // NaN is 'nan', not a number, as zod 3 read it
      const ok = NATIVE_ENUMS.has(inst as object)
        ? t === 'string' || t === 'number'
        : t === 'string';
      return ok ? 'invalid_enum_value' : 'invalid_type';
    }
    return 'invalid_literal';
  }
  if (iss.code === 'invalid_format') return 'invalid_string';
  return iss.code ?? 'custom';
}

function sizeMessage(
  kind: 'small' | 'big',
  origin: string,
  bound: number | bigint,
  exact: boolean | undefined,
  inclusive: boolean | undefined
): string {
  const small = kind === 'small';
  switch (origin) {
    case 'array':
      return `Array must contain ${exact ? 'exactly' : inclusive ? (small ? 'at least' : 'at most') : small ? 'more than' : 'less than'} ${bound} element(s)`;
    case 'string':
      return `String must contain ${exact ? 'exactly' : inclusive ? (small ? 'at least' : 'at most') : small ? 'over' : 'under'} ${bound} character(s)`;
    case 'number':
    case 'int':
      return small
        ? `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${bound}`
        : `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${bound}`;
    case 'bigint':
      return small
        ? `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${bound}`
        : `BigInt must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${bound}`;
    case 'date':
      return small
        ? `Date must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${new Date(Number(bound))}`
        : `Date must be ${exact ? 'exactly' : inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(bound))}`;
    default:
      return 'Invalid input';
  }
}

/** zod 3's English default message for a zod 4 issue (zod 3.25.76 locales/en.js). */
export function zod3Message(iss: RawIssue): string {
  const i = iss as RawIssue & Record<string, unknown>;
  switch (zod3Code(iss)) {
    case 'invalid_type': {
      const input = i.input;
      if (input === undefined) return 'Required';
      if (i.expected === 'date' && input instanceof Date) return 'Invalid date';
      const values = i.code === 'invalid_value' ? enumValues(i) : null;
      const expected = values
        ? joinValues(values)
        : (EXPECTED3[String(i.expected)] ?? String(i.expected));
      const received =
        i.expected === 'int' && typeof input === 'number' ? 'float' : parsedType3(input);
      return `Expected ${expected}, received ${received}`;
    }
    case 'invalid_literal':
      return `Invalid literal value, expected ${JSON.stringify((i.values as unknown[])[0], jsonReplacer)}`;
    case 'invalid_enum_value':
      return `Invalid enum value. Expected ${joinValues(enumValues(i))}, received '${String(i.input)}'`;
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${joinValues(i.keys as string[], ', ')}`;
    case 'invalid_union':
      return i.note === 'No matching discriminator' && Array.isArray(i.options)
        ? `Invalid discriminator value. Expected ${joinValues(i.options)}`
        : 'Invalid input';
    case 'invalid_string':
      switch (i.format) {
        case 'regex':
          return 'Invalid';
        case 'starts_with':
          return `Invalid input: must start with "${String(i.prefix)}"`;
        case 'ends_with':
          return `Invalid input: must end with "${String(i.suffix)}"`;
        case 'includes':
          return `Invalid input: must include "${String(i.includes)}"`;
        case 'guid':
          return 'Invalid uuid';
        case 'ipv4':
        case 'ipv6':
          return 'Invalid ip';
        case 'cidrv4':
        case 'cidrv6':
          return 'Invalid cidr';
        default:
          return `Invalid ${String(i.format)}`;
      }
    case 'too_small':
      return sizeMessage(
        'small',
        String(i.origin),
        i.minimum as number,
        i.exact as boolean,
        i.inclusive as boolean
      );
    case 'too_big':
      return sizeMessage(
        'big',
        String(i.origin),
        i.maximum as number,
        i.exact as boolean,
        i.inclusive as boolean
      );
    case 'not_multiple_of':
      return `Number must be a multiple of ${String(i.divisor)}`;
    default:
      return 'Invalid input';
  }
}

z.config({ jitless: true, customError: zod3Message });

export { z };
export type ZodIssue = z.core.$ZodIssue;

/**
 * A check placed first on a schema: a value of the wrong type stops the checks
 * after it. Zod 4 runs a length bound on anything with a length even after the
 * type has failed, so an array sent for a name also read "Array must contain at
 * least 1 element(s)", and the last issue is the one a form shows; zod 3 stopped
 * at the type.
 */
export function stopUnless3(isType: (v: unknown) => boolean): z.core.$ZodCheck<unknown> {
  const ch: z.core.$ZodCheck<unknown> = new z.core.$ZodCheck({ check: 'custom', when: () => true });
  ch._zod.check = (payload) => {
    if (!isType(payload.value)) payload.aborted = true;
  };
  return ch;
}

const isString = (v: unknown) => typeof v === 'string';

/** z.string() whose length bounds, like zod 3's, are not read when the value is not a string (stopUnless3). */
export function string3(params?: string | z.core.$ZodStringParams) {
  return z.string(params).check(stopUnless3(isString));
}

/** zod 3's create params that zod 4 dropped. */
export type Legacy = { invalid_type_error?: string; required_error?: string; message?: string };

/**
 * zod 3's processCreateParams: a type's `message` / `required_error` /
 * `invalid_type_error` replace zod's words for a value that is missing or of the
 * wrong type, and for nothing else (a failed bound keeps zod's own, or its
 * check's). Returns undefined to leave an issue to zod3Message.
 */
export function legacy(params: Legacy): (iss: RawIssue) => string | undefined {
  return (iss) => {
    const code = zod3Code(iss);
    if (code === 'invalid_enum_value') return params.message;
    if (iss.input === undefined) return params.message ?? params.required_error;
    if (code !== 'invalid_type') return undefined;
    return params.message ?? params.invalid_type_error;
  };
}

/**
 * zod 3's z.number(): any number but NaN — ±Infinity included, as zod 3 took it
 * (zod 4's z.number() refuses it before any bound). Its checks go on with
 * `.check(z.gte(…), z.lte(…), int3(…))`. A value of another type stops there.
 */
export function number3(params: Legacy = {}) {
  const ch: z.core.$ZodCheck<unknown> = z.check<unknown>((payload) => {
    const v = payload.value;
    if (typeof v === 'number' && !Number.isNaN(v)) return;
    payload.issues.push({
      code: 'invalid_type',
      expected: 'number',
      input: v,
      inst: ch,
      continue: false,
    });
  });
  // The schema's own map covers its checks too, as zod 3's did (an `.int()` without words of its own).
  return z.custom<number>(() => true, { error: legacy(params) }).check(ch);
}

/** zod 3's z.coerce.number(): Number(value) first (undefined → NaN, refused), then number3. */
export function coerceNumber3(params: Legacy = {}) {
  return z.preprocess((v) => Number(v), number3(params));
}

/**
 * zod 3's `.int()`: Number.isInteger, no safe-integer range, and a failure does
 * not stop the checks after it (zod 3 went on to the bounds; zod 4's stops).
 * Raised as zod 3 raised it: "Expected integer, received float" by default.
 */
export function int3(message?: string) {
  const ch: z.core.$ZodCheck<number> = z.check<number>((payload) => {
    const v = payload.value;
    if (Number.isInteger(v)) return;
    payload.issues.push({
      code: 'invalid_type',
      expected: 'int',
      input: v,
      inst: ch,
      continue: true,
      ...(message !== undefined ? { message } : {}),
    });
  });
  return ch;
}

/** zod 3's cuid pattern (zod 4's takes 7 characters and refuses capitals and symbols after the c). */
export const CUID3 = /^c[^\s-]{8,}$/i;
/** zod 3's uuid pattern: any hex in 8-4-4-4-12 (zod 4's uuid wants an RFC version and variant). */
export const UUID3 =
  /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
/** zod 3's e-mail pattern. */
export const EMAIL3 =
  /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;
/**
 * zod 3's `datetime({ offset: true })`: a real date, hh:mm with optional seconds
 * and fraction, then Z or an offset with or without its colon ("+04:00",
 * "+0400"; "+04" is refused). Zod 4's offset needs the colon.
 */
export const DATETIME_OFFSET3 = new RegExp(
  '^((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))' +
    'T([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?(Z|([+-]\\d{2}:?\\d{2}))$'
);

/** zod 3's `.cuid()`, with its words ("Invalid cuid") unless the field has its own. */
export const cuid3 = (message = 'Invalid cuid') => z.regex(CUID3, message);
/** zod 3's `.uuid()`. */
export const uuid3 = (message = 'Invalid uuid') => z.regex(UUID3, message);
/** zod 3's `.email()`. */
export const email3 = (message = 'Invalid email') => z.regex(EMAIL3, message);

/**
 * zod 3's z.nativeEnum (a Prisma enum): a string or number outside the list is
 * "Invalid enum value. Expected 'A' | 'B', received 'x'"; any other type is
 * "Expected 'A' | 'B', received boolean", or "Required" — and `legacy` params
 * replace only the second kind, as zod 3's did.
 */
export function nativeEnum3<const T extends z.core.util.EnumLike>(entries: T, params: Legacy = {}) {
  const s = z.enum(entries, { error: legacy(params) });
  NATIVE_ENUMS.add(s);
  return s;
}

/**
 * zod 3's z.enum: only a string can be a value outside the list; anything else
 * is a type error. Its messages list the values in the order written (ENUM_ORDER).
 */
export function enum3<const T extends readonly [string, ...string[]]>(
  values: T,
  params: Legacy = {}
) {
  const s = z.enum(values, { error: legacy(params) });
  ENUM_ORDER.set(s, values);
  return s;
}

/**
 * zod 3's object type test, around an object schema: a Date, Map, Set or
 * promise is not an object ("Expected object, received date"). Zod 4's z.object
 * takes any non-array object and reads none of its keys, so a Date sent for
 * `credit` was accepted as an empty one. Used where a server action's argument
 * can carry such a value (the CREATE and UPDATE payloads); JSON and FormData
 * cannot. Typed as a plain schema: the object's own methods stay on `schema`.
 */
export function object3<S extends z.ZodType>(schema: S): z.ZodType<z.output<S>, z.input<S>> {
  return z.preprocess((v, ctx) => {
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && parsedType3(v) !== 'object') {
      ctx.addIssue({ code: 'invalid_type', expected: 'object', input: v, continue: false });
    }
    return v;
  }, schema) as unknown as z.ZodType<z.output<S>, z.input<S>>;
}

type Bound = { value: number; message?: string };

/**
 * The longest list array3 still reads element by element: twenty times its cap,
 * and never under a thousand — far past anything a form here can send (six
 * pages, fifty regions). A longer one is answered on its count alone.
 */
export const array3Ceiling = (cap: number): number => Math.max(1000, 20 * cap);

/**
 * zod 3's `z.array(element).min(…).max(…)`: the count is checked first, and a
 * wrong count does not stop the elements being read — every bad one is
 * reported after it, as zod 3 did. Zod 4 reads the elements first and, from
 * 4.6.6, refuses an oversized array on its count alone; either would change
 * which issue a service shows (users.ts: the last under "regionIds"; the
 * signed-form upload: the first).
 *
 * Up to a ceiling (array3Ceiling), and not past it. A request can carry a list
 * of well over a million ids (a server action's body may be megabytes), and
 * reading every one of them is the work GHSA-mrhx-c7xc-m3w5 is about: it cost
 * seconds of CPU, and from about 125,000 issues zod 4 no longer answers at all —
 * it merges a child's issues with a spread call, which overflows the stack, so
 * the parse THREW a RangeError (a 500) where zod 3 refused. So a list longer
 * than the ceiling raises the count issue alone and none of its elements is
 * given to the element schema, as zod 4's own bounded array and cappedArray
 * (lib/validation/fields.ts, the CREATE and UPDATE payloads) refuse theirs.
 * (The array of unknowns underneath still walks the list once, raising
 * nothing: about 20 ms for the million and a half ids of the largest body,
 * less than reading the request took.) Below the ceiling nothing moves. Above
 * it the signed-form upload still answers with the count's words (it reads the
 * first issue); the users forms show the count's words where zod 3 showed the
 * last bad id's — for a list no form builds. `max` is required: an array3
 * without a cap would have no ceiling.
 * tests/unit/array3-ceiling.test.ts holds the three schemas to it.
 */
export function array3<E extends z.ZodType>(element: E, bounds: { min?: Bound; max: Bound }) {
  const { min, max } = bounds;
  const ceiling = array3Ceiling(max.value);
  const ch: z.core.$ZodCheck<unknown> = z.check<unknown>((payload) => {
    const v = payload.value;
    if (!Array.isArray(v)) return;
    const size = (code: 'too_small' | 'too_big', b: Bound, goOn: boolean) =>
      payload.issues.push({
        code,
        origin: 'array',
        ...(code === 'too_small' ? { minimum: b.value } : { maximum: b.value }),
        inclusive: true,
        exact: false,
        input: v,
        inst: ch,
        continue: goOn,
        ...(b.message !== undefined ? { message: b.message } : {}),
      } as RawIssue);
    if (v.length > ceiling) {
      size('too_big', max, false);
      return;
    }
    if (min && v.length < min.value) size('too_small', min, true);
    if (v.length > max.value) size('too_big', max, true);
    const out: unknown[] = [];
    let failed = false;
    v.forEach((e, i) => {
      const r = element.safeParse(e);
      if (r.success) {
        out.push(r.data);
        return;
      }
      failed = true;
      for (const iss of r.error.issues) {
        // An element of the wrong type stopped zod 3's array; a failed check on one did not.
        const stops =
          iss.code === 'invalid_type' ||
          iss.code === 'invalid_value' ||
          iss.code === 'invalid_union';
        payload.issues.push({ ...iss, path: [i, ...iss.path], continue: !stops } as RawIssue);
      }
    });
    if (!failed) payload.value = out;
  });
  return z.array(z.unknown()).check(ch) as unknown as z.ZodType<z.output<E>[], z.input<E>[]>;
}
