import { LoginForm } from '@/components/nmwc/LoginForm';

export const metadata = { title: 'Sign in · NMWC Customer Master' };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-brand-900">NMWC</h1>
          <p className="mt-1 text-sm text-slate-600">Customer Master</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
