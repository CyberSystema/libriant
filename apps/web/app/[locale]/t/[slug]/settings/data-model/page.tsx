import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import type { FieldDef } from '@/components/DynamicFields';
import { EntityTabs } from './EntityTabs';
import { FieldEditor } from './FieldEditor';

export const dynamic = 'force-dynamic';

/** All entity kinds the data-model editor exposes. Mirrors the API enum. */
const ENTITY_KINDS = ['book', 'book_copy', 'member', 'loan', 'reservation', 'fine'] as const;
type EntityKind = (typeof ENTITY_KINDS)[number];

type EditorFieldDef = FieldDef & { archivedAt: string | null };
type FieldsResponse = { entityKind: string; fields: EditorFieldDef[] };

/**
 * Data-model editor. Two-pane layout:
 *
 *   Left  — the field list for the currently-active entity kind. Each
 *           row has reorder controls + edit + archive/restore. New fields
 *           land via the "Add a field" button.
 *   Right — live preview of the form a librarian would actually fill in,
 *           backed by `<DynamicFields>` (the same component used by
 *           /members/new + /catalog/new + onboarding wizard).
 *
 * Entity kind comes from `?entity=…` so refresh + bookmark preserve it.
 * Page is server-rendered for the initial fetch; the editor inside is
 * a client component that handles all the mutations.
 */
export default async function DataModelPage(props: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  const entityRaw = searchParams.entity ?? 'book';
  const entityKind = (
    ENTITY_KINDS.includes(entityRaw as EntityKind) ? entityRaw : 'book'
  ) as EntityKind;

  let fields: EditorFieldDef[] = [];
  let fetchError: string | null = null;
  try {
    const res = await api<FieldsResponse>(`/t/${params.slug}/data-model/fields/${entityKind}`, {
      cookie,
    });
    fields = res.fields;
  } catch (err) {
    fetchError = translateApiError(err, t, t('common.states.error'));
  }

  return (
    <>
      <PageHeader
        title={t('settings.dataModel.title')}
        subtitle={t('settings.dataModel.subtitle')}
        trail={
          <Link href={`/${params.locale}/t/${params.slug}/settings`} style={{ color: 'inherit' }}>
            ← {t('settings.title')}
          </Link>
        }
      />

      {fetchError ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {fetchError}
        </Banner>
      ) : null}

      <EntityTabs
        catalog={catalog}
        locale={params.locale}
        slug={params.slug}
        kinds={ENTITY_KINDS as unknown as string[]}
        current={entityKind}
      />

      <FieldEditor
        slug={params.slug}
        entityKind={entityKind}
        catalog={catalog}
        locale={params.locale}
        initialFields={fields}
      />
    </>
  );
}
