import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, EmptyState, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import { HelpSearch } from './HelpSearch';

export const dynamic = 'force-dynamic';

type ArticleListItem = {
  slug: string;
  title: string;
  summary: string;
  tags: string | null;
  sortOrder: number;
  updatedAt: string;
};

type ListResponse = {
  locale: string;
  items: ArticleListItem[];
  query: string | null;
};

export default async function HelpIndexPage(props: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);

  const q = searchParams.q?.trim();
  const qs = new URLSearchParams({ locale: params.locale });
  if (q) qs.set('q', q);

  let list: ListResponse;
  let fetchError: string | null = null;
  try {
    list = await api<ListResponse>(`/help/articles?${qs.toString()}`);
  } catch (err) {
    list = { locale: params.locale, items: [], query: q ?? null };
    fetchError = translateApiError(err, t, t('common.states.error'));
  }

  return (
    <>
      <PageHeader title={t('help.title')} subtitle={t('help.subtitle')} />

      <HelpSearch catalog={catalog} locale={params.locale} initialQuery={q ?? ''} />

      {fetchError ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {fetchError}
        </Banner>
      ) : null}

      {list.items.length === 0 ? (
        q ? (
          <EmptyState
            illustration="illustrations/empty-catalog"
            title={t('help.noMatches.title')}
            description={t('help.noMatches.description', { query: q })}
          />
        ) : (
          <p style={{ color: 'var(--color-text-muted)' }}>{t('help.empty')}</p>
        )
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {list.items.map((a) => (
            <li key={a.slug} style={{ marginBottom: 'var(--sp-3)' }}>
              <Card>
                <CardBody>
                  <Link
                    href={`/${params.locale}/t/${params.slug}/help/${a.slug}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    <h2 style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>{a.title}</h2>
                    <p style={{ margin: 'var(--sp-1) 0 0 0', color: 'var(--color-text-muted)' }}>
                      {a.summary}
                    </p>
                    {a.tags ? (
                      <div
                        style={{
                          display: 'flex',
                          gap: 'var(--sp-1)',
                          flexWrap: 'wrap',
                          marginTop: 'var(--sp-2)',
                        }}
                      >
                        {a.tags
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean)
                          .map((tag) => (
                            <span
                              key={tag}
                              style={{
                                padding: '2px var(--sp-2)',
                                background: 'var(--color-surface-muted)',
                                borderRadius: 'var(--radius-full)',
                                fontSize: 'var(--fs-xs)',
                                color: 'var(--color-text-muted)',
                              }}
                            >
                              {tag}
                            </span>
                          ))}
                      </div>
                    ) : null}
                  </Link>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
