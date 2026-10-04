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
  // Approval roles land on their own step of the queue. app/(app)/approvals/page.tsx
  // admits all three (APPROVER_ROLES) and filters on `pendingRole` = the viewer's
  // role — ACCOUNTANT also by region overlap, fail-closed on no regions — so the
  // first screen is the work waiting for them, not a customer search they had to
  // leave through the menu. The page must keep admitting them: it sends a role it
  // refuses to /home, and /home sends it straight back here —
  // tests/unit/role-home.test.tsx renders the page as each of them.
  ACCOUNTANT: '/approvals',
  FINANCE_MANAGER: '/approvals',
  GM: '/approvals',
};

export function homeForRole(role: Role): Route {
  return HOME_BY_ROLE[role] ?? '/customers';
}
