import { notFound } from 'next/navigation';
import { ToastProvider } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';

/**
 * Shell for all `/[locale]/admin/*` pages. Just a ToastProvider — the
 * sidebar and auth-redirect live in `(authed)/layout.tsx`, the login
 * page is at the top level so it renders without a sidebar gate.
 */
export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  if (!isLocale(params.locale)) notFound();
  return <ToastProvider>{children}</ToastProvider>;
}
