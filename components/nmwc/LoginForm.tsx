'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { loginAction } from '@/app/actions/auth';

export function LoginForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await loginAction(formData);
      if (result.ok) {
        router.push('/');
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }
  const submitting = pending;

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <div>
        <label htmlFor="username" className="mb-1 block text-sm font-medium text-slate-700">
          Username
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          required
          className="block w-full rounded-md border-slate-300 px-3 py-2 text-base shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
        />
      </div>
      <div>
        <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-700">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="block w-full rounded-md border-slate-300 px-3 py-2 text-base shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="block w-full rounded-md bg-brand-600 px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
