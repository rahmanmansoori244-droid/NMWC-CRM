/**
 * Auditor recheck 2026-09-27, F16: a customer's sub-channel must belong to its
 * channel. CREATE enforced it (services/creates.ts: the sub-channel exists, is
 * active and belongs to the chosen channel); the UPDATE lane and the import did
 * not, so an edit could pair "Retail" with a HoReCa sub-channel, and an import
 * that moved a customer to another channel left the old channel's sub-channel
 * beside it. Both reports and Temix read the pair.
 *
 * Two entry points, one rule:
 *   - resolveChannelPair: an edit (submit, direct write, approval), inside the
 *     caller's transaction when it has one;
 *   - subChannelClearedByChannelChange: the import's full lane, which already
 *     holds the customer's locked row (owner decision 1, 2026-09-29: a channel
 *     change clears a stored sub-channel of the old channel).
 * Only a CHANGE of the channel or the sub-channel is checked, so a mismatched
 * pair already on file never blocks an unrelated edit.
 */
import type { Prisma } from '@prisma/client';
import { sameEditValue } from './edit-values';

export const SUB_CHANNEL_MISMATCH_MESSAGE = 'Sub-channel does not belong to the chosen channel.';
export const SUB_CHANNEL_INACTIVE_MESSAGE = 'This sub-channel is no longer offered — pick another.';
export const CHANNEL_INACTIVE_MESSAGE = 'This channel is no longer offered — pick another.';

export type ChannelPairDb = Pick<Prisma.TransactionClient, 'channel' | 'subChannel'>;

export type ChannelPairOptions = {
  /**
   * A CHANGED channel must exist and be active. At submit, yes. At approval, no
   * (lead's cut, 2026-09-29): a channel deactivated after submit is not re-checked.
   */
  requireActiveChannel: boolean;
  /**
   * A channel change with no sub-channel in the patch. true (submit): a live
   * sub-channel that does not fit the new channel is cleared, and the caller
   * records that clear as a change of its own. false (approval): the submit
   * already recorded any clear, so a live sub-channel that does not fit is a
   * failure. A request stored before patch v2 recorded no clear, and fails
   * here too; lib/edit-approval.ts channelPairInvalidMessage says why.
   */
  clearMisfitSubChannel: boolean;
};

export type ChannelPairResult =
  /** Neither the channel nor the sub-channel changes: nothing was checked. */
  | { ok: true; changed: false }
  | {
      ok: true;
      changed: true;
      channelId: string | null;
      subChannelId: string | null;
      /** The live sub-channel is cleared because it does not fit the new channel. */
      clearsSubChannel: boolean;
    }
  | { ok: false; field: 'customer.channelId' | 'customer.subChannelId'; message: string };

/**
 * The customer's channel pair after a patch, checked. `proposed` uses the patch
 * contract: a key that is absent (undefined) is kept, null clears it.
 *
 *   (a) a changed channel must exist, and be active when `requireActiveChannel`;
 *   (b) a changed channel with no sub-channel sent keeps the live sub-channel
 *       only if it exists, is active and belongs to the new channel — otherwise
 *       it is cleared (clearMisfitSubChannel) or refused;
 *   (c) a sub-channel that is sent (and not null) must exist, be active and
 *       belong to the effective channel: CREATE's rule.
 * A refusal names the field it belongs to; nothing is written by this function.
 */
export async function resolveChannelPair(
  db: ChannelPairDb,
  live: { channelId: string | null; subChannelId: string | null },
  proposed: { channelId?: string | null; subChannelId?: string | null },
  opts: ChannelPairOptions
): Promise<ChannelPairResult> {
  const channelChanges =
    proposed.channelId !== undefined &&
    !sameEditValue('channelId', proposed.channelId, live.channelId);
  const subSent = proposed.subChannelId !== undefined;
  const subChanges =
    subSent && !sameEditValue('subChannelId', proposed.subChannelId, live.subChannelId);
  if (!channelChanges && !subChanges) return { ok: true, changed: false };

  const channelId = (channelChanges ? proposed.channelId : live.channelId) || null;
  if (channelChanges) {
    const channel = channelId
      ? await db.channel.findUnique({ where: { id: channelId }, select: { isActive: true } })
      : null;
    if (!channel || (opts.requireActiveChannel && !channel.isActive)) {
      return { ok: false, field: 'customer.channelId', message: CHANNEL_INACTIVE_MESSAGE };
    }
  }

  // The sub-channel the pair would carry: the one sent, else the live one.
  const subChannelId = (subSent ? proposed.subChannelId : live.subChannelId) || null;
  if (!subChannelId) {
    return { ok: true, changed: true, channelId, subChannelId: null, clearsSubChannel: false };
  }
  const sub = await db.subChannel.findUnique({
    where: { id: subChannelId },
    select: { channelId: true, isActive: true },
  });
  const fits = !!sub && sub.isActive && !!channelId && sub.channelId === channelId;
  if (fits) return { ok: true, changed: true, channelId, subChannelId, clearsSubChannel: false };

  if (!subSent && opts.clearMisfitSubChannel) {
    return { ok: true, changed: true, channelId, subChannelId: null, clearsSubChannel: true };
  }
  return {
    ok: false,
    field: 'customer.subChannelId',
    message: sub && !sub.isActive ? SUB_CHANNEL_INACTIVE_MESSAGE : SUB_CHANNEL_MISMATCH_MESSAGE,
  };
}

/**
 * The import's full lane: does writing `newChannelId` clear the stored
 * sub-channel? Yes when the channel really changes and the stored sub-channel
 * belongs to another channel (the one being replaced). A sub-channel of the new
 * channel is kept; a blank channel cell writes no channel, so it clears nothing.
 * `stored.subChannelChannelId` is the stored sub-channel's own channelId, read
 * with the customer's locked row.
 */
export function subChannelClearedByChannelChange(
  stored: {
    channelId: string | null;
    subChannelId: string | null;
    subChannelChannelId: string | null;
  },
  newChannelId: string | null | undefined
): boolean {
  if (!newChannelId || newChannelId === stored.channelId) return false;
  if (!stored.subChannelId) return false;
  return stored.subChannelChannelId !== newChannelId;
}
