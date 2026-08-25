'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  FormField,
  Input,
  Modal,
  useToast,
} from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import { printDocument } from '@/lib/print';
import type { FieldDef } from '@/components/DynamicFields';
import { BookForm, type BookInitial } from '../new/BookForm';
import { CoverUploader } from './CoverUploader';
import { BarcodeScanner, SCAN_FORMATS, scanningSupported } from '@/components/BarcodeScanner';

type BookCopy = {
  id: string;
  barcode: string;
  status: 'available' | 'on_loan' | 'reserved' | 'lost' | 'damaged' | 'withdrawn';
  shelfLocation: string | null;
  archivedAt: string | null;
};

export type DetailBook = BookInitial & {
  coverAssetRef: string | null;
  archivedAt: string | null;
  copies: BookCopy[];
};

type Props = {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  initial: DetailBook;
  customFields: FieldDef[];
};

/**
 * Book detail page with view / edit modes (like MemberDetail):
 *
 *   - View — bibliographic summary, authors, custom fields, copies
 *     table, cover image.
 *   - Edit — reuses `<BookForm>` in edit mode.
 *
 * Plus a copy-management section with "+ Add a copy" that POSTs to
 * `/catalog/books/:id/copies`, and per-row barcode + shelf editing
 * deferred to a follow-up step (the table is read-only for now; the
 * status itself lives behind the Copies/Loans transitions).
 */
export function BookDetail({ slug, catalog, locale, initial, customFields }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [book, setBook] = React.useState<DetailBook>(initial);
  const [editing, setEditing] = React.useState(false);
  const [archiveBusy, setArchiveBusy] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  /**
   * Why the archive was refused, rendered INSIDE the confirmation dialog
   * (frontend-05). A critical toast cannot serve here: `Modal` opens a native
   * `<dialog>` with `showModal()`, which sits in the browser top layer and
   * makes the rest of the page inert, so the toast was painted under the
   * backdrop — unreadable and unclickable. The dialog just sat there.
   */
  const [archiveError, setArchiveError] = React.useState<string | null>(null);
  const openArchive = () => {
    setArchiveError(null);
    setArchiveOpen(true);
  };
  const closeArchive = () => {
    setArchiveError(null);
    setArchiveOpen(false);
  };
  const [addCopyOpen, setAddCopyOpen] = React.useState(false);
  const [printingCopyId, setPrintingCopyId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setBook(initial);
  }, [initial]);

  // Print a barcode/spine label for one copy. Silent in the desktop shell; opens
  // the print route (which auto-prints) in a browser.
  async function printLabel(copyId: string) {
    setPrintingCopyId(copyId);
    try {
      const res = await printDocument({ locale, slug, kind: 'label', id: copyId, bookId: book.id });
      toast.show(
        res.ok
          ? { severity: 'success', title: t('catalog.book.print.labelSent') }
          : { severity: 'critical', title: t('catalog.book.print.labelFailed') },
      );
    } finally {
      setPrintingCopyId(null);
    }
  }

  async function archive() {
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      const updated = await api<DetailBook>(`/t/${slug}/catalog/books/${book.id}`, {
        method: 'DELETE',
      });
      setBook({ ...book, ...updated });
      toast.show({ severity: 'success', title: t('catalog.book.archived') });
      closeArchive();
      router.refresh();
    } catch (err) {
      // Refusals here are the interesting ones — "this book still has copies
      // on loan". Say it in the dialog; the confirm button is right there.
      setArchiveError(translateApiError(err, t, t('common.states.error')));
    } finally {
      setArchiveBusy(false);
    }
  }

  async function restore() {
    setArchiveBusy(true);
    try {
      const updated = await api<DetailBook>(`/t/${slug}/catalog/books/${book.id}`, {
        method: 'PATCH',
        body: { archived: false },
      });
      setBook({ ...book, ...updated });
      toast.show({ severity: 'success', title: t('catalog.book.restored') });
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: translateApiError(err, t, t('common.states.error')),
      });
    } finally {
      setArchiveBusy(false);
    }
  }

  if (editing) {
    return (
      <Card>
        <CardHeader title={t('catalog.book.title')} subtitle={t('catalog.book.subtitle')} />
        <CardBody>
          <BookForm
            slug={slug}
            catalog={catalog}
            locale={locale}
            customFields={customFields}
            initial={book}
            cancelHref={`/${locale}/t/${slug}/catalog/${book.id}`}
            onSaved={(updated) => {
              setBook({ ...book, ...updated });
              setEditing(false);
            }}
          />
        </CardBody>
      </Card>
    );
  }

  return (
    <>
      {book.archivedAt ? (
        <Banner severity="warning" title={t('catalog.book.archivedNotice')}>
          {t('catalog.book.archivedHint')}
        </Banner>
      ) : null}

      <div
        className="lbr-split"
        style={{
          marginTop: 'var(--sp-4)',
        }}
      >
        <div>
          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader
              title={t('catalog.book.summary')}
              actions={
                <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                  {t('common.actions.edit')}
                </Button>
              }
            />
            <CardBody>
              <dl className="lbr-dl">
                <dt>{t('catalog.book.titleLabel')}</dt>
                <dd>
                  <strong>{book.title}</strong>
                  {book.subtitle ? (
                    <div style={{ color: 'var(--color-text-muted)' }}>{book.subtitle}</div>
                  ) : null}
                </dd>
                <dt>{t('catalog.book.authorsLabel')}</dt>
                <dd>
                  {book.authors.length === 0 ? '—' : book.authors.map((a) => a.fullName).join(', ')}
                </dd>
                {book.publicationYear ? (
                  <>
                    <dt>{t('catalog.book.yearLabel')}</dt>
                    <dd>{book.publicationYear}</dd>
                  </>
                ) : null}
                {book.publisher ? (
                  <>
                    <dt>{t('catalog.book.publisherLabel')}</dt>
                    <dd>{book.publisher}</dd>
                  </>
                ) : null}
                {book.numPages ? (
                  <>
                    <dt>{t('catalog.book.pagesLabel')}</dt>
                    <dd>{book.numPages}</dd>
                  </>
                ) : null}
                {book.language ? (
                  <>
                    <dt>{t('catalog.book.languageLabel')}</dt>
                    <dd>{book.language.toUpperCase()}</dd>
                  </>
                ) : null}
                {book.isbn13 || book.isbn10 ? (
                  <>
                    <dt>ISBN</dt>
                    <dd>{book.isbn13 ?? book.isbn10}</dd>
                  </>
                ) : null}
                {book.classification ? (
                  <>
                    <dt>{t('catalog.book.classificationLabel')}</dt>
                    <dd>{book.classification}</dd>
                  </>
                ) : null}
                {book.description ? (
                  <>
                    <dt>{t('catalog.book.descriptionLabel')}</dt>
                    <dd>
                      <pre
                        style={{
                          whiteSpace: 'pre-wrap',
                          font: 'inherit',
                          margin: 0,
                        }}
                      >
                        {book.description}
                      </pre>
                    </dd>
                  </>
                ) : null}
              </dl>
            </CardBody>
          </Card>

          {customFields.length > 0 ? (
            <Card style={{ marginBottom: 'var(--sp-4)' }}>
              <CardHeader title={t('catalog.book.customFields')} />
              <CardBody>
                {Object.keys(book.customFields).length === 0 ? (
                  <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
                    {t('catalog.book.noCustomValues')}
                  </p>
                ) : (
                  <dl className="lbr-dl">
                    {Object.entries(book.customFields).map(([key, value]) => {
                      if (value === null || value === undefined || value === '') return null;
                      const def = customFields.find((f) => f.fieldKey === key);
                      const label =
                        def?.labelJson[locale] ?? def?.labelJson.en ?? def?.labelJson.el ?? key;
                      return (
                        <React.Fragment key={key}>
                          <dt>{label}</dt>
                          <dd>
                            {Array.isArray(value)
                              ? value.join(', ')
                              : typeof value === 'boolean'
                                ? value
                                  ? 'Yes'
                                  : 'No'
                                : String(value)}
                          </dd>
                        </React.Fragment>
                      );
                    })}
                  </dl>
                )}
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title={t('catalog.book.copies')}
              subtitle={t('catalog.book.copiesHint')}
              actions={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setAddCopyOpen(true)}
                  disabled={!!book.archivedAt}
                >
                  + {t('catalog.book.addCopy')}
                </Button>
              }
            />
            <CardBody>
              {book.copies.length === 0 ? (
                <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
                  {t('catalog.book.noCopies')}
                </p>
              ) : (
                <div className="lbr-table-wrap">
                  <table className="lbr-table">
                    <thead>
                      <tr>
                        <th>{t('catalog.book.copyBarcode')}</th>
                        <th>{t('catalog.book.copyStatus')}</th>
                        <th>{t('catalog.book.copyShelf')}</th>
                        <th>{t('catalog.book.print.column')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {book.copies.map((c) => (
                        <tr key={c.id}>
                          <td>{c.barcode}</td>
                          <td>{c.status}</td>
                          <td>{c.shelfLocation ?? '—'}</td>
                          <td>
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={printingCopyId === c.id}
                              onClick={() => printLabel(c.id)}
                            >
                              {t('catalog.book.printLabel')}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        <div>
          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader title={t('catalog.book.cover')} />
            <CardBody>
              <CoverUploader
                slug={slug}
                bookId={book.id}
                coverAssetRef={book.coverAssetRef}
                catalog={catalog}
                locale={locale}
                onChange={(ref) => setBook({ ...book, coverAssetRef: ref })}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t('catalog.book.detailActions')} />
            <CardBody>
              <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
                {book.archivedAt ? (
                  <Button variant="primary" loading={archiveBusy} onClick={restore}>
                    {t('catalog.book.restore')}
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={openArchive}>
                    {t('catalog.book.archive')}
                  </Button>
                )}
              </div>
            </CardBody>
          </Card>
        </div>
      </div>

      <Modal
        open={archiveOpen}
        onClose={closeArchive}
        title={t('catalog.book.archiveConfirmTitle', { title: book.title })}
        role="alertdialog"
        error={archiveError}
        actions={
          <>
            <Button variant="ghost" onClick={closeArchive}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="danger" loading={archiveBusy} onClick={archive}>
              {t('catalog.book.archive')}
            </Button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>{t('catalog.book.archiveConfirmBody')}</p>
      </Modal>

      <AddCopyModal
        open={addCopyOpen}
        onClose={() => setAddCopyOpen(false)}
        slug={slug}
        bookId={book.id}
        catalog={catalog}
        locale={locale}
        onCreated={(copy) => {
          setBook({ ...book, copies: [...book.copies, copy] });
          setAddCopyOpen(false);
        }}
      />
    </>
  );
}

function AddCopyModal({
  open,
  onClose,
  slug,
  bookId,
  catalog,
  locale,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  bookId: string;
  catalog: Catalog;
  locale: Locale;
  onCreated: (copy: BookCopy) => void;
}) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const [barcode, setBarcode] = React.useState('');
  const [shelf, setShelf] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [scanning, setScanning] = React.useState(false);
  // Client-only feature check — gated via state to avoid a hydration mismatch.
  const [canScan, setCanScan] = React.useState(false);
  React.useEffect(() => setCanScan(scanningSupported()), []);

  React.useEffect(() => {
    if (open) {
      setBarcode('');
      setShelf('');
      setError(null);
      setScanning(false);
    }
  }, [open]);

  async function submit() {
    if (!barcode.trim()) {
      setError(t('catalog.book.errors.barcodeRequired'));
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { barcode: barcode.trim() };
      if (shelf.trim()) body.shelfLocation = shelf.trim();
      const created = await api<BookCopy>(`/t/${slug}/catalog/books/${bookId}/copies`, {
        method: 'POST',
        body,
      });
      toast.show({
        severity: 'success',
        title: t('catalog.book.copyAdded'),
        body: created.barcode,
      });
      onCreated(created);
    } catch (err) {
      const message = translateApiError(err, t, t('common.states.error'));
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('catalog.book.addCopy')}
      // frontend-05: the slot, not a hand-rolled Banner in the body. Same
      // critical banner, plus the focus move and the `aria-describedby` link
      // that make a duplicate-barcode refusal announce itself to a screen
      // reader and scroll into view in a body long enough to hide it.
      error={error}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {t('catalog.book.addCopySubmit')}
          </Button>
        </>
      }
    >
      <FormField
        id="copy-barcode"
        label={t('catalog.book.copyBarcode')}
        hint={t('catalog.book.copyBarcodeHint')}
        required
      >
        <Input
          id="copy-barcode"
          spellCheck={false}
          value={barcode}
          onChange={(e) => setBarcode(e.currentTarget.value)}
        />
      </FormField>
      {canScan ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          style={{ marginTop: 'var(--sp-2)' }}
          onClick={() => setScanning(true)}
        >
          {t('catalog.book.copyScan')}
        </Button>
      ) : null}
      <FormField id="copy-shelf" label={t('catalog.book.copyShelf')}>
        <Input value={shelf} onChange={(e) => setShelf(e.currentTarget.value)} />
      </FormField>

      <BarcodeScanner
        open={scanning}
        onClose={() => setScanning(false)}
        formats={SCAN_FORMATS.label}
        title={t('catalog.book.copyScanTitle')}
        catalog={catalog}
        locale={locale}
        onScan={(value) => {
          setBarcode(value.trim());
          setScanning(false);
        }}
      />
    </Modal>
  );
}
