/**
 * NMWC customer code generator.
 * Format: NMWC-YYYY-NNNNNN  (yearly counter, zero-padded to 6 digits).
 * Caller is responsible for atomicity — wrap in a transaction with a counter
 * row, or use sequence-style INSERT ... RETURNING.
 *
 * For now we expose a helper that takes the next sequence number.
 */
export function formatCustomerCode(year: number, seq: number): string {
  return `NMWC-${year}-${String(seq).padStart(6, '0')}`;
}

/**
 * Branch code: <PARENT>-<NN>
 */
export function formatBranchCode(parentCode: string, branchNum: number): string {
  return `${parentCode}-${String(branchNum).padStart(2, '0')}`;
}
