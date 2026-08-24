'use client';
import * as React from 'react';
import {
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
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';

export type Templates = Record<string, { subject?: string; body?: string }>;

const KINDS = ['dueSoon', 'overdue', 'holdReady'] as const;
type Kind = (typeof KINDS)[number];

/** Placeholders offered per kind (hold-ready uses {by} for the pickup deadline,
 *  the others use {due}). */
const PLACEHOLDERS: Record<Kind, string> = {
  dueSoon: '{member} · {book} · {due} · {library}',
  overdue: '{member} · {book} · {due} · {library}',
  holdReady: '{member} · {book} · {by} · {library}',
};

export function TemplateEditor({
  slug,
  locale,
  catalog,
  initial,
}: {
  slug: string;
  locale: Locale;
  catalog: Catalog;
  initial: Templates;
}) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const [tpl, setTpl] = React.useState<Templates>(initial ?? {});
  const [baseline, setBaseline] = React.useState<Templates>(initial ?? {});
  const [busy, setBusy] = React.useState(false);

  const set = (kind: Kind, field: 'subject' | 'body', value: string) =>
    setTpl((p) => ({ ...p, [kind]: { ...p[kind], [field]: value } }));

  const clean = (src: Templates): Templates => {
    const out: Templates = {};
    for (const k of KINDS) {
      const subject = (src[k]?.subject ?? '').trim();
      const body = (src[k]?.body ?? '').trim();
      if (subject || body) out[k] = { ...(subject ? { subject } : {}), ...(body ? { body } : {}) };
    }
    return out;
  };

  const dirty = JSON.stringify(clean(tpl)) !== JSON.stringify(clean(baseline));

  async function save() {
    setBusy(true);
    try {
      const updated = await api<{ notificationTemplates: Templates }>(`/t/${slug}/settings`, {
        method: 'PATCH',
        body: { notificationTemplates: clean(tpl) },
      });
      const next = updated.notificationTemplates ?? {};
      setBaseline(next);
      setTpl(next);
      toast.show({ severity: 'success', title: t('settings.templates.saved') });
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: t('settings.templates.saveError'),
        body: translateApiError(err, t),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)', maxWidth: 760 }}>
      <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>{t('settings.templates.hint')}</p>
      {KINDS.map((kind) => (
        <Card key={kind}>
          <CardHeader title={t(`settings.templates.kind.${kind}`)} />
          <CardBody>
            <div style={{ display: 'grid', gap: 'var(--sp-3)' }}>
              <FormField
                id={`tpl-${kind}-subject`}
                label={t('settings.templates.subject')}
                hint={`${t('settings.templates.placeholders')}: ${PLACEHOLDERS[kind]}`}
              >
                <Input
                  value={tpl[kind]?.subject ?? ''}
                  placeholder={t('settings.templates.defaultPlaceholder')}
                  onChange={(e) => set(kind, 'subject', e.target.value)}
                />
              </FormField>
              <FormField id={`tpl-${kind}-body`} label={t('settings.templates.body')}>
                <Textarea
                  rows={4}
                  value={tpl[kind]?.body ?? ''}
                  placeholder={t('settings.templates.defaultPlaceholder')}
                  onChange={(e) => set(kind, 'body', e.target.value)}
                />
              </FormField>
            </div>
          </CardBody>
        </Card>
      ))}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" onClick={save} loading={busy} disabled={!dirty || busy}>
          {t('settings.templates.save')}
        </Button>
      </div>
    </div>
  );
}
