/**
 * The CREDIT new-customer chain as lib/approval-chains.ts froze it before the
 * owner decisions of 2026-10-11 (CHAIN_VERSION 1): Supervisor → Finance Manager
 * → GM → Accountant, four steps.
 *
 * Requests frozen with it are still in flight after the change, and every reader
 * goes through parseChain(row.approvalChain), so they must keep advancing,
 * stepping back and finalizing on their own chain. Tests that pin the token,
 * the cascade and finalize on a credit request use this frozen chain on purpose:
 * it is what such a row carries in its approvalChain column. The current chain
 * (resolveChain) has its own tests (approval-engine.test.ts, signed-form*.test.ts).
 *
 * Built by hand, not from resolveChain, so it cannot follow a later change.
 */
import type { ApprovalStep } from '@/lib/approval-chains';

export const LEGACY_CREDIT_CHAIN: ApprovalStep[] = [
  { role: 'SUPERVISOR', scope: 'SUPERVISOR_OF_SUBMITTER', slaHours: 8 },
  { role: 'FINANCE_MANAGER', scope: 'GLOBAL', slaHours: 16 },
  { role: 'GM', scope: 'GLOBAL', slaHours: 24 },
  { role: 'ACCOUNTANT', scope: 'REGION_OVERLAP', slaHours: 9 },
];
