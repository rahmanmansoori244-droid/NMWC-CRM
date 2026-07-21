import type { Role } from '@prisma/client';

/**
 * Role → landing page. Single source shared by `/` and `/home` so entering the
 * app is ONE redirect, not a `/` → `/home` → target chain (perf audit #20 —
 * each extra hop was a full Oman round trip).
 */
export const HOME_BY_ROLE: Record<Role, string> = {
  SALESMAN: '/today',
  SUPERVISOR: '/approvals',
  MANAGER: '/dashboard',
  STEWARD: '/import',
  VIEWER: '/dashboard',
  // Approval roles: land on Customers for now (safe for any scope); the
  // pendingRole-routed approvals queue is wired in the engine increment.
  ACCOUNTANT: '/customers',
  FINANCE_MANAGER: '/customers',
  GM: '/customers',
};

export function homeForRole(role: Role): string {
  return HOME_BY_ROLE[role] ?? '/customers';
}
