import Link from 'next/link';
import { PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { notFound } from 'next/navigation';
import { loadCatalog } from '@/lib/locale-loader';
import { PlaceHoldForm } from './PlaceHoldForm';

export default async function NewReservationPage({
  params,
}: {
  params: { locale: string; slug: string };
}) {
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);

  return (
    <>
      <PageHeader
        title={t('reservations.placeHold.title')}
        subtitle={t('reservations.placeHold.subtitle')}
        trail={
          <Link
            href={`/${params.locale}/t/${params.slug}/reservations`}
            style={{ color: 'inherit' }}
          >
            ← {t('reservations.title')}
          </Link>
        }
      />
      <div style={{ maxWidth: 720 }}>
        <PlaceHoldForm slug={params.slug} catalog={catalog} locale={params.locale} />
      </div>
    </>
  );
}
