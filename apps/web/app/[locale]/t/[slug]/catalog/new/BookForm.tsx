'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  FormField,
  Input,
  Textarea,
  useToast,
} from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { AuthorPicker } from '@/components/AuthorPicker';
import { DynamicFields, type FieldDef } from '@/components/DynamicFields';

type Author = { id: string; fullName: string };

/** Initial book values for edit mode. Mirrors the API's BookWithCopiesDto. */
export type BookInitial = {
  id: string;
  title: string;
  subtitle: string | null;
  isbn13: string | null;
  isbn10: string | null;
  publicationYear: number | null;
  publisher: string | null;
  language: string | null;
  numPages: number | null;
  description: string | null;
  classification: string | null;
  customFields: Record<string, unknown>;
  authors: Author[];
};

type Props = {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  customFields: FieldDef[];
  /** Used by the onboarding wizard to return to itself after success. */
  returnTo?: string;
  /** When set, the form is in edit mode — pre-filled + PATCHes on submit. */
  initial?: BookInitial;
  /** Called after a successful PATCH so the detail page can swap back to view mode. */
  onSaved?: (next: BookInitial) => void;
  cancelHref?: string;
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

/**
 * Add-book form. The librarian's most common path is:
 *
 *   1. Type / scan an ISBN → "Look it up" hits OpenLibrary; on hit the
 *      title / authors / year / publisher are pre-filled. Authors that
 *      aren't on file yet are created via the AuthorPicker's inline flow.
 *   2. (Or skip ISBN entirely and fill in by hand.)
 *   3. Add custom fields if the library has defined any.
 *   4. Submit → POST /catalog/books → redirect to the book detail page
 *      (or back to the onboarding wizard if that's where we came from).
 *
 * Plan-gated quotas (`max_books`) and friendly per-field validation come
 * back from the API; both are mapped onto specific inputs where we can.
 */
export function BookForm({
  slug,
  catalog,
  locale,
  customFields,
  returnTo,
  initial,
  onSaved,
  cancelHref,
}: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const isEdit = !!initial;

  const [isbn, setIsbn] = React.useState(initial?.isbn13 ?? initial?.isbn10 ?? '');
  const [lookingUp, setLookingUp] = React.useState(false);
  const [lookupError, setLookupError] = React.useState<string | null>(null);

  const [title, setTitle] = React.useState(initial?.title ?? '');
  const [subtitle, setSubtitle] = React.useState(initial?.subtitle ?? '');
  const [authors, setAuthors] = React.useState<Author[]>(initial?.authors ?? []);
  const [publicationYear, setPublicationYear] = React.useState(
    initial?.publicationYear ? String(initial.publicationYear) : '',
  );
  const [publisher, setPublisher] = React.useState(initial?.publisher ?? '');
  const [language, setLanguage] = React.useState(
    initial?.language ?? (locale === 'el' ? 'el' : 'en'),
  );
  const [numPages, setNumPages] = React.useState(initial?.numPages ? String(initial.numPages) : '');
  const [description, setDescription] = React.useState(initial?.description ?? '');
  const [classification, setClassification] = React.useState(initial?.classification ?? '');
  const [customValues, setCustomValues] = React.useState<Record<string, unknown>>(
    initial?.customFields ?? {},
  );

  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function lookupIsbn() {
    const cleaned = isbn.replace(/[\s-]/g, '');
    if (cleaned.length < 10) {
      setLookupError(t('catalog.book.isbnTooShort'));
      return;
    }
    setLookingUp(true);
    setLookupError(null);
    try {
      const result = await api<IsbnLookupResult>(
        `/t/${slug}/catalog/isbn/${encodeURIComponent(cleaned)}`,
      );
      if (result.title) setTitle(result.title);
      if (result.subtitle) setSubtitle(result.subtitle);
      if (result.publicationYear) setPublicationYear(String(result.publicationYear));
      if (result.publisher) setPublisher(result.publisher);
      if (result.numPages) setNumPages(String(result.numPages));
      if (result.language) setLanguage(result.language);

      // Auto-create authors that aren't picked yet. Best-effort: if any
      // creation fails we still apply the rest.
      if (result.authors && result.authors.length) {
        const created: Author[] = [];
        for (const a of result.authors) {
          if (!a.fullName) continue;
          try {
            const row = await api<Author>(`/t/${slug}/catalog/authors`, {
              method: 'POST',
              body: { fullName: a.fullName },
            });
            created.push(row);
          } catch {
            // 409 means the author already exists — search for them so
            // the picker can still include them.
            try {
              const matches = await api<{ items: Author[] }>(
                `/t/${slug}/catalog/authors?q=${encodeURIComponent(a.fullName)}&limit=1`,
              );
              if (matches.items[0]) created.push(matches.items[0]);
            } catch {
              /* ignore — librarian can pick the author manually */
            }
          }
        }
        if (created.length) {
          setAuthors((prev) => {
            const seen = new Set(prev.map((p) => p.id));
            return [...prev, ...created.filter((a) => !seen.has(a.id))];
          });
        }
      }
      toast.show({ severity: 'success', title: t('catalog.book.isbnFound') });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setLookupError(t('catalog.book.isbnNotFound'));
      } else {
        setLookupError(err instanceof ApiError ? err.message : t('common.states.error'));
      }
    } finally {
      setLookingUp(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validation: Record<string, string> = {};
    if (!title.trim()) validation.title = t('catalog.book.errors.titleRequired');
    if (Object.keys(validation).length) {
      setErrors(validation);
      setFormError(t('catalog.book.errors.checkFields'));
      return;
    }
    setErrors({});
    setFormError(null);
    setSubmitting(true);

    const payload: Record<string, unknown> = {
      title: title.trim(),
      authors: authors.map((a, ix) => ({ authorId: a.id, order: ix })),
    };
    const applyText = (key: string, value: string) => {
      const trimmed = value.trim();
      if (trimmed.length) payload[key] = trimmed;
      else if (isEdit) payload[key] = null;
    };
    applyText('subtitle', subtitle);
    const cleanedIsbn = isbn.replace(/[\s-]/g, '');
    if (cleanedIsbn.length === 13) payload.isbn13 = cleanedIsbn;
    else if (cleanedIsbn.length === 10) payload.isbn10 = cleanedIsbn;
    else if (isEdit) {
      payload.isbn13 = null;
      payload.isbn10 = null;
    }
    if (publicationYear) payload.publicationYear = Number(publicationYear);
    else if (isEdit) payload.publicationYear = null;
    applyText('publisher', publisher);
    applyText('language', language);
    if (numPages) payload.numPages = Number(numPages);
    else if (isEdit) payload.numPages = null;
    applyText('description', description);
    applyText('classification', classification);
    if (Object.keys(customValues).length || isEdit) payload.customFields = customValues;

    try {
      if (isEdit) {
        const updated = await api<BookInitial>(`/t/${slug}/catalog/books/${initial!.id}`, {
          method: 'PATCH',
          body: payload,
        });
        toast.show({
          severity: 'success',
          title: t('catalog.book.updateSuccess'),
          body: updated.title,
        });
        onSaved?.(updated);
        router.refresh();
        return;
      }
      const created = await api<{ id: string; title: string }>(`/t/${slug}/catalog/books`, {
        method: 'POST',
        body: payload,
      });
      toast.show({
        severity: 'success',
        title: t('catalog.book.createSuccess'),
        body: created.title,
      });
      router.push(returnTo ?? `/${locale}/t/${slug}/catalog/${created.id}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 402) {
          setFormError(
            `${err.body.message} (${err.body.feature}: ${err.body.used}/${err.body.limit}).`,
          );
        } else {
          const message = Array.isArray(err.body.message)
            ? err.body.message.join(' ')
            : (err.body.message ?? t('common.states.error'));
          if (/isbn/i.test(message)) setErrors({ isbn13: message });
          else if (/title/i.test(message)) setErrors({ title: message });
          else setFormError(message);
        }
      } else {
        setFormError(t('common.states.error'));
      }
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {formError ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {formError}
        </Banner>
      ) : null}

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title={t('catalog.book.isbn.section')} subtitle={t('catalog.book.isbn.hint')} />
        <CardBody>
          <div
            style={{
              display: 'flex',
              gap: 'var(--sp-2)',
              alignItems: 'flex-end',
              flexWrap: 'wrap',
            }}
          >
            <FormField
              id="book-isbn"
              label={t('catalog.book.isbn.label')}
              error={errors.isbn13 ?? lookupError ?? undefined}
              className="lbr-isbn-field"
            >
              <Input
                id="book-isbn"
                value={isbn}
                onChange={(e) => {
                  setIsbn(e.currentTarget.value);
                  setLookupError(null);
                }}
                placeholder="978-…"
              />
            </FormField>
            <div style={{ marginBottom: 'var(--sp-4)' }}>
              <Button
                type="button"
                variant="secondary"
                loading={lookingUp}
                onClick={lookupIsbn}
                disabled={!isbn.trim()}
              >
                {t('catalog.book.isbn.lookup')}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title={t('catalog.book.identity')} />
        <CardBody>
          <FormField
            id="book-title"
            label={t('catalog.book.titleLabel')}
            required
            error={errors.title}
          >
            <Input
              id="book-title"
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
            />
          </FormField>
          <FormField id="book-subtitle" label={t('catalog.book.subtitleLabel')}>
            <Input
              id="book-subtitle"
              value={subtitle}
              onChange={(e) => setSubtitle(e.currentTarget.value)}
            />
          </FormField>
          <FormField id="book-authors" label={t('catalog.book.authorsLabel')}>
            <AuthorPicker
              slug={slug}
              catalog={catalog}
              locale={locale}
              value={authors}
              onChange={setAuthors}
            />
          </FormField>
        </CardBody>
      </Card>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title={t('catalog.book.publication')} />
        <CardBody>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 'var(--sp-3)',
            }}
          >
            <FormField id="book-year" label={t('catalog.book.yearLabel')}>
              <Input
                type="number"
                value={publicationYear}
                onChange={(e) => setPublicationYear(e.currentTarget.value)}
              />
            </FormField>
            <FormField id="book-pages" label={t('catalog.book.pagesLabel')}>
              <Input
                type="number"
                value={numPages}
                onChange={(e) => setNumPages(e.currentTarget.value)}
              />
            </FormField>
          </div>
          <FormField id="book-publisher" label={t('catalog.book.publisherLabel')}>
            <Input value={publisher} onChange={(e) => setPublisher(e.currentTarget.value)} />
          </FormField>
          <FormField
            id="book-language"
            label={t('catalog.book.languageLabel')}
            hint={t('catalog.book.languageHint')}
          >
            <Input
              value={language}
              onChange={(e) => setLanguage(e.currentTarget.value)}
              maxLength={10}
              spellCheck={false}
            />
          </FormField>
          <FormField id="book-class" label={t('catalog.book.classificationLabel')}>
            <Input
              value={classification}
              onChange={(e) => setClassification(e.currentTarget.value)}
            />
          </FormField>
          <FormField id="book-desc" label={t('catalog.book.descriptionLabel')}>
            <Textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
            />
          </FormField>
        </CardBody>
      </Card>

      {customFields.length > 0 ? (
        <Card style={{ marginBottom: 'var(--sp-4)' }}>
          <CardHeader title={t('catalog.book.customFields')} />
          <CardBody>
            <DynamicFields
              fields={customFields}
              locale={locale}
              values={customValues}
              onChange={setCustomValues}
              errors={errors}
              idPrefix="book-cf"
            />
          </CardBody>
        </Card>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
        <Link
          href={cancelHref ?? `/${locale}/t/${slug}/catalog`}
          className="lbr-btn lbr-btn--ghost lbr-btn--md"
        >
          {t('common.actions.cancel')}
        </Link>
        <Button type="submit" variant="primary" loading={submitting}>
          {isEdit ? t('common.actions.save') : t('catalog.book.submit')}
        </Button>
      </div>
    </form>
  );
}
