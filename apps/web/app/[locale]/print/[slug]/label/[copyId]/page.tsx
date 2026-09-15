import { notFound } from 'next/navigation';
import { Barcode } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { currentSession, requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { UNTITLED_TITLE, readDisplayTitle, type MarcRecord } from '@/lib/marc-simple-fields';

export const dynamic = 'force-dynamic';

type LabelItem = {
  id: string;
  bibId: string;
  barcode: string | null;
  callNumberPrefix: string | null;
  callNumberBase: string | null;
  callNumberSuffix: string | null;
};

type LabelRecord = { id: string; record: MarcRecord };

/**
 * Chrome-free spine/copy label: library name, title, the copy barcode (as a
 * scannable Code 128), and the call number.
 *
 * ## Two fetches, and no `?book=` (2.0 phase 20k)
 *
 * 1.0 had no copy-by-id route, so the caller passed the book id in the query
 * string and the copy was found inside the book's `copies` array. 2.0 has
 * `GET /items/:id`, and an item carries its own `bibId` — so the record is
 * resolved FROM the copy rather than alongside it, and the two can no longer
 * disagree. `buildPrintPath` still appends `?book=` when a caller supplies one;
 * this route ignores it.
 *
 * ## The shelf line is a call number now
 *
 * 1.0's `shelfLocation` was free text on the copy. 2.0 splits the shelf (a
 * `shelving_locations` row, which is a place) from the call number (which is
 * what is printed on the spine and what the inventory wand in phase 81 walks
 * in order). A label carries the call number.
 */
export default async function LabelPage(props: {
  params: Promise<{ locale: string; slug: string; copyId: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();

  const session = await currentSession();
  if (!session) notFound();
  // A slug that isn't the caller's own tenant is a clean 404 (the API would 403).
  if (session.tenant.slug !== params.slug) notFound();
  const cookie = await requestCookieHeader();

  let item: LabelItem;
  try {
    item = await api<LabelItem>(`/t/${params.slug}/items/${params.copyId}`, { cookie });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  // A copy with no barcode has nothing scannable to print. Catalogued before
  // its label was made is a legal state in 2.0, and a blank Code 128 would be
  // a sticker that reads as a barcode and scans as nothing.
  if (!item.barcode) notFound();

  let record: LabelRecord;
  try {
    record = await api<LabelRecord>(`/t/${params.slug}/catalog/bib/${item.bibId}`, { cookie });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const callNumber = [item.callNumberPrefix, item.callNumberBase, item.callNumberSuffix]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="lbr-label">
      <div className="lbr-label__lib">{session.tenant.name}</div>
      <div className="lbr-label__title">{readDisplayTitle(record.record) || UNTITLED_TITLE}</div>
      <div className="lbr-label__barcode">
        <Barcode value={item.barcode} height={44} />
      </div>
      {callNumber ? <div className="lbr-label__shelf">{callNumber}</div> : null}
    </div>
  );
}
