import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { dataPort } from '@/lib/ports';
import { PatronEnrolForm, type Branch, type PatronCategory } from './PatronEnrolForm';

export const dynamic = 'force-dynamic';

export default async function NewPatronPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();
  const port = dataPort();

  /**
   * The two reference lists an enrolment needs, server-rendered so the selects
   * do not flash empty.
   *
   * Each degrades to `[]` on its own, and an empty CATEGORY list is a real
   * state rather than a failure: 20m measured that a freshly provisioned tenant
   * has none at all — `pcat-general` comes from the upgrade and nothing else,
   * while provisioning seeds a branch, a shelving location and an item type.
   * The field is optional and the column nullable, so the form enrols without
   * one and says so.
   *
   * NO CUSTOM FIELDS. 1.0 fetched the member field definitions here and the form
   * wrote values through them; `lbr2.patrons.custom_fields` exists and the
   * upgrade fills it (20n added it to the record read), but no 2.0 route WRITES
   * it, so a form offering the inputs would collect what it cannot save.
   */
  const [categories, branches] = await Promise.all([
    port
      .get<{ items: PatronCategory[] }>(`/t/${params.slug}/org/patron-categories`, { cookie })
      .then((r) => r.items)
      .catch(() => []),
    port
      .get<{ items: Branch[] }>(`/t/${params.slug}/org/branches`, { cookie })
      .then((r) => r.items)
      .catch(() => []),
  ]);

  return (
    <>
      <PageHeader
        title={t('members.form.title')}
        subtitle={t('members.form.subtitle')}
        trail={
          <Link href={`/${params.locale}/t/${params.slug}/members`} style={{ color: 'inherit' }}>
            ← {t('members.title')}
          </Link>
        }
      />
      <div style={{ maxWidth: 720 }}>
        <PatronEnrolForm
          slug={params.slug}
          catalog={catalog}
          locale={params.locale}
          categories={categories}
          branches={branches}
        />
      </div>
    </>
  );
}
