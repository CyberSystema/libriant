'use client';
import * as React from 'react';
import { Button, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';

type Props = {
  slug: string;
  bookId: string;
  coverAssetRef: string | null;
  catalog: Catalog;
  locale: Locale;
  onChange: (next: string | null) => void;
};

/**
 * Book-cover upload widget. POSTs multipart to
 * `/t/:slug/catalog/books/:id/cover` and DELETEs to clear. Preview
 * renders the current cover via the storage controller URL.
 */
export function CoverUploader({ slug, bookId, coverAssetRef, catalog, locale, onChange }: Props) {
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
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await fetch(`/lbr-api/t/${slug}/catalog/books/${bookId}/cover`, {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body);
      }
      const json = (await res.json()) as { coverAssetRef: string };
      onChange(json.coverAssetRef);
      toast.show({ severity: 'success', title: t('catalog.book.coverUploaded') });
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : t('common.states.error'),
      });
    } finally {
      setUploading(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      await api(`/t/${slug}/catalog/books/${bookId}/cover`, { method: 'DELETE' });
      onChange(null);
      toast.show({ severity: 'success', title: t('catalog.book.coverRemoved') });
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : t('common.states.error'),
      });
    } finally {
      setRemoving(false);
    }
  }

  const coverUrl = coverAssetRef ? `/lbr-api/t/${slug}/storage/${coverAssetRef}` : null;

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
