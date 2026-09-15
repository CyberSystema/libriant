'use client';
import * as React from 'react';
import { Button, FormError, FormField, Input, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import {
  SIMPLE_FIELDS,
  canEdit,
  opsForChanges,
  readSimpleFields,
  type SimpleField,
} from '@/lib/marc-simple-fields';

import type { MarcRecord } from '@/lib/marc-simple-fields';

type MarcRecordLike = MarcRecord;

type Props = {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  recordId: string;
  record: MarcRecordLike;
  /** Echoed back as `expectedContentHash`. The read returns it for this. */
  contentHash: string;
  onSaved: (next: { record: MarcRecordLike; contentHash: string }) => void;
  onCancel: () => void;
};

/**
 * The simple editor for the five fields that map to one MARC subfield each
 * (2.0 phase 20j).
 *
 * ## What it is, and what it is not
 *
 * It is the subset of §6 phase 29 the cutover cannot do without: 1.0's book
 * form PATCHes scalar fields at a route the cutover deletes, and without
 * something here a cataloguer could create and delete records but not correct a
 * typo until M5.
 *
 * It is NOT the dual-mode editor. There is no raw MARC pane, no
 * definition-driven positional editor for 006/007/008, and no *Advanced
 * content* panel — all three are phase 29's, and this is deliberately small
 * enough to be deleted when they arrive.
 *
 * ## Why the record and the hash are props
 *
 * The ops carry `from` per op AND the request carries `expectedContentHash`, and
 * the two guard different things. The hash refuses an edit prepared against a
 * different VERSION of the record; `from` refuses an edit prepared against a
 * different VALUE within the version the form read. A form holding a stale
 * record would fail the first; a form that re-read between render and save
 * would pass both and still overwrite somebody — so the record it validates
 * against is the one it displayed, handed in, never re-fetched behind the user.
 *
 * ## Disabled inputs are honest
 *
 * A widget whose FIELD the record does not carry is disabled rather than empty
 * and writable. Creating a 264 from a text box is a cataloguing decision — which
 * indicators, which of RDA's three functions — and accepting a keystroke that
 * cannot be saved is worse than saying so.
 */
export function BibSimpleForm({
  slug,
  catalog,
  locale,
  recordId,
  record,
  contentHash,
  onSaved,
  onCancel,
}: Props) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const initial = React.useMemo(() => readSimpleFields(record as never), [record]);
  const [values, setValues] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => setValues(initial), [initial]);

  const ops = opsForChanges(record as never, initial, values);

  async function save() {
    if (ops.length === 0) {
      // A version with no ops is a version that says nothing happened, and the
      // record's history is the product's memory. Say so rather than write one.
      toast.show({ severity: 'info', title: t('catalog.book.noChanges') });
      onCancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ record: MarcRecordLike; contentHash: string }>(
        `/t/${slug}/catalog/bib/${recordId}`,
        { method: 'PATCH', body: { expectedContentHash: contentHash, ops } },
      );
      toast.show({ severity: 'success', title: t('catalog.book.saved') });
      onSaved(res);
    } catch (err) {
      // A 409 here is the interesting one — somebody else saved while this form
      // was open — and `translateApiError` carries the server's sentence, which
      // names the record rather than the status code.
      setError(translateApiError(err, t, t('common.states.error')));
    } finally {
      setSaving(false);
    }
  }

  const label = (f: SimpleField) =>
    ({
      title: t('catalog.book.titleLabel'),
      edition: t('catalog.book.editionLabel'),
      publisher: t('catalog.book.publisherLabel'),
      publicationYear: t('catalog.book.yearLabel'),
      isbn: t('catalog.book.isbn.label'),
    })[f.key];

  return (
    <div>
      {error ? <FormError>{error}</FormError> : null}
      <div className="lbr-form-grid">
        {SIMPLE_FIELDS.map((f) => {
          const editable = canEdit(record as never, f);
          return (
            <FormField
              key={f.key}
              id={`bib-${f.key}`}
              label={label(f)}
              hint={editable ? undefined : t('catalog.book.fieldNotOnRecord')}
            >
              <Input
                value={values[f.key]}
                disabled={!editable || saving}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.currentTarget.value }))}
              />
            </FormField>
          );
        })}
      </div>

      {/*
        The language is 008/35-37 — three bytes inside a positional control
        field. Editing it needs the positional editor phase 29 designs, and a
        form that wrote three bytes into the middle of an 008 would be the one
        way to corrupt a record silently. Said out loud rather than omitted.
      */}
      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
        {t('catalog.book.fixedFieldsLater')}
      </p>

      <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' }}>
        <Button onClick={save} disabled={saving} variant="primary">
          {t('common.actions.save')}
        </Button>
        <Button onClick={onCancel} disabled={saving} variant="secondary">
          {t('common.actions.cancel')}
        </Button>
      </div>
    </div>
  );
}
