import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { homeForRole } from '@/lib/role-home';

export default async function HomePage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  redirect(homeForRole(session.user.role));
}
