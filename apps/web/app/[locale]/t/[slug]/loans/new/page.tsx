import { PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { notFound } from 'next/navigation';
import { loadCatalog } from '@/lib/locale-loader';
import { CheckoutForm } from './CheckoutForm';

// `tenant_settings.loanPeriodDays` default. Library admins can tune it
// per tenant (Step 18 settings UI); for now we default to the seed value
// — the librarian can always override the dueAt on a per-loan basis.
const DEFAULT_LOAN_PERIOD_DAYS = 14;

export default async function NewLoanPage({
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
        title={t('loans.checkout.title')}
        subtitle={t('loans.checkout.subtitle')}
        trail={
          <a href={`/${params.locale}/t/${params.slug}/loans`} style={{ color: 'inherit' }}>
            ← {t('loans.title')}
          </a>
        }
      />
      <div style={{ maxWidth: 720 }}>
        <CheckoutForm
          slug={params.slug}
          catalog={catalog}
          locale={params.locale}
          defaultLoanPeriodDays={DEFAULT_LOAN_PERIOD_DAYS}
        />
      </div>
    </>
  );
}
