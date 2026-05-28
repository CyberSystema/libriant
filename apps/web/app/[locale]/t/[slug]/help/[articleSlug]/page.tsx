import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { ApiError, api } from '@/lib/api';

export const dynamic = 'force-dynamic';

type ArticleDetail = {
  slug: string;
  title: string;
  summary: string;
  bodyHtml: string;
  locale: string;
  updatedAt: string;
};

export default async function HelpArticlePage({
  params,
}: {
  params: { locale: string; slug: string; articleSlug: string };
}) {
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);

  let article: ArticleDetail | null = null;
  try {
    article = await api<ArticleDetail>(
      `/help/articles/${encodeURIComponent(params.articleSlug)}?locale=${params.locale}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const isFallback = article && article.locale !== params.locale;

  return (
    <>
      <PageHeader
        title={article.title}
        subtitle={article.summary}
        trail={
          <Link href={`/${params.locale}/t/${params.slug}/help`} style={{ color: 'inherit' }}>
            ← {t('help.title')}
          </Link>
        }
      />

      {isFallback ? (
        <Banner severity="info" style={{ marginBottom: 'var(--sp-4)' }}>
          {t('help.fallbackNotice', { locale: article.locale })}
        </Banner>
      ) : null}

      <Card>
        <CardBody>
          <article
            className="lbr-prose"
            // The HTML comes from our own ingest-time markdown render of
            // checked-in markdown. No user input is involved, so the
            // `dangerouslySetInnerHTML` here is safe by construction.
            dangerouslySetInnerHTML={{ __html: article.bodyHtml }}
          />
        </CardBody>
      </Card>
    </>
  );
}
