/**
 * F2 — the dashboard's window and its time buckets, in Oman calendar days.
 *
 * Timestamps are stored as UTC in `timestamp(3)` columns. The business runs in
 * Oman (UTC+4, no daylight saving: lib/tz.ts), so an Oman day D runs from
 * D 00:00 Oman = (D-1) 20:00 UTC to the next Oman midnight. The SQL buckets a
 * timestamp as date_trunc(<grain>, col + interval '4 hours'); every key here is
 * the Oman date that bucket starts on, as 'YYYY-MM-DD'.
 *
 * Weeks start on MONDAY because Postgres date_trunc('week') does (ISO 8601).
 * bucketStart() reproduces that exactly, and the integration suite runs the SQL
 * against it on the boundary instants.
 *
 * Pure: the caller passes `now`, read once per request.
 */
import { omanDateISO } from '../tz';
import {
  DAY_MAX_DAYS,
  DEFAULT_PRESET,
  EARLIEST_DAY,
  MAX_WINDOW_DAYS,
  OMAN_OFFSET_HOURS,
  PERIOD_PRESETS,
  WEEK_MAX_DAYS,
  type PresetKey,
} from './policy';

export type Grain = 'day' | 'week' | 'month';
export type PeriodKey = PresetKey | 'custom';

export type InsightPeriod = {
  key: PeriodKey;
  /** First Oman day in the window, inclusive. */
  fromDay: string;
  /** Last Oman day in the window, inclusive. */
  toDay: string;
  days: number;
  /** UTC instant of Oman 00:00 on fromDay (inclusive). */
  from: Date;
  /** UTC instant of Oman 00:00 on the day after toDay (exclusive). */
  to: Date;
  /**
   * The comparison window: it starts `days` Oman days before `from` and runs for
   * exactly as long as this window has run so far — so a preset that ends today,
   * read at 08:00, is compared with the same days before up to 08:00, never with
   * full days (a like-for-like comparison). A window that has ended is compared
   * with the whole `days` before it, and then prevTo = from.
   */
  prevFromDay: string;
  /** The last Oman day the comparison window touches (always fromDay − 1). */
  prevToDay: string;
  prevFrom: Date;
  /** Exclusive end of the comparison window. */
  prevTo: Date;
  /** The window's last day is still under way (it ends today and today is not over): its bucket is partial. */
  running: boolean;
  grain: Grain;
  /** Every bucket key in the window, in order: the gap-fill. */
  buckets: string[];
  /** Set when the request was adjusted (invalid, reversed, too long, in the future). */
  note: string | null;
};

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_DAY = 86_400_000;
const OFFSET_MS = OMAN_OFFSET_HOURS * 3_600_000;

/** A real calendar date 'YYYY-MM-DD', or null. */
export function parseDay(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = DAY_RE.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function dayToUtcMidnight(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function utcMidnightToDay(t: number): string {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function addDays(day: string, n: number): string {
  return utcMidnightToDay(dayToUtcMidnight(day) + n * MS_DAY);
}

/** Days from a to b, both inclusive (a <= b gives >= 1). */
export function daysInclusive(a: string, b: string): number {
  return Math.round((dayToUtcMidnight(b) - dayToUtcMidnight(a)) / MS_DAY) + 1;
}

/** The UTC instant at which Oman day `day` begins. */
export function omanMidnightUtc(day: string): Date {
  return new Date(dayToUtcMidnight(day) - OFFSET_MS);
}

export function grainFor(days: number): Grain {
  if (days <= DAY_MAX_DAYS) return 'day';
  if (days <= WEEK_MAX_DAYS) return 'week';
  return 'month';
}

/**
 * The key of the bucket an Oman day falls in: the day itself, the MONDAY that
 * starts its ISO week (Postgres date_trunc('week')), or the first of its month.
 */
export function bucketStart(day: string, grain: Grain): string {
  if (grain === 'day') return day;
  if (grain === 'month') return `${day.slice(0, 7)}-01`;
  const dow = new Date(dayToUtcMidnight(day)).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

/** The bucket key of an instant, in Oman time. */
export function bucketOf(at: Date, grain: Grain): string {
  return bucketStart(omanDateISO(at), grain);
}

function nextBucket(key: string, grain: Grain): string {
  if (grain === 'day') return addDays(key, 1);
  if (grain === 'week') return addDays(key, 7);
  const [y, m] = key.split('-').map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

/** Every bucket from the one holding fromDay to the one holding toDay. */
export function bucketKeys(fromDay: string, toDay: string, grain: Grain): string[] {
  const out: string[] = [];
  const last = bucketStart(toDay, grain);
  for (let k = bucketStart(fromDay, grain); k <= last; k = nextBucket(k, grain)) out.push(k);
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "5 Oct" for a day or a week (its Monday), "Oct 2026" for a month. */
export function bucketLabel(key: string, grain: Grain): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  if (grain === 'month') return `${MONTHS[m - 1]} ${y}`;
  return `${d} ${MONTHS[m - 1]}`;
}

/** "5 Oct 2026" — an Oman day as people read it. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * Whether a bucket holds less than its full span: the first or last week or month
 * may hold days outside the window, and its bar then counts only the days inside;
 * and the bucket holding today, while today is under way, has only counted part of
 * today — at any grain, a day included — so its bar is not read as a dip.
 */
export function isPartialBucket(
  key: string,
  period: Pick<InsightPeriod, 'fromDay' | 'toDay' | 'grain'> & { running?: boolean }
): boolean {
  const end = addDays(nextBucket(key, period.grain), -1);
  if (period.running && key <= period.toDay && end >= period.toDay) return true;
  if (period.grain === 'day') return false;
  return key < period.fromDay || end > period.toDay;
}

/** As Next hands them over: a key given twice arrives as an array. */
export type PeriodParams = { period?: string | string[]; from?: string | string[]; to?: string | string[] };

/** The first value of a query key, or undefined. */
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function build(key: PeriodKey, fromDay: string, toDay: string, note: string | null, now: Date): InsightPeriod {
  const days = daysInclusive(fromDay, toDay);
  const grain = grainFor(days);
  const prevToDay = addDays(fromDay, -1);
  const prevFromDay = addDays(fromDay, -days);
  const from = omanMidnightUtc(fromDay);
  const to = omanMidnightUtc(addDays(toDay, 1));
  const prevFrom = omanMidnightUtc(prevFromDay);
  // How long this window has run: up to now while it is under way, all of it after.
  const elapsed = Math.max(0, Math.min(now.getTime(), to.getTime()) - from.getTime());
  return {
    key,
    fromDay,
    toDay,
    days,
    from,
    to,
    prevFromDay,
    prevToDay,
    prevFrom,
    prevTo: new Date(prevFrom.getTime() + elapsed),
    running: now.getTime() < to.getTime(),
    grain,
    buckets: bucketKeys(fromDay, toDay, grain),
    note,
  };
}

/** A preset key the table itself defines — never one every object inherits ("toString", "__proto__"). */
function isPresetKey(raw: string): raw is PresetKey {
  return Object.hasOwn(PERIOD_PRESETS, raw);
}

/**
 * The window a request asks for. Presets end today (Oman). A custom window is
 * read as Oman days, inclusive at both ends; reversed ends are swapped, a window
 * reaching into the future ends today, one longer than MAX_WINDOW_DAYS keeps its
 * last MAX_WINDOW_DAYS days, and anything unreadable — an unknown preset, dates
 * that are not dates, a window wholly before EARLIEST_DAY — falls back to the
 * default preset. Each adjustment says so in `note`.
 */
export function parsePeriod(sp: PeriodParams, now: Date): InsightPeriod {
  const today = omanDateISO(now);
  const raw = (first(sp.period) ?? '').trim();
  const fromRaw = first(sp.from);
  const toRaw = first(sp.to);
  if (raw === 'custom' || (!raw && (fromRaw || toRaw))) {
    let from = parseDay(fromRaw);
    let to = parseDay(toRaw);
    if (!from || !to) {
      return preset(DEFAULT_PRESET, today, 'The custom dates could not be read; showing the default period.', now);
    }
    const notes: string[] = [];
    if (from > to) [from, to] = [to, from];
    if (to < EARLIEST_DAY) {
      // Clamping only the start would leave it after the end: a reversed window.
      return preset(
        DEFAULT_PRESET,
        today,
        `The custom period ends before ${dayLabel(EARLIEST_DAY)}, the earliest day the dashboard reads; showing the default period.`,
        now
      );
    }
    if (to > today) {
      to = today;
      notes.push('ends today');
    }
    if (from > today) from = today;
    if (from < EARLIEST_DAY) {
      from = EARLIEST_DAY;
      notes.push(`starts no earlier than ${dayLabel(EARLIEST_DAY)}`);
    }
    if (daysInclusive(from, to) > MAX_WINDOW_DAYS) {
      from = addDays(to, -(MAX_WINDOW_DAYS - 1));
      notes.push(`is limited to ${MAX_WINDOW_DAYS} days`);
    }
    return build('custom', from, to, notes.length ? `The period ${notes.join(' and ')}.` : null, now);
  }
  if (raw && isPresetKey(raw)) return preset(raw, today, null, now);
  return preset(DEFAULT_PRESET, today, raw ? 'Unknown period; showing the default.' : null, now);
}

function preset(key: PresetKey, today: string, note: string | null, now: Date): InsightPeriod {
  const days = PERIOD_PRESETS[key].days;
  return build(key, addDays(today, -(days - 1)), today, note, now);
}
