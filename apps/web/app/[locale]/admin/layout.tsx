import { notFound } from 'next/navigation';
import { ToastProvider } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';

/**
 * Shell for all `/[locale]/admin/*` pages. Just a ToastProvider — the
 * sidebar and auth-redirect live in `(authed)/layout.tsx`, the login
 * page is at the top level so it renders without a sidebar gate.
 */
export default async function AdminLayout(props: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const params = await props.params;

  const { children } = props;

  if (!isLocale(params.locale)) notFound();
  return <ToastProvider>{children}</ToastProvider>;
}
