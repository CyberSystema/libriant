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
  Textarea,
} from '@libriant/ui';
import { createTranslator, type Catalog, type Locale } from '@libriant/i18n';
import { LIBRARY_TYPES } from '@libriant/shared/library';
import { ApiError, api } from '@/lib/api';

export type LibraryProfile = {
  id: string;
  slug: string;
  name: string;
  libraryType: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressPostalCode: string | null;
  addressRegion: string | null;
  addressCountry: string | null;
  publicPhone: string | null;
  publicEmail: string | null;
  website: string | null;
  description: string | null;
  foundedYear: number | null;
};
type PendingRequest = {
  id: string;
  proposedJson: Record<string, unknown>;
  requestNote: string | null;
  createdAt: string;
} | null;
export type LibraryProfileView = { profile: LibraryProfile; pendingRequest: PendingRequest };

export function LibraryProfileForm({
  initial,
  catalog,
  locale,
  slug,
}: {
  initial: LibraryProfileView;
  catalog: Catalog;
  locale: Locale;
  slug: string;
}) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const p = initial.profile;

  // Free fields — editable directly.
  const [phone, setPhone] = React.useState(p.publicPhone ?? '');
  const [email, setEmail] = React.useState(p.publicEmail ?? '');
  const [website, setWebsite] = React.useState(p.website ?? '');
  const [foundedYear, setFoundedYear] = React.useState(p.foundedYear?.toString() ?? '');
  const [description, setDescription] = React.useState(p.description ?? '');
  const [savingFree, setSavingFree] = React.useState(false);
  const [freeMsg, setFreeMsg] = React.useState<string | null>(null);

  // Core change request.
  const pending = initial.pendingRequest;
  const [requesting, setRequesting] = React.useState(false);
  const [name, setName] = React.useState(p.name);
  const [type, setType] = React.useState(p.libraryType ?? '');
  const [street, setStreet] = React.useState(p.addressStreet ?? '');
  const [city, setCity] = React.useState(p.addressCity ?? '');
  const [postal, setPostal] = React.useState(p.addressPostalCode ?? '');
  const [region, setRegion] = React.useState(p.addressRegion ?? '');
  const [country, setCountry] = React.useState(p.addressCountry ?? '');
  const [note, setNote] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [coreErr, setCoreErr] = React.useState<string | null>(null);

  async function saveFree(e: React.FormEvent) {
    e.preventDefault();
    setSavingFree(true);
    setFreeMsg(null);
    try {
      await api(`/t/${slug}/library`, {
        method: 'PATCH',
        body: {
          publicPhone: phone || null,
          publicEmail: email || null,
          website: website || null,
          foundedYear: foundedYear ? Number(foundedYear) : null,
          description: description || null,
        },
      });
      setFreeMsg(t('library.profile.contactSaved'));
      router.refresh();
    } catch (err) {
      setFreeMsg(err instanceof ApiError ? err.message : t('library.errors.requestFailed'));
    } finally {
      setSavingFree(false);
    }
  }

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setCoreErr(null);
    try {
      await api(`/t/${slug}/library/requests`, {
        method: 'POST',
        body: {
          name,
          libraryType: type || undefined,
          addressStreet: street,
          addressCity: city,
          addressPostalCode: postal,
          addressRegion: region,
          addressCountry: country,
          requestNote: note || undefined,
        },
      });
      setRequesting(false);
      router.refresh();
    } catch (err) {
      setCoreErr(err instanceof ApiError ? err.message : t('library.errors.requestFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelRequest() {
    if (!pending) return;
    try {
      await api(`/t/${slug}/library/requests/${pending.id}/cancel`, { method: 'POST' });
      router.refresh();
    } catch {
      /* surfaced on next load */
    }
  }

  const dash = (v: string | number | null) =>
    v === null || v === '' ? <em>{t('library.profile.notProvided')}</em> : String(v);

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
      {/* ---- Core (identity + location) — read-only, change via request ---- */}
      <Card>
        <CardHeader title={t('library.core.title')} subtitle={t('library.core.locked')} />
        <CardBody>
          <dl className="lbr-deflist">
            <dt>{t('library.field.name')}</dt>
            <dd>{p.name}</dd>
            <dt>{t('library.field.type')}</dt>
            <dd>{p.libraryType ? t(`library.type.${p.libraryType}`) : dash(null)}</dd>
            <dt>{t('library.field.street')}</dt>
            <dd>{dash(p.addressStreet)}</dd>
            <dt>{t('library.field.city')}</dt>
            <dd>{dash(p.addressCity)}</dd>
            <dt>{t('library.field.postalCode')}</dt>
            <dd>{dash(p.addressPostalCode)}</dd>
            <dt>{t('library.field.region')}</dt>
            <dd>{dash(p.addressRegion)}</dd>
            <dt>{t('library.field.country')}</dt>
            <dd>{dash(p.addressCountry)}</dd>
          </dl>

          {pending ? (
            <Banner severity="info" style={{ marginTop: 'var(--sp-3)' }}>
              {t('library.core.pending')}{' '}
              {t('library.core.pendingFields', {
                fields: Object.keys(pending.proposedJson).join(', '),
              })}
              <div style={{ marginTop: 'var(--sp-2)' }}>
                <Button size="sm" variant="ghost" onClick={cancelRequest}>
                  {t('library.core.cancel')}
                </Button>
              </div>
            </Banner>
          ) : requesting ? (
            <form onSubmit={submitRequest} style={{ marginTop: 'var(--sp-3)' }}>
              {coreErr ? (
                <Banner severity="critical" style={{ marginBottom: 'var(--sp-3)' }}>
                  {coreErr}
                </Banner>
              ) : null}
              <FormField id="lp-name" label={t('library.field.name')}>
                <Input value={name} onChange={(e) => setName(e.currentTarget.value)} />
              </FormField>
              <FormField id="lp-type" label={t('library.field.type')}>
                <select
                  className="lbr-input"
                  value={type}
                  onChange={(e) => setType(e.currentTarget.value)}
                >
                  <option value="">—</option>
                  {LIBRARY_TYPES.map((ty) => (
                    <option key={ty} value={ty}>
                      {t(`library.type.${ty}`)}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField id="lp-street" label={t('library.field.street')}>
                <Input value={street} onChange={(e) => setStreet(e.currentTarget.value)} />
              </FormField>
              <div className="lbr-form-grid">
                <FormField id="lp-city" label={t('library.field.city')}>
                  <Input value={city} onChange={(e) => setCity(e.currentTarget.value)} />
                </FormField>
                <FormField id="lp-postal" label={t('library.field.postalCode')}>
                  <Input value={postal} onChange={(e) => setPostal(e.currentTarget.value)} />
                </FormField>
                <FormField id="lp-region" label={t('library.field.region')}>
                  <Input value={region} onChange={(e) => setRegion(e.currentTarget.value)} />
                </FormField>
                <FormField id="lp-country" label={t('library.field.country')}>
                  <Input
                    maxLength={2}
                    value={country}
                    onChange={(e) => setCountry(e.currentTarget.value.toUpperCase())}
                  />
                </FormField>
              </div>
              <FormField id="lp-note" label={t('library.core.requestNote')}>
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
              </FormField>
              <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
                <Button type="submit" loading={submitting}>
                  {t('library.core.submit')}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setRequesting(false)}>
                  {t('library.core.cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <div style={{ marginTop: 'var(--sp-3)' }}>
              <Button variant="secondary" onClick={() => setRequesting(true)}>
                {t('library.core.request')}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      {/* ---- Free fields — editable directly ---- */}
      <Card>
        <CardHeader title={t('library.section.contact')} />
        <CardBody>
          <form onSubmit={saveFree}>
            {freeMsg ? (
              <Banner severity="info" style={{ marginBottom: 'var(--sp-3)' }}>
                {freeMsg}
              </Banner>
            ) : null}
            <div className="lbr-form-grid">
              <FormField id="lp-phone" label={t('library.field.phone')}>
                <Input value={phone} onChange={(e) => setPhone(e.currentTarget.value)} />
              </FormField>
              <FormField id="lp-email" label={t('library.field.email')}>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                />
              </FormField>
              <FormField id="lp-website" label={t('library.field.website')}>
                <Input value={website} onChange={(e) => setWebsite(e.currentTarget.value)} />
              </FormField>
              <FormField id="lp-founded" label={t('library.field.foundedYear')}>
                <Input
                  type="number"
                  value={foundedYear}
                  onChange={(e) => setFoundedYear(e.currentTarget.value)}
                />
              </FormField>
            </div>
            <FormField id="lp-desc" label={t('library.field.description')}>
              <Textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
              />
            </FormField>
            <Button type="submit" loading={savingFree}>
              {t('library.profile.saveContact')}
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
