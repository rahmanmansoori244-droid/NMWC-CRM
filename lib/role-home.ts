import type { Route } from 'next';
import type { Role } from '@prisma/client';

/**
 * Role → landing page. Single source shared by `/` and `/home` so entering the
 * app is ONE redirect, not a `/` → `/home` → target chain (perf audit #20 —
 * each extra hop was a full Oman round trip).
 *
 * Typed as `Route`, not `string`, so each landing page is checked against the
 * app's real routes: a typo here would redirect a whole role to a 404.
 */
export const HOME_BY_ROLE: Record<Role, Route> = {
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

export function homeForRole(role: Role): Route {
  return HOME_BY_ROLE[role] ?? '/customers';
}
