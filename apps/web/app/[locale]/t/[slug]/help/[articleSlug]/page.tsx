import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { ApiError, api } from '@/lib/api';
import { renderSafeHtml } from '@/lib/safe-html';

export const dynamic = 'force-dynamic';

type ArticleDetail = {
  slug: string;
  title: string;
  summary: string;
  bodyHtml: string;
  locale: string;
  updatedAt: string;
};

export default async function HelpArticlePage(props: {
  params: Promise<{ locale: string; slug: string; articleSlug: string }>;
}) {
  const params = await props.params;
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
          {/* input-and-files-04: parsed against an allowlist into React
              elements rather than handed to `dangerouslySetInnerHTML`. The
              ingest-time sanitizer this body passes through is a regex denylist
              with proven bypasses, and it is the wrong place for the guard
              anyway — the row is written once and read on every page view. */}
          <article className="lbr-prose">{renderSafeHtml(article.bodyHtml)}</article>
        </CardBody>
      </Card>
    </>
  );
}
