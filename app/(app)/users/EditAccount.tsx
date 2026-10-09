'use client';

import { createContext, useContext, useEffect, useState, useTransition } from 'react';
import { Role } from '@prisma/client';
import { updateUserAccountAction } from '@/services/users';
import {
  REGION_SCOPED_ROLES,
  ROLE_LABELS,
  SUPERVISED_ROLES,
  routeSignInName,
  supervisorCoverIssue,
  type SupervisorCandidate,
} from '@/lib/account-edit';
import { AnnounceContext } from './announce';

/**
 * Owner decision 8 (2026-10-07): the Data Steward's "Edit account" on /users.
 *
 * One dialog for the whole table: the options (routes, supervisors, regions) are
 * sent to the browser once, not once per row, and each row's Edit button carries
 * only that account's own values. The stored phone number and e-mail address are
 * never sent — the row says whether one is on file (RBAC-05-023, as the row's
 * e-mail edit does). The e-mail is edited here for every role; the row's own
 * "Change e-mail" button stays for the roles that are e-mailed work.
 *
 * The dialog offers what the server would accept (lib/account-edit.ts): routes
 * that are free or held by a disabled account (the leaver, whose route is handed
 * over), and supervisors who cover the chosen route's region. The action
 * (services/users.ts updateUserAccountAction) decides; its refusals land on the
 * field they are about.
 */

export type EditableRow = {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  ownedRouteId: string | null;
  /** The owned route's code, to tell whether he signs in with it. */
  routeCode: string | null;
  supervisorId: string | null;
  /**
   * Who that is, so the dialog can show him when he is not among the active
   * supervisors it offers (disabled since, or no longer a Supervisor or Manager).
   */
  supervisor?: { fullName: string; username: string; isActive: boolean } | null;
  regionIds: string[];
  hasPhone: boolean;
  /** Whether an e-mail address is on file; the address itself never reaches the page. */
  hasEmail?: boolean;
};

export type EditOptions = {
  routes: {
    id: string;
    code: string;
    name: string;
    regionId: string;
    isActive: boolean;
    holder: { id: string; fullName: string; username: string; isActive: boolean } | null;
  }[];
  /** Active Supervisors and Managers. */
  supervisors: (SupervisorCandidate & { fullName: string; username: string })[];
  regions: { id: string; code: string; name: string; isActive: boolean }[];
};

const EditorContext = createContext<((row: EditableRow) => void) | null>(null);

const FIELD_WORDS: Record<string, string> = {
  role: 'role',
  username: 'sign-in name',
  route: 'route',
  supervisor: 'supervisor',
  regions: 'regions',
  phone: 'phone',
  email: 'e-mail',
};

export function AccountEditor({
  options,
  children,
}: {
  options: EditOptions;
  children: React.ReactNode;
}) {
  const [row, setRow] = useState<EditableRow | null>(null);
  return (
    <EditorContext.Provider value={setRow}>
      {children}
      {row && (
        <EditAccountDialog key={row.id} row={row} options={options} onClose={() => setRow(null)} />
      )}
    </EditorContext.Provider>
  );
}

export function EditAccountButton({ account }: { account: EditableRow }) {
  const open = useContext(EditorContext);
  if (!open) return null;
  // whitespace-nowrap: one line, as the row's other actions (UserRowActions.tsx).
  return (
    <button
      type="button"
      onClick={() => open(account)}
      className="whitespace-nowrap rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
    >
      Edit
    </button>
  );
}

function EditAccountDialog({
  row,
  options,
  onClose,
}: {
  row: EditableRow;
  options: EditOptions;
  onClose: () => void;
}) {
  const announce = useContext(AnnounceContext);
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [role, setRole] = useState<Role>(row.role);
  const [routeId, setRouteId] = useState(row.ownedRouteId ?? '');
  const [supervisorId, setSupervisorId] = useState(row.supervisorId ?? '');
  const [regionIds, setRegionIds] = useState<string[]>(row.regionIds);
  // Ticked when he signs in with his route's code today, the go-live rule.
  const [routeSignIn, setRouteSignIn] = useState(
    row.routeCode !== null && row.username === routeSignInName(row.routeCode)
  );
  // Offered once the action has said he has new-customer requests the change
  // would strand (services/users.ts strandedCreatesIssue).
  const [askWithdraw, setAskWithdraw] = useState(false);
  const [withdrawCreates, setWithdrawCreates] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isSalesman = role === Role.SALESMAN;
  const route = isSalesman ? (options.routes.find((r) => r.id === routeId) ?? null) : null;
  const routeOptions = options.routes.filter(
    (r) => r.id === row.ownedRouteId || (r.isActive && (!r.holder || !r.holder.isActive))
  );
  const supervisorOptions = options.supervisors.filter(
    (s) =>
      s.id !== row.id &&
      (s.id === row.supervisorId ||
        supervisorCoverIssue({
          supervisor: s,
          targetId: row.id,
          routeRegionId: route?.regionId ?? null,
        }) === null)
  );
  // His current supervisor, when the list of active supervisors leaves him out:
  // shown for what he is, so the select does not read "—" while the server keeps him.
  const unlistedSupervisor =
    row.supervisorId &&
    row.supervisor &&
    !options.supervisors.some((s) => s.id === row.supervisorId)
      ? row.supervisor
      : null;
  const regionOptions = options.regions.filter((g) => g.isActive || row.regionIds.includes(g.id));
  const newSignIn =
    route && routeSignInName(route.code) !== row.username ? routeSignInName(route.code) : null;
  const handoverFrom = route && route.holder && route.holder.id !== row.id ? route.holder : null;
  // The leaver's sign-in name is retired only when this account takes it.
  const retiresName =
    !!handoverFrom && routeSignIn && newSignIn !== null && newSignIn === handoverFrom.username;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    const form = new FormData(e.currentTarget);
    const fd = new FormData();
    fd.set('userId', row.id);
    fd.set('role', role);
    if (isSalesman) fd.set('ownedRouteId', routeId);
    if (SUPERVISED_ROLES.includes(role)) fd.set('supervisorId', supervisorId);
    if (REGION_SCOPED_ROLES.includes(role)) for (const id of regionIds) fd.append('regionId', id);
    fd.set('phone', String(form.get('phone') ?? ''));
    if (form.get('clearPhone') === 'on') fd.set('clearPhone', 'on');
    fd.set('contactAddress', String(form.get('contactAddress') ?? ''));
    if (form.get('clearContactAddress') === 'on') fd.set('clearContactAddress', 'on');
    if (newSignIn && routeSignIn) fd.set('routeSignIn', 'on');
    if (askWithdraw && withdrawCreates) fd.set('withdrawCreates', 'on');
    start(async () => {
      const res = await updateUserAccountAction(fd);
      if (!res.ok) {
        setErrors(res.fields ?? { _form: res.message });
        if (res.fields?.withdrawCreates) setAskWithdraw(true);
        return;
      }
      const { changed, username, notes } = res.data;
      const words = changed.map((f) => FIELD_WORDS[f] ?? f).join(', ');
      const signedOut = changed.includes('role') || changed.includes('regions');
      announce(
        changed.length === 0
          ? `Nothing changed for "${row.username}".`
          : [
              `Saved "${username}": ${words}.`,
              ...(signedOut
                ? ['They are signed out and sign in again to pick up the change.']
                : []),
              ...notes,
            ].join(' ')
      );
      onClose();
    });
  }

  const label = 'mb-1 block text-xs font-medium text-slate-700';
  const select = 'block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm';

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 text-left">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-account-title"
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl ring-1 ring-slate-200"
      >
        <h2 id="edit-account-title" className="text-sm font-semibold text-slate-900">
          Edit {row.fullName}{' '}
          <span className="font-mono text-xs font-normal text-slate-500">{row.username}</span>
        </h2>
        {!row.isActive && <p className="mt-1 text-xs text-slate-500">This account is disabled.</p>}
        <form onSubmit={onSubmit} autoComplete="off" className="mt-3 grid gap-3">
          <div>
            <label htmlFor="edit-role" className={label}>
              Role
            </label>
            <select
              id="edit-role"
              value={role}
              onChange={(e) => setRole(e.currentTarget.value as Role)}
              className={select}
            >
              {(Object.entries(ROLE_LABELS) as [Role, string][]).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            {role !== row.role && (
              <p className="mt-0.5 text-[11px] text-slate-500">
                A new role signs the person out; they sign in again to pick it up.
              </p>
            )}
            {errors.role && <FieldError msg={errors.role} />}
          </div>

          {isSalesman && (
            <div>
              <label htmlFor="edit-route" className={label}>
                Route
              </label>
              <select
                id="edit-route"
                value={routeId}
                onChange={(e) => setRouteId(e.currentTarget.value)}
                className={select}
              >
                <option value="">— Pick a route —</option>
                {routeOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code} · {r.name}
                    {r.holder && r.holder.id !== row.id
                      ? ` — from ${r.holder.fullName} (disabled)`
                      : ''}
                  </option>
                ))}
              </select>
              {handoverFrom && (
                <p className="mt-0.5 text-[11px] text-slate-500">
                  The route is taken from {handoverFrom.fullName}’s disabled account
                  {retiresName ? `, and his sign-in name ${handoverFrom.username} is retired` : ''}.
                </p>
              )}
              {errors.ownedRouteId && <FieldError msg={errors.ownedRouteId} />}
              {newSignIn && (
                <label className="mt-2 flex items-start gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={routeSignIn}
                    onChange={(e) => setRouteSignIn(e.currentTarget.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    Sign in with the route code: {row.username} becomes <b>{newSignIn}</b>
                  </span>
                </label>
              )}
              {errors.routeSignIn && <FieldError msg={errors.routeSignIn} />}
            </div>
          )}

          {SUPERVISED_ROLES.includes(role) && (
            <div>
              <label htmlFor="edit-supervisor" className={label}>
                Supervisor
              </label>
              <select
                id="edit-supervisor"
                value={supervisorId}
                onChange={(e) => setSupervisorId(e.currentTarget.value)}
                className={select}
              >
                <option value="">—</option>
                {unlistedSupervisor && (
                  <option value={row.supervisorId!}>
                    {unlistedSupervisor.fullName} ({unlistedSupervisor.username}) —{' '}
                    {unlistedSupervisor.isActive ? 'cannot supervise' : 'disabled'}
                  </option>
                )}
                {supervisorOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName} ({s.username}){s.role === Role.MANAGER ? ' · Manager' : ''}
                  </option>
                ))}
              </select>
              {errors.supervisorId && <FieldError msg={errors.supervisorId} />}
            </div>
          )}

          {REGION_SCOPED_ROLES.includes(role) && (
            <fieldset>
              <legend className={label}>Regions</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {regionOptions.map((g) => (
                  <label key={g.id} className="flex items-center gap-1 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={regionIds.includes(g.id)}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        setRegionIds((ids) =>
                          on ? [...ids, g.id] : ids.filter((x) => x !== g.id)
                        );
                      }}
                    />
                    {g.code}
                    <span className="text-xs text-slate-500">{g.name}</span>
                  </label>
                ))}
              </div>
              {errors.regionIds && <FieldError msg={errors.regionIds} />}
            </fieldset>
          )}

          {askWithdraw && (
            <div>
              {errors.withdrawCreates && <FieldError msg={errors.withdrawCreates} />}
              <label className="mt-1 flex items-start gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={withdrawCreates}
                  onChange={(e) => setWithdrawCreates(e.currentTarget.checked)}
                  className="mt-0.5"
                />
                <span>Withdraw them with this change</span>
              </label>
            </div>
          )}

          <div>
            <label htmlFor="edit-phone" className={label}>
              Phone
            </label>
            <input
              id="edit-phone"
              name="phone"
              type="tel"
              autoComplete="off"
              maxLength={50}
              placeholder={
                row.hasPhone ? 'A number is on file — type to replace it' : 'No number on file'
              }
              className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
            />
            {row.hasPhone && (
              <label className="mt-1 flex items-center gap-2 text-xs text-slate-700">
                <input type="checkbox" name="clearPhone" />
                Remove the phone number
              </label>
            )}
            {errors.phone && <FieldError msg={errors.phone} />}
          </div>

          <div>
            <label htmlFor="edit-contact-address" className={label}>
              E-mail
            </label>
            <input
              id="edit-contact-address"
              name="contactAddress"
              type="text"
              inputMode="email"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={200}
              placeholder={
                row.hasEmail ? 'An address is on file — type to replace it' : 'No address on file'
              }
              className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
            />
            {row.hasEmail && (
              <label className="mt-1 flex items-center gap-2 text-xs text-slate-700">
                <input type="checkbox" name="clearContactAddress" />
                Remove the e-mail address
              </label>
            )}
            {errors.contactAddress && <FieldError msg={errors.contactAddress} />}
          </div>

          {errors._form && <FieldError msg={errors._form} />}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {pending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function FieldError({ msg }: { msg: string }) {
  return (
    <p role="alert" className="mt-0.5 text-[11px] font-medium text-red-600">
      {msg}
    </p>
  );
}
