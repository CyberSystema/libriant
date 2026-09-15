'use client';
import * as React from 'react';
import { Button, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { API_JOB_TIMEOUT_MS } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import { dataPort } from '@/lib/ports';

type Props = {
  slug: string;
  recordId: string;
  coverAssetRef: string | null;
  catalog: Catalog;
  locale: Locale;
  onChange: (next: string | null) => void;
};

/**
 * Cover upload widget. POSTs multipart to `/t/:slug/catalog/bib/:id/cover` and
 * DELETEs to clear. Preview renders the current cover via the storage
 * controller URL.
 *
 * The 2.0 route (phase 20b-ii) writes `bib_records.cover_asset_ref`, which
 * `BibProjectionService` explicitly PRESERVES rather than recomputing — a cover
 * is not in the MARC, it is a thing the library attached — so re-cataloguing a
 * record does not lose its cover. Reading it back is newer than writing it:
 * until phase 20k nothing returned the column, so a cover could be uploaded and
 * then never shown again.
 */
export function CoverUploader({ slug, recordId, coverAssetRef, catalog, locale, onChange }: Props) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const json = await dataPort().upload<{ coverAssetRef: string }>(
        `/t/${slug}/catalog/bib/${recordId}/cover`,
        { file: { name: file.name, type: file.type, data: file } },
        { timeoutMs: API_JOB_TIMEOUT_MS },
      );
      onChange(json.coverAssetRef);
      toast.show({ severity: 'success', title: t('catalog.book.coverUploaded') });
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: translateApiError(err, t, t('common.states.error')),
      });
    } finally {
      setUploading(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      await dataPort().delete(`/t/${slug}/catalog/bib/${recordId}/cover`);
      onChange(null);
      toast.show({ severity: 'success', title: t('catalog.book.coverRemoved') });
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: translateApiError(err, t, t('common.states.error')),
      });
    } finally {
      setRemoving(false);
    }
  }

  const coverUrl = coverAssetRef
    ? dataPort().resourceUrl(`/t/${slug}/storage/${coverAssetRef}`)
    : null;

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--sp-3)' }}
    >
      <div
        style={{
          width: 160,
          height: 230,
          background: 'var(--color-surface-muted)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={t('catalog.book.cover')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span aria-hidden style={{ fontSize: '2.5rem', color: 'var(--color-text-muted)' }}>
            📖
          </span>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={onFile}
        style={{ display: 'none' }}
      />
      <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
        <Button
          variant="secondary"
          size="sm"
          loading={uploading}
          onClick={() => inputRef.current?.click()}
        >
          {coverAssetRef ? t('catalog.book.changeCover') : t('catalog.book.uploadCover')}
        </Button>
        {coverAssetRef ? (
          <Button variant="ghost" size="sm" loading={removing} onClick={remove}>
            {t('common.actions.delete')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
