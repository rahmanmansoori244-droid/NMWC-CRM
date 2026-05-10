'use client';

import { useState, useTransition } from 'react';
import {
  createRegionAction,
  createRouteAction,
  toggleRegionActiveAction,
  toggleRouteActiveAction,
} from '@/services/routes';

// B-17: actions now return `{ ok, ... }` (runAction wrapping) instead of
// throwing AppError. The form translates that shape into inline errors.

export function CreateRegionForm() {
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    const form = e.currentTarget;
    const fd = new FormData(form);
    start(async () => {
      const res = await createRegionAction(fd);
      if (res.ok) {
        form.reset();
      } else if (res.fields) {
        setErrors(res.fields);
      } else {
        setErrors({ _form: res.message });
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 text-sm">
      <Input label="Code" name="code" placeholder="MUSCAT" error={errors.code} />
      <Input label="Name" name="name" placeholder="Muscat" error={errors.name} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300"
      >
        {pending ? 'Creating…' : 'Create region'}
      </button>
      {errors._form && <p className="text-xs text-red-600">{errors._form}</p>}
    </form>
  );
}

export function CreateRouteForm({
  regions,
}: {
  regions: { id: string; code: string; name: string }[];
}) {
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    const form = e.currentTarget;
    const fd = new FormData(form);
    start(async () => {
      const res = await createRouteAction(fd);
      if (res.ok) {
        form.reset();
      } else if (res.fields) {
        setErrors(res.fields);
      } else {
        setErrors({ _form: res.message });
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 text-sm">
      <Input label="Code" name="code" placeholder="MCT-09" error={errors.code} />
      <Input label="Name" name="name" placeholder="Muscat MCT-09" error={errors.name} />
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Region *</label>
        <select
          name="regionId"
          required
          className="block w-full rounded-md border-slate-300 px-3 py-2 shadow-sm"
        >
          <option value="">— Pick a region —</option>
          {regions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.code} · {r.name}
            </option>
          ))}
        </select>
        {errors.regionId && <p className="mt-0.5 text-[11px] text-red-600">{errors.regionId}</p>}
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300"
      >
        {pending ? 'Creating…' : 'Create route'}
      </button>
      {errors._form && <p className="text-xs text-red-600">{errors._form}</p>}
    </form>
  );
}

export function ToggleButton({
  id,
  kind,
  isActive,
}: {
  id: string;
  kind: 'region' | 'route';
  isActive: boolean;
}) {
  const [pending, start] = useTransition();

  function onClick() {
    if (
      !confirm(
        `${isActive ? 'Disable' : 'Enable'} this ${kind}? Disabling hides it from new assignments.`
      )
    )
      return;
    const fd = new FormData();
    fd.set('id', id);
    start(async () => {
      const res =
        kind === 'region'
          ? await toggleRegionActiveAction(fd)
          : await toggleRouteActiveAction(fd);
      if (!res.ok) {
        // Toggle is a button without an inline error slot; surface the
        // server message as an alert. Rare path (network or perm change).
        alert(res.message);
      }
    });
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={onClick}
      className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
    >
      {isActive ? 'Disable' : 'Enable'}
    </button>
  );
}

function Input({
  label,
  name,
  placeholder,
  error,
}: {
  label: string;
  name: string;
  placeholder?: string;
  error?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-700">{label} *</label>
      <input
        name={name}
        required
        placeholder={placeholder}
        className="block w-full rounded-md border-slate-300 px-3 py-2 shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
      />
      {error && <p className="mt-0.5 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
