/**
 * The attach refusal for a photo that is already on a slot, shared by the
 * server that says it (services/photos.ts) and the photo slot that reads it.
 * The slot sends an attach again when the first one got no answer; if that one
 * landed after all, this refusal is how the slot learns it (item 22 review).
 * Reworded on one side only, the slot would show a photo it had attached as a
 * failure, and on the edit form a required photo would still count as missing.
 */
export const ALREADY_ATTACHED_MESSAGE = 'Attachment already wired to a slot.';
