'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, CardHeader, Input, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { API_JOB_TIMEOUT_MS, api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import { dataPort } from '@/lib/ports';

const DEFAULT_SWATCH = '#1f6feb';

export function BrandingForm({
  slug,
  locale,
  catalog,
  brandColor,
  brandLogoRef,
}: {
  slug: string;
  locale: Locale;
  catalog: Catalog;
  brandColor: string | null;
  brandLogoRef: string | null;
}) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const router = useRouter();
  const [color, setColor] = React.useState(brandColor ?? DEFAULT_SWATCH);
  const [logoRef, setLogoRef] = React.useState(brandLogoRef);
  const [busy, setBusy] = React.useState(false);

  const logoUrl = logoRef ? dataPort().resourceUrl(`/t/${slug}/storage/${logoRef}`) : null;

  const fail = (err: unknown) =>
    toast.show({
      severity: 'critical',
      title: translateApiError(err, t, t('common.states.error')),
    });

  async function saveColor(value: string | null) {
    setBusy(true);
    try {
      await api(`/t/${slug}/branding`, { method: 'PATCH', body: { brandColor: value } });
      toast.show({ severity: 'success', title: t('settings.branding.saved') });
      router.refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function onLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const json = await dataPort().upload<{ brandLogoRef: string }>(
        `/t/${slug}/branding/logo`,
        { file: { name: file.name, type: file.type, data: file } },
        { timeoutMs: API_JOB_TIMEOUT_MS },
      );
      setLogoRef(json.brandLogoRef);
      toast.show({ severity: 'success', title: t('settings.branding.logoUploaded') });
      router.refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function removeLogo() {
    setBusy(true);
    try {
      await dataPort().delete(`/t/${slug}/branding/logo`);
      setLogoRef(null);
      toast.show({ severity: 'success', title: t('settings.branding.logoRemoved') });
      router.refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)', maxWidth: 640 }}>
      <Card>
        <CardHeader
          title={t('settings.branding.color.title')}
          subtitle={t('settings.branding.color.desc')}
        />
        <CardBody>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 'var(--sp-3)',
              flexWrap: 'wrap',
            }}
          >
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label={t('settings.branding.color.title')}
              style={{ width: 56, height: 40, padding: 0, border: 'none', background: 'none' }}
            />
            <div style={{ width: 120 }}>
              <Input value={color} onChange={(e) => setColor(e.target.value)} />
            </div>
            <Button
              variant="primary"
              loading={busy}
              disabled={busy}
              onClick={() => saveColor(color)}
            >
              {t('settings.branding.color.save')}
            </Button>
            {brandColor ? (
              <Button variant="ghost" disabled={busy} onClick={() => saveColor(null)}>
                {t('settings.branding.color.reset')}
              </Button>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t('settings.branding.logo.title')}
          subtitle={t('settings.branding.logo.desc')}
        />
        <CardBody>
          {logoUrl ? (
            <div style={{ marginBottom: 'var(--sp-3)' }}>
              <img
                src={logoUrl}
                alt={t('settings.branding.logo.title')}
                style={{
                  maxHeight: 56,
                  maxWidth: 220,
                  objectFit: 'contain',
                  background: 'var(--color-surface-muted)',
                  padding: 'var(--sp-2)',
                  borderRadius: 'var(--radius-md)',
                }}
              />
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
            <label className="lbr-btn lbr-btn--secondary lbr-btn--md" style={{ cursor: 'pointer' }}>
              {t('settings.branding.logo.upload')}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={onLogoFile}
                disabled={busy}
                style={{ display: 'none' }}
              />
            </label>
            {logoRef ? (
              <Button variant="ghost" disabled={busy} onClick={removeLogo}>
                {t('settings.branding.logo.remove')}
              </Button>
            ) : null}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
