import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { ApiError } from '@/lib/api';
import { dataPort } from '@/lib/ports';
import { translateApiError } from '@/lib/api-errors';
import { UNTITLED_TITLE, readDisplayTitle } from '@/lib/marc-simple-fields';
import {
  BookDetail,
  type BibRecordRead,
  type BranchRow,
  type ItemRow,
  type ItemTypeRow,
  type LocationRow,
} from './BookDetail';

export const dynamic = 'force-dynamic';

type Page<T> = { items: T[]; nextCursor: string | null };

/**
 * The copies list is a page, not a list (2.0 phase 20k).
 *
 * `LIST_MAX_LIMIT` is 100, so a class set of 120 copies cannot arrive in one
 * response. Asking for the maximum and TELLING the librarian when there are
 * more is the honest shape: silently showing 100 of 120 is how a copy that
 * exists becomes a copy nobody can find.
 */
const COPIES_PAGE = 100;

export default async function BibDetailPage(props: {
  params: Promise<{ locale: string; slug: string; id: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  let record: BibRecordRead | null = null;
  let fetchError: string | null = null;
  try {
    record = await dataPort().get<BibRecordRead>(`/t/${params.slug}/catalog/bib/${params.id}`, {
      cookie,
    });
  } catch (err) {
    // A DELETED record 404s here: `BibReadService.read` filters
    // `deleted_at IS NULL`, and §5's `deletedRecord=persistent` promise is
    // about OAI-PMH and the database, not about this screen. So there is no
    // "this record is deleted" state to render — which is also why the delete
    // action below leaves for the catalogue list rather than staying.
    if (err instanceof ApiError && err.status === 404) notFound();
    fetchError = translateApiError(err, t, t('common.states.error'));
  }

  if (!record) {
    return (
      <>
        <PageHeader title={t('catalog.title')} />
        <Banner severity="critical">{fetchError ?? t('common.states.error')}</Banner>
      </>
    );
  }

  // The copies and the three lookup lists the add-copy form needs. Each
  // degrades to empty on its own: a catalogue record whose copies failed to
  // load is still a record worth reading, and the form says what is missing
  // rather than posting a body the API will refuse.
  const [copies, branches, itemTypes, locations] = await Promise.all([
    dataPort()
      .get<Page<ItemRow>>(`/t/${params.slug}/items?bibId=${params.id}&limit=${COPIES_PAGE}`, {
        cookie,
      })
      .catch(() => ({ items: [], nextCursor: null }) as Page<ItemRow>),
    dataPort()
      .get<{ items: BranchRow[] }>(`/t/${params.slug}/org/branches`, { cookie })
      .catch(() => ({ items: [] })),
    dataPort()
      .get<{ items: ItemTypeRow[] }>(`/t/${params.slug}/org/item-types`, { cookie })
      .catch(() => ({ items: [] })),
    dataPort()
      .get<{ items: LocationRow[] }>(`/t/${params.slug}/org/locations`, { cookie })
      .catch(() => ({ items: [] })),
  ]);

  // Not translated, on purpose: the catalogue list renders the projector's
  // stored `[Untitled]` for the same record.
  const title = readDisplayTitle(record.record) || UNTITLED_TITLE;

  return (
    <>
      <PageHeader
        title={title}
        trail={
          <Link href={`/${params.locale}/t/${params.slug}/catalog`} style={{ color: 'inherit' }}>
            ← {t('catalog.title')}
          </Link>
        }
      />
      <BookDetail
        slug={params.slug}
        catalog={catalog}
        locale={params.locale}
        record={record}
        copies={copies.items}
        moreCopies={copies.nextCursor !== null}
        branches={branches.items}
        itemTypes={itemTypes.items}
        locations={locations.items}
      />
    </>
  );
}
