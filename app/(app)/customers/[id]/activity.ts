/**
 * Launch fix: one line of the customer's Recent activity. Every row read
 * "<name> submitted N change(s)": a customer created by the approval chain read
 * "submitted 0 change(s)" — its request carries only GPS markers in
 * fieldChanges, its payload is in the drafts — and a close or reactivation
 * request was counted as a field change. Drafts are no longer listed at all
 * (the page's query): they were never sent.
 */
import { countFieldChanges } from '@/lib/gps-manual';

export function activityLine(e: {
  process: string;
  target: string;
  isReactivation: boolean;
  fieldChanges: unknown;
  submittedBy: { fullName: string };
}): string {
  const who = e.submittedBy.fullName;
  if (e.process === 'CREATE') return `${who} requested this new customer`;
  if (e.target === 'BRANCH') {
    return e.isReactivation ? `${who} asked to reactivate a branch` : `${who} asked to mark a branch closed`;
  }
  return `${who} submitted ${countFieldChanges(e.fieldChanges)} change(s)`;
}
