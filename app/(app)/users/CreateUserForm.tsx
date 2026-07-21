'use client';

import { useState, useTransition } from 'react';
import { Role } from '@prisma/client';
import { createUserAction } from '@/services/users';
import { administrableRolesFor } from '@/lib/permissions';

const ROLE_LABELS: Record<Role, string> = {
  SALESMAN: 'Salesman',
  SUPERVISOR: 'Supervisor',
  MANAGER: 'Manager',
  STEWARD: 'Data Steward',
  VIEWER: 'Read-only Viewer',
  ACCOUNTANT: 'Accountant',
  FINANCE_MANAGER: 'Finance Manager',
  GM: 'GM',
};

export function CreateUserForm({
  supervisors,
  routes,
  viewerRole,
}: {
  supervisors: { id: string; fullName: string; username: string }[];
  routes: { id: string; code: string; name: string }[];
  viewerRole: Role;
}) {
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<string | null>(null);
  // final-hunt #29: only offer roles this viewer may actually create, using the
  // same allowlist the server enforces — the UI can never drift from the rule.
  const allowedRoles = administrableRolesFor(viewerRole);
  const [role, setRole] = useState<Role>(allowedRoles[0] ?? Role.SALESMAN);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    setSuccess(null);
    const fd = new FormData(e.currentTarget);
    start(async () => {
      try {
        // PROD-006: server actions return `{ ok, code, message, fields? }`
        // shape — see lib/errors.ts (runAction).
        const res = await createUserAction(fd);
        if (!res.ok) {
          if (res.fields) setErrors(res.fields);
          else setErrors({ _form: res.message });
          return;
        }
        setSuccess('User created.');
        (e.target as HTMLFormElement).reset();
        setRole(allowedRoles[0] ?? Role.SALESMAN);
      } catch (err) {
        if (err instanceof Error) {
          setErrors({ _form: err.message });
        }
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <Field label="Full name" name="fullName" error={errors.fullName} required />
      <Field label="Username" name="username" error={errors.username} required />
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Role</label>
        <select
          name="role"
          required
          value={role}
          onChange={(e) => setRole(e.currentTarget.value as Role)}
          className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
        >
          {(Object.entries(ROLE_LABELS) as [Role, string][])
            .filter(([k]) => allowedRoles.includes(k))
            .map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
        </select>
      </div>
      {(role === Role.SALESMAN || role === Role.SUPERVISOR) && (
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">Supervisor</label>
          <select
            name="supervisorId"
            className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
          >
            <option value="">—</option>
            {supervisors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName} ({s.username})
              </option>
            ))}
          </select>
          {errors.supervisorId && <FieldError msg={errors.supervisorId} />}
        </div>
      )}
      {role === Role.SALESMAN && (
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">
            Route (must be unassigned)
          </label>
          <select
            name="ownedRouteId"
            required
            className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
          >
            <option value="">— Pick a route —</option>
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code} · {r.name}
              </option>
            ))}
          </select>
          {errors.ownedRouteId && <FieldError msg={errors.ownedRouteId} />}
        </div>
      )}
      <Field label="Email (optional)" name="email" type="email" error={errors.email} />
      <Field label="Phone (optional)" name="phone" error={errors.phone} />
      <Field
        label="Password"
        name="password"
        type="password"
        error={errors.password}
        required
        hint="Minimum 12 characters"
      />
      {errors._form && <FieldError msg={errors._form} />}
      {success && <p className="text-xs font-medium text-emerald-600">{success}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {pending ? 'Creating…' : 'Create user'}
      </button>
    </form>
  );
}

function Field({
  label,
  name,
  type = 'text',
  required,
  error,
  hint,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  error?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      <input
        name={name}
        type={type}
        required={required}
        className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
      />
      {hint && !error && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
      {error && <FieldError msg={error} />}
    </div>
  );
}

function FieldError({ msg }: { msg: string }) {
  return <p className="mt-0.5 text-[11px] font-medium text-red-600">{msg}</p>;
}
