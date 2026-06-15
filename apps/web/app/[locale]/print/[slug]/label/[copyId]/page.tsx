import { notFound } from 'next/navigation';
import { Barcode } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { currentSession, requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';

export const dynamic = 'force-dynamic';

type LabelBook = {
  id: string;
  title: string;
  copies: Array<{ id: string; barcode: string; shelfLocation: string | null }>;
};

/**
 * Chrome-free spine/copy label: library name, book title, the copy barcode (as
 * a scannable Code 128), and the shelf location. There is no copy-by-id fetch,
 * so the book id is passed as `?book=` and the copy resolved from its `copies`.
 */
export default async function LabelPage(props: {
  params: Promise<{ locale: string; slug: string; copyId: string }>;
  searchParams: Promise<{ book?: string }>;
}) {
  const params = await props.params;
  const search = await props.searchParams;
  if (!isLocale(params.locale)) notFound();
  if (!search.book) notFound();

  const session = await currentSession();
  if (!session) notFound();
  // A slug that isn't the caller's own tenant is a clean 404 (the API would 403).
  if (session.tenant.slug !== params.slug) notFound();
  const cookie = await requestCookieHeader();

  let book: LabelBook;
  try {
    book = await api<LabelBook>(`/t/${params.slug}/catalog/books/${search.book}`, { cookie });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const copy = book.copies.find((c) => c.id === params.copyId);
  if (!copy) notFound();

  return (
    <div className="lbr-label">
      <div className="lbr-label__lib">{session.tenant.name}</div>
      <div className="lbr-label__title">{book.title}</div>
      <div className="lbr-label__barcode">
        <Barcode value={copy.barcode} height={44} />
      </div>
      {copy.shelfLocation ? <div className="lbr-label__shelf">{copy.shelfLocation}</div> : null}
    </div>
  );
}
