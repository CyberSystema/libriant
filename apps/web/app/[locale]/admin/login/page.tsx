import { notFound, redirect } from 'next/navigation';
import { Asset } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { currentAdminSession } from '@/lib/admin-session';
import { AdminLoginForm } from './AdminLoginForm';

export const metadata = { title: 'Admin sign in · Libriant' };
export const dynamic = 'force-dynamic';

export default async function AdminLoginPage(props: { params: Promise<{ locale: string }> }) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const admin = await currentAdminSession();
  if (admin) redirect(`/admin/tenants`);

  return (
    <main className="lbr-auth-shell">
      <div className="lbr-auth-card">
        <div className="lbr-auth-card__brand">
          <Asset name="brand/logo" width={160} height={40} />
        </div>
        <h1 className="lbr-auth-card__heading">Admin sign in</h1>
        <p className="lbr-auth-card__subtitle">
          For Libriant staff only. Tenant librarians use the regular sign-in.
        </p>
        <AdminLoginForm />
      </div>
    </main>
  );
}
