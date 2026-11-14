/**
 * The daily Temix import, stage 4: what a route-map entry may be (the
 * Steward's form on /temix-daily/routes; services/temix-daily-routes.ts).
 * These are rules about the tool, not about routes: which CRM route a Temix
 * code belongs to is the owner's route master, typed in by the Steward.
 *
 *  - The code is a normalised Temix route code (normalizeTemixCode), 1 to 40
 *    characters (TemixRouteMap_code_check).
 *  - A code that is already exactly a CRM route's code is refused: the Check
 *    matches it exactly before it looks at the map, so the entry would never
 *    be used and would only mislead.
 *  - The CRM route must exist. A switched-off route is accepted (the owner's
 *    master may say so); the Check then holds its moves as "switched off".
 *  - A code with a live entry is refused: retire that entry first.
 *  - A reason is required (3 to 300 characters): where the entry comes from.
 *
 * PURE: no database.
 */
import { normalizeTemixCode } from './temix-code';

export const ROUTE_MAP_CODE_MAX = 40;
export const ROUTE_MAP_REASON_MIN = 3;
export const ROUTE_MAP_REASON_MAX = 300;

export function routeMapReasonRefusal(reason: string): string | null {
  const r = reason.trim();
  if (r.length < ROUTE_MAP_REASON_MIN) return 'Give a reason: where this entry comes from (for example the owner\'s route master of a given date).';
  if (r.length > ROUTE_MAP_REASON_MAX) return `Keep the reason to ${ROUTE_MAP_REASON_MAX} characters.`;
  return null;
}

/** Why an ADD entry is refused, by field, or null when it may be written. */
export function routeMapEntryRefusal(args: {
  code: string;
  routeId: string;
  routes: ReadonlyArray<{ id: string; code: string }>;
  hasLiveEntry: boolean;
}): Record<string, string> | null {
  const { code, routeId, routes, hasLiveEntry } = args;
  if (!code) return { code: 'Type the Temix route code.' };
  if (code !== normalizeTemixCode(code)) return { code: 'The code is not normalised.' };
  if (code.length > ROUTE_MAP_CODE_MAX) return { code: `A route code here is at most ${ROUTE_MAP_CODE_MAX} characters.` };
  const exact = routes.find((r) => normalizeTemixCode(r.code) === code);
  if (exact) return { code: `${code} is already a CRM route's code: it is matched exactly, and needs no entry.` };
  if (!routeId || !routes.some((r) => r.id === routeId)) return { routeId: 'Pick the CRM route this code belongs to.' };
  if (hasLiveEntry) return { code: `${code} already has an entry. Retire it first, then add the new one.` };
  return null;
}
