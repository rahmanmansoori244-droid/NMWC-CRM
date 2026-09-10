/**
 * RK-3 test support: promote a batch to completion.
 *
 * promoteCustomerBatchAction only promotes as much as fits in one time slice, so a
 * test that calls it once may leave the batch half-loaded (and would then race the
 * batch size rather than assert behaviour). Every test that wants "the batch is
 * loaded" should drive the slices through this helper.
 */
type Imports = typeof import('@/services/imports');

export type PromotedTotals = {
  promoted: number;
  failed: number;
  slices: number;
};

export async function promoteFully(
  imports: Imports,
  batchId: string,
  maxSlices = 200
): Promise<PromotedTotals> {
  let promoted = 0;
  let failed = 0;
  let slices = 0;
  // Every slice must leave strictly fewer rows outstanding than it found.
  let lastRemaining = Number.POSITIVE_INFINITY;
  // Continuation token — the run must pass it back to keep the batch it holds.
  let token = '';
  for (;;) {
    const fd = new FormData();
    fd.set('batchId', batchId);
    if (token) fd.set('leaseToken', token);
    const res = await imports.promoteCustomerBatchAction(fd);
    if (!res.ok) throw new Error(`promote slice ${slices + 1} failed: ${JSON.stringify(res)}`);
    slices++;
    promoted += res.data.promoted;
    failed += res.data.failed;
    if (res.data.done) return { promoted, failed, slices };
    token = res.data.leaseToken ?? '';
    if (!token) throw new Error('promote lost the batch lease mid-run');
    // A slice that moved nothing would loop forever — fail loudly instead.
    if (res.data.remaining >= lastRemaining) {
      throw new Error(`promote stalled with ${res.data.remaining} rows remaining`);
    }
    lastRemaining = res.data.remaining;
    if (slices >= maxSlices) throw new Error(`promote exceeded ${maxSlices} slices`);
  }
}
