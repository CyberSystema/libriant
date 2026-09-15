'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, FormError, FormField, Input, Textarea, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { dataPort } from '@/lib/ports';
import { translateApiError } from '@/lib/api-errors';
import { useIdempotencyKey } from '@/lib/useIdempotencyKey';
import { BarcodeScanner, SCAN_FORMATS, scanningSupported } from '@/components/BarcodeScanner';
import {
  EMPTY_BOOK,
  recordFromBook,
  type BookFields,
  type CatalogTemplate,
} from '@/lib/marc-from-template';

type Props = {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  /** Served by `GET /t/:slug/catalog/templates`; null when that read failed. */
  template: CatalogTemplate | null;
};

type IsbnLookupResult = {
  title?: string;
  subtitle?: string;
  authors?: Array<{ fullName: string }>;
  publisher?: string;
  publicationYear?: number;
  numPages?: number;
  language?: string;
};

type CreateResponse = { recordId: string; needsReview: boolean };

/**
 * Catalogue a new book, on the 2.0 write surface (phase 20l).
 *
 * ## It posts a RECORD, because that is what the route takes
 *
 * 1.0's form POSTed scalars to `/catalog/books` and the server assembled a row.
 * `POST /catalog/bib` takes `{leader, fields}` — a whole MARC record — and the
 * create DTO says why: the shape is "the same shape `packages/marc` reads and
 * writes, so a record can be posted straight from an import or a Z39.50
 * response without a translation layer that could lose subfield order".
 *
 * So this form fills a TEMPLATE served by the API rather than composing a
 * record of its own. See `lib/marc-from-template.ts` for why that distinction
 * is load-bearing rather than tidy.
 *
 * ## What it does not offer, and why each absence is a decision
 *
 *   - **One contributor, not many.** The template offers 700 and this form
 *     leaves it empty: a repeatable heading with its own relator needs the
 *     editor phase 29 designs, and there is no authority store to resolve a
 *     name against until phase 45. 1.0 created author ROWS; 2.0 has no author
 *     entity at all, which the 20h divergence entry records as having no 2.0
 *     equivalent and no way to get one sooner.
 *   - **No custom fields.** `bib_records.custom_fields` survives re-projection
 *     and nothing writes it, no route reads it, and the v2 importer errors on a
 *     book row carrying one. A card labelled from a 1.0 definition list over a
 *     column nothing can fill would be a screen showing a thing that cannot
 *     exist (recorded in the 20k entry).
 *   - **No coded values beyond year and language.** The rest of the 008 is
 *     forty positional bytes, and a form that wrote them without the positional
 *     editor would be the one way to corrupt a record silently.
 */
export function BibCreateForm({ slug, catalog, locale, template }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = React.useState<BookFields>(EMPTY_BOOK);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lookingUp, setLookingUp] = React.useState(false);
  const [lookupNote, setLookupNote] = React.useState<string | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [canScan, setCanScan] = React.useState(false);
  React.useEffect(() => setCanScan(scanningSupported()), []);
  /**
   * ONE key for one logical "catalogue this book".
   *
   * `POST /catalog/bib` mounts `IdempotencyInterceptor`, and this form emits no
   * 001 — so `marc_records_control_number_unique_active`, which only constrains
   * records that HAVE a control number, cannot catch a duplicate. Without the
   * key a double-click or a retry after the 10 s client deadline produces two
   * identical catalogue records and nothing notices.
   */
  const idem = useIdempotencyKey();

  const set = (k: keyof BookFields) => (v: string) => setValues((s) => ({ ...s, [k]: v }));

  async function lookupIsbn() {
    const cleaned = values.isbn.replace(/[\s-]/g, '');
    if (cleaned.length < 10) {
      setLookupNote(t('catalog.book.isbnTooShort'));
      return;
    }
    setLookingUp(true);
    setLookupNote(null);
    try {
      const r = await dataPort().get<IsbnLookupResult>(
        `/t/${slug}/catalog/isbn-lookup/${encodeURIComponent(cleaned)}`,
      );
      setValues((s) => ({
        ...s,
        title: r.title ?? s.title,
        subtitle: r.subtitle ?? s.subtitle,
        publisher: r.publisher ?? s.publisher,
        publicationYear: r.publicationYear ? String(r.publicationYear) : s.publicationYear,
        extent: r.numPages ? t('catalog.book.pagesExtent', { count: r.numPages }) : s.extent,
        // The FIRST name only, and into 100. 1.0 created a row per author; 2.0
        // has no author entity, so the rest would have nowhere to go and a
        // silently dropped contributor is worse than one the cataloguer adds.
        author: r.authors?.[0]?.fullName ?? s.author,
      }));
      setLookupNote(
        r.title
          ? r.authors && r.authors.length > 1
            ? t('catalog.book.isbnFoundExtraAuthors', { count: r.authors.length - 1 })
            : t('catalog.book.isbnFound')
          : t('catalog.book.isbnNotFound'),
      );
    } catch {
      setLookupNote(t('catalog.book.isbnNotFound'));
    } finally {
      setLookingUp(false);
    }
  }

  async function submit() {
    if (!template) return;
    if (values.title.trim() === '') {
      setError(t('catalog.book.errors.titleRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { record, isbn } = recordFromBook(template, values, new Date());
      const created = await dataPort().post<CreateResponse>(
        `/t/${slug}/catalog/bib`,
        { ...record, kind: 'bibliographic', schema: 'marc21' },
        { idempotencyKey: idem.key },
      );
      idem.rotate();
      // A bad check digit is a fact, not a refusal — the record is saved and
      // the cataloguer is told, because §5 makes no identifier a constraint.
      toast.show({
        severity: isbn && !isbn.valid ? 'warning' : 'success',
        title: t('catalog.book.createSuccess'),
        body: isbn && !isbn.valid ? t('catalog.book.isbnCheckDigit') : undefined,
      });
      router.push(`/${locale}/t/${slug}/catalog/${created.recordId}`);
    } catch (err) {
      setError(translateApiError(err, t, t('common.states.error')));
      setBusy(false);
    }
  }

  if (!template) {
    // No template, no honest form: without it this screen would have to invent
    // a leader and a field set, which is exactly what serving the template
    // exists to prevent.
    return <Banner severity="critical">{t('catalog.book.templateUnavailable')}</Banner>;
  }

  const text = (key: keyof BookFields, label: string, hint?: string) => (
    <FormField id={`bib-${key}`} label={label} hint={hint}>
      <Input value={values[key]} onChange={(e) => set(key)(e.currentTarget.value)} />
    </FormField>
  );

  return (
    <div>
      {error ? <FormError>{error}</FormError> : null}

      <FormField
        id="bib-isbn"
        label={t('catalog.book.isbn.label')}
        hint={t('catalog.book.isbn.hint')}
      >
        <Input
          spellCheck={false}
          value={values.isbn}
          onChange={(e) => set('isbn')(e.currentTarget.value)}
        />
      </FormField>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', marginBottom: 'var(--sp-3)' }}>
        <Button variant="secondary" size="sm" loading={lookingUp} onClick={lookupIsbn}>
          {t('catalog.book.isbn.lookup')}
        </Button>
        {canScan ? (
          <Button variant="ghost" size="sm" onClick={() => setScanning(true)}>
            {t('catalog.book.isbn.scan')}
          </Button>
        ) : null}
      </div>
      {lookupNote ? (
        <Banner severity="info" style={{ marginBottom: 'var(--sp-3)' }}>
          {lookupNote}
        </Banner>
      ) : null}

      <div className="lbr-form-grid">
        <FormField id="bib-title" label={t('catalog.book.titleLabel')} required>
          <Input value={values.title} onChange={(e) => set('title')(e.currentTarget.value)} />
        </FormField>
        {text('subtitle', t('catalog.book.subtitleLabel'))}
        {text(
          'statementOfResponsibility',
          t('catalog.book.statementLabel'),
          t('catalog.book.statementHint'),
        )}
        {text('author', t('catalog.book.mainEntryLabel'), t('catalog.book.mainEntryHint'))}
        {text('authorDates', t('catalog.book.mainEntryDatesLabel'))}
        {text('edition', t('catalog.book.editionLabel'))}
        {text('place', t('catalog.book.placeLabel'))}
        {text('publisher', t('catalog.book.publisherLabel'))}
        {text('publicationYear', t('catalog.book.yearLabel'))}
        {text('extent', t('catalog.book.extentLabel'), t('catalog.book.extentHint'))}
        {text('language', t('catalog.book.languageLabel'), t('catalog.book.language639Hint'))}
        {text('subject', t('catalog.book.subjectLabel'))}
      </div>

      <FormField id="bib-note" label={t('catalog.book.noteLabel')}>
        <Textarea
          rows={3}
          value={values.note}
          onChange={(e) => set('note')(e.currentTarget.value)}
        />
      </FormField>

      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
        {t('catalog.book.oneContributorOnly')}
      </p>

      <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' }}>
        <Button variant="primary" loading={busy} onClick={submit}>
          {t('catalog.book.submit')}
        </Button>
      </div>

      <BarcodeScanner
        open={scanning}
        onClose={() => setScanning(false)}
        formats={SCAN_FORMATS.isbn}
        title={t('catalog.book.isbn.scanTitle')}
        catalog={catalog}
        locale={locale}
        onScan={(value) => {
          setValues((s) => ({ ...s, isbn: value.trim() }));
          setScanning(false);
        }}
      />
    </div>
  );
}
