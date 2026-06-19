import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { ToastProvider } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';

/**
 * Shell for all `/[locale]/admin/*` pages. Just a ToastProvider — the
 * sidebar and auth-redirect live in `(authed)/layout.tsx`, the login
 * page is at the top level so it renders without a sidebar gate.
 *
 * Host isolation: the platform admin panel is served ONLY from the admin host
 * (`ADMIN_HOST`, e.g. admin.libriant.com). On any other host — notably the
 * public apex at `libriant.com/admin` — we 404 so the admin surface isn't
 * exposed there at all. The admin session cookie is `__Host-`-scoped to the
 * admin host already, so the admin API is unreachable cross-host; this hides
 * the UI to match. When `ADMIN_HOST` is unset (local dev) nothing is blocked.
 */
export default async function AdminLayout(props: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const params = await props.params;

  const { children } = props;

  if (!isLocale(params.locale)) notFound();

  const adminHost = (process.env.ADMIN_HOST ?? '').trim().toLowerCase();
  if (adminHost) {
    // Caddy preserves the original Host header through the proxy, so this is the
    // real requested host (libriant.com vs admin.libriant.com). Strip any port.
    const reqHost = ((await headers()).get('host') ?? '').split(':')[0]?.toLowerCase() ?? '';
    if (reqHost && reqHost !== adminHost) notFound();
  }

  return <ToastProvider>{children}</ToastProvider>;
}
