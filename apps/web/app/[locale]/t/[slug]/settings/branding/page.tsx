import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { currentSession } from '@/lib/session';
import { BrandingForm } from './BrandingForm';

export const dynamic = 'force-dynamic';

/** Per-library branding — accent colour + header logo. Admin-only. */
export default async function BrandingPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);

  const session = await currentSession();
  const role = session?.user.role;
  if (role !== 'owner' && role !== 'admin') {
    redirect(`/${params.locale}/t/${params.slug}`);
  }

  return (
    <>
      <PageHeader title={t('settings.branding.title')} subtitle={t('settings.branding.subtitle')} />
      <BrandingForm
        slug={params.slug}
        locale={params.locale}
        catalog={catalog}
        brandColor={session?.tenant.brandColor ?? null}
        brandLogoRef={session?.tenant.brandLogoRef ?? null}
      />
    </>
  );
}
