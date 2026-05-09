import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { ChangePasswordForm } from './ChangePasswordForm';

// AUTH-16 / AUTH-09: self-service change-password page. The middleware
// (auth.config.ts) redirects users with `mustChangePassword=true` here from
// every other route until they complete this form.
export const metadata = { title: 'Change password · NMWC' };
export const dynamic = 'force-dynamic';

export default async function ChangePasswordPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const mustChange =
    (session.user as { mustChangePassword?: boolean }).mustChangePassword === true;
  return (
    <main>
      <PageHeader
        title="Change password"
        subtitle={
          mustChange
            ? 'You must change your password before continuing.'
            : 'Update your account password.'
        }
      />
      <div className="p-4 sm:p-6">
        <section className="max-w-md rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          {mustChange && (
            <div className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
              The Manager set you a temporary password. Choose a new one to continue.
            </div>
          )}
          <ChangePasswordForm />
        </section>
      </div>
    </main>
  );
}
