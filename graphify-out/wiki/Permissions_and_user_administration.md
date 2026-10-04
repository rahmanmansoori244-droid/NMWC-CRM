# Permissions and user administration

> 58 nodes · cohesion 0.06

## Key Concepts

- **permissions.ts** (50 connections) — `lib/permissions.ts`
- **users.ts** (43 connections) — `services/users.ts`
- **user-admin-authz.test.ts** (18 connections) — `tests/unit/user-admin-authz.test.ts`
- **B2/SEC-02 Regional Manager could mint an org-wide VIEWER** (10 connections) — `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`
- **CreateUserForm.tsx** (10 connections) — `app/(app)/users/CreateUserForm.tsx`
- **[0] P1 SR-USR-01 allowlist removed every path to create ACCOUNTANT/FM/GM** (9 connections) — `qa/findings/final-golive-hunt.md`
- **canApproveSpecificEdit()** (9 connections) — `lib/permissions.ts`
- **createUserCore()** (9 connections) — `services/users.ts`
- **#1 P1 Manager can create, take over or disable credit approvers (FM/GM/Accountant)** (8 connections) — `qa/findings/pre-launch-deep-review.md`
- **resetPasswordCore()** (8 connections) — `services/users.ts`
- **canMutateUser()** (7 connections) — `lib/permissions.ts`
- **managerCanAdministerUser()** (7 connections) — `lib/permissions.ts`
- **assertManagerScopeOverTarget()** (7 connections) — `services/users.ts`
- **requireUserAdmin()** (7 connections) — `services/users.ts`
- **updateUserRoleCore()** (7 connections) — `services/users.ts`
- **managerCanAssignSupervisor()** (6 connections) — `lib/permissions.ts`
- **toggleUserActiveCore()** (6 connections) — `services/users.ts`
- **permissions.test.ts** (6 connections) — `tests/unit/permissions.test.ts`
- **MANAGER_ADMINISTRABLE_ROLES** (5 connections) — `lib/permissions.ts`
- **managerCanAssignRoute()** (5 connections) — `lib/permissions.ts`
- **[P3] Account re-import silently unlinks supervisor/route on blank column** (4 connections) — `qa/findings/deep-scan-round2.md`
- **Regression critic: ownedRoute disconnected when sheet role mismatches without change_role** (4 connections) — `qa/findings/final-golive-hunt.md`
- **UserRegionFootprint** (4 connections) — `lib/permissions.ts`
- **userRegionIds()** (4 connections) — `lib/permissions.ts`
- **requireUserAdmin (Manager or Steward) restores approver provisioning** (4 connections) — `qa/reports/FINAL-GOLIVE-VERDICT.md`
- *... and 33 more nodes in this community*

## Relationships

- [[Audit log writing]] (14 shared connections)
- [[Approval chains and detail page]] (7 shared connections)
- [[Users page and password forms]] (7 shared connections)
- [[errors area]] (6 shared connections)
- [[session area]] (6 shared connections)
- [[Final pre-go-live adversarial bug hunt ( area]] (5 shared connections)
- [[Access scope and submit gate]] (4 shared connections)
- [[runAction area]] (4 shared connections)
- [[page area]] (3 shared connections)
- [[Photo upload and R2]] (3 shared connections)
- [[Edit submit and approval engine]] (3 shared connections)
- [[Auth and page scope loading]] (2 shared connections)

## Source Files

- `app/(app)/users/CreateUserForm.tsx`
- `docs/import-templates/README.md`
- `lib/approval-chains.ts`
- `lib/permissions.ts`
- `qa/findings/deep-scan-round2.md`
- `qa/findings/final-golive-hunt.md`
- `qa/findings/pre-launch-deep-review.md`
- `qa/reports/ENTERPRISE-READINESS-ASSESSMENT.md`
- `qa/reports/FINAL-GOLIVE-VERDICT.md`
- `services/users.ts`
- `tests/unit/permissions.test.ts`
- `tests/unit/user-admin-authz.test.ts`

## Audit Trail

- EXTRACTED: 299 (97%)
- INFERRED: 10 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*