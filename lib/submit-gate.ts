/**
 * Which fields a SALESMAN must fill before an enrichment edit can be SUBMITTED
 * (drafts are always allowed). Shared by the server gate (services/edits.ts —
 * submit AND the EL-04 approve-time re-check) and the client mirror
 * (EnrichmentForm), so the two can never disagree.
 *
 *   CORE (default — owner decision 2026-09-10 for the go-live): channel,
 *        phone, contact person, address, GPS, shop photo. Sub-channel, CR
 *        number/photo, day of visit and signboard stay on the form and in the
 *        completeness score but do not block submit — most imported customers
 *        are individuals / home-delivery addresses that have no CR and no
 *        signboard at all, so the FULL rule could never be satisfied for them.
 *   FULL (PRD §6, the enrichment-campaign rule): also sub-channel, CR number
 *        (CASH), CR photo, day of visit, signboard photo.
 *
 * Set SALESMAN_SUBMIT_GATE=FULL in the environment to switch; no code change.
 */
export type SubmitGate = 'FULL' | 'CORE';

export function salesmanSubmitGate(): SubmitGate {
  return process.env.SALESMAN_SUBMIT_GATE === 'FULL' ? 'FULL' : 'CORE';
}

/** Checks skipped under the CORE gate (keys match collectMissingMandatory / the form). */
export const CORE_OPTIONAL: ReadonlySet<string> = new Set([
  'subChannelId',
  'crNumber',
  'crPhoto',
  'dayOfVisit',
  'signboardPhoto',
]);

export function isRequired(field: string, gate: SubmitGate): boolean {
  return gate === 'FULL' || !CORE_OPTIONAL.has(field);
}
