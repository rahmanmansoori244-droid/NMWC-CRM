/**
 * Completeness of a new-customer request, from its drafts: the score the
 * customer and its branches get when the request is finalized
 * (lib/create-finalize.ts), and — launch fix — the ring on its approval-queue
 * card, which showed 0% for every new customer because the request has no
 * customer row to read a score from.
 */
import { CustomerStatus, type EditBranchDraft, type EditCustomerDraft } from '@prisma/client';
import { scoreBranch, scoreCustomer } from './completeness';

export type CustomerDraftForScore = Pick<
  EditCustomerDraft,
  | 'channelId'
  | 'subChannelId'
  | 'primaryPhone'
  | 'contactPerson'
  | 'crNumber'
  | 'crPhotoAttachmentId'
  | 'paymentTerms'
  | 'notes'
>;
export type BranchDraftForScore = Pick<
  EditBranchDraft,
  | 'gpsLat'
  | 'gpsLng'
  | 'address'
  | 'shopPhotoAttachmentId'
  | 'signboardPhotoAttachmentId'
  | 'dayOfVisit'
  | 'coolersCount'
  | 'standsCount'
  | 'emptyBottlesCount'
  | 'openingHours'
  | 'deliveryWindow'
>;

export function draftScores(
  draft: CustomerDraftForScore,
  branchDrafts: readonly BranchDraftForScore[]
): { customer: number; branches: number[] } {
  const shapes = branchDrafts.map((b) => ({
    gpsLat: b.gpsLat,
    gpsLng: b.gpsLng,
    address: b.address,
    shopPhotoId: b.shopPhotoAttachmentId,
    signboardPhotoId: b.signboardPhotoAttachmentId,
    dayOfVisit: b.dayOfVisit,
    coolersCount: b.coolersCount,
    standsCount: b.standsCount,
    emptyBottlesCount: b.emptyBottlesCount,
    // F21: CREATE captures no "counted" flag (left out on purpose), so a new
    // branch keeps the >0 rule and earns the point on its first edit.
    equipmentConfirmed: false,
    openingHours: b.openingHours,
    deliveryWindow: b.deliveryWindow,
    // A new branch is created ACTIVE.
    status: CustomerStatus.ACTIVE,
  }));
  return {
    customer: scoreCustomer(
      {
        channelId: draft.channelId,
        subChannelId: draft.subChannelId,
        primaryPhone: draft.primaryPhone,
        contactPerson: draft.contactPerson,
        crNumber: draft.crNumber,
        crPhotoId: draft.crPhotoAttachmentId,
        paymentTerms: draft.paymentTerms,
        notes: draft.notes,
      },
      shapes
    ),
    branches: shapes.map(scoreBranch),
  };
}
