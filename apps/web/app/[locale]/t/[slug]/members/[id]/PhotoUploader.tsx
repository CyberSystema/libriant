'use client';
import * as React from 'react';
import { Button, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { API_JOB_TIMEOUT_MS, ApiError, api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';

type Props = {
  slug: string;
  memberId: string;
  photoAssetRef: string | null;
  catalog: Catalog;
  locale: Locale;
  onChange: (next: string | null) => void;
};

/**
 * Photo upload widget. POSTs a multipart form to
 * `/t/:slug/members/:id/photo` (the existing MemberPhotosController) and
 * DELETEs to clear. Previews the current photo via the `<Asset>` slot
 * URL pattern when one is set.
 */
export function PhotoUploader({ slug, memberId, photoAssetRef, catalog, locale, onChange }: Props) {
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
      // We bypass `api()` here because multipart upload doesn't go through
      // the JSON wrapper. The browser sets the right Content-Type with the
      // boundary; we just hand off the FormData.
      const res = await fetch(`/lbr-api/t/${slug}/members/${memberId}/photo`, {
        method: 'POST',
        body: form,
        credentials: 'include',
        // Multipart bypasses `api()` and therefore its deadline; set one here.
        signal: AbortSignal.timeout(API_JOB_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body);
      }
      const json = (await res.json()) as { photoAssetRef: string };
      onChange(json.photoAssetRef);
      toast.show({ severity: 'success', title: t('members.detail.photoUploaded') });
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
      await api(`/t/${slug}/members/${memberId}/photo`, { method: 'DELETE' });
      onChange(null);
      toast.show({ severity: 'success', title: t('members.detail.photoRemoved') });
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: translateApiError(err, t, t('common.states.error')),
      });
    } finally {
      setRemoving(false);
    }
  }

  // photoAssetRef is `members/<filename>`; the storage controller serves
  // it at `/t/:slug/storage/:resourceType/:filename`. We hit it through
  // the same-origin proxy so cookies travel.
  const photoUrl = photoAssetRef ? `/lbr-api/t/${slug}/storage/${photoAssetRef}` : null;

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--sp-3)' }}
    >
      <div
        style={{
          width: 160,
          height: 160,
          borderRadius: '50%',
          background: 'var(--color-surface-muted)',
          border: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {photoUrl ? (
          <img
            src={photoUrl}
            alt={t('members.detail.photo')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span aria-hidden style={{ fontSize: '3rem', color: 'var(--color-text-muted)' }}>
            ☻
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
          {photoAssetRef ? t('members.detail.changePhoto') : t('members.detail.uploadPhoto')}
        </Button>
        {photoAssetRef ? (
          <Button variant="ghost" size="sm" loading={removing} onClick={remove}>
            {t('common.actions.delete')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
