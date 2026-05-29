import Link from 'next/link';
import { Banner, HelpButton, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { notFound } from 'next/navigation';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { CatalogTable, type CatalogBook } from './CatalogTable';

type ListResponse<T> = { items: T[]; nextCursor: string | null };

export default async function CatalogPage(props: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  const q = searchParams.q?.trim();
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  qs.set('limit', '25');

  let initial: ListResponse<CatalogBook>;
  let fetchError: string | null = null;
  try {
    initial = await api<ListResponse<CatalogBook>>(
      `/t/${params.slug}/catalog/books?${qs.toString()}`,
      { cookie },
    );
  } catch (err) {
    initial = { items: [], nextCursor: null };
    fetchError = err instanceof ApiError ? err.message : t('common.states.error');
  }

  return (
    <>
      <PageHeader
        title={t('common.nav.catalog')}
        subtitle={t('catalog.subtitle')}
        help={
          <HelpButton title="About the catalog">
            <p>
              The catalog is every book your library owns. Each row is one <em>title</em>; click
              into it to see the individual <em>copies</em> you have on the shelf.
            </p>
            <h3>What you can do here</h3>
            <ul>
              <li>
                Search by title, author, or ISBN — the search is accent-insensitive, so{' '}
                <code>πατωντας</code> finds <code>Πατώντας</code>.
              </li>
              <li>
                Click <strong>Add a book</strong> to enter one by hand or look it up by ISBN.
              </li>
              <li>Click any title to edit, add custom fields, or manage copies.</li>
            </ul>
            <h3>Counts on the table</h3>
            <p>
              The “Available” column shows how many copies aren’t currently checked out or reserved.
              The plan you’re on caps the total titles in your catalog — you can see your current
              usage from the Billing page.
            </p>
          </HelpButton>
        }
        actions={
          <Link
            href={`/${params.locale}/t/${params.slug}/catalog/new`}
            className="lbr-btn lbr-btn--primary lbr-btn--md"
          >
            {t('catalog.addBook')}
          </Link>
        }
      />
      {fetchError ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {fetchError}
        </Banner>
      ) : null}
      <CatalogTable catalog={catalog} locale={params.locale} slug={params.slug} initial={initial} />
    </>
  );
}
