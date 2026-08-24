'use client';
import * as React from 'react';
import { Button, Card, CardBody, CardHeader, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';

type Format = 'csv' | 'json' | 'xlsx' | 'sql';
type Status = 'queued' | 'running' | 'completed' | 'failed';

export type ExportJobView = {
  id: string;
  format: Format;
  scope: 'tenant' | 'control' | 'all';
  status: Status;
  progressDone: number;
  progressTotal: number;
  fileName: string | null;
  fileBytes: number | null;
  error: string | null;
  createdAt: string;
};

const FORMATS: Format[] = ['csv', 'json', 'xlsx', 'sql'];

function fmtBytes(n: number | null): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ExportManager({
  slug,
  locale,
  catalog,
  initial,
}: {
  slug: string;
  locale: Locale;
  catalog: Catalog;
  initial: ExportJobView[];
}) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const [exports, setExports] = React.useState(initial);
  const [format, setFormat] = React.useState<Format>('xlsx');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const active = exports.some((e) => e.status === 'queued' || e.status === 'running');
    if (!active) return;
    const id = setInterval(async () => {
      try {
        const res = await api<{ exports: ExportJobView[] }>(`/t/${slug}/exports`);
        setExports(res.exports);
      } catch {
        /* keep last known */
      }
    }, 3000);
    return () => clearInterval(id);
  }, [exports, slug]);

  async function create() {
    setBusy(true);
    try {
      const res = await api<{ export: ExportJobView }>(`/t/${slug}/exports`, {
        method: 'POST',
        body: { format },
      });
      setExports((prev) => [res.export, ...prev]);
      toast.show({ severity: 'success', title: t('settings.export.started') });
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: translateApiError(err, t, t('common.states.error')),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card style={{ marginBottom: 'var(--sp-5)' }}>
        <CardHeader title={t('settings.export.createTitle')} subtitle={t('settings.export.hint')} />
        <CardBody>
          <div
            style={{
              display: 'flex',
              gap: 'var(--sp-3)',
              alignItems: 'flex-end',
              flexWrap: 'wrap',
            }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
              <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 500 }}>
                {t('settings.export.format')}
              </span>
              <select
                value={format}
                onChange={(e) => setFormat(e.currentTarget.value as Format)}
                className="lbr-input"
              >
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {t(`settings.export.formats.${f}`)}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="primary" onClick={create} loading={busy}>
              {t('settings.export.create')}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t('settings.export.listTitle')}
          subtitle={t('settings.export.listHint')}
        />
        <CardBody>
          {exports.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>
              {t('settings.export.none')}
            </p>
          ) : (
            <div className="lbr-table-wrap">
              <table className="lbr-table">
                <thead>
                  <tr>
                    <th>{t('settings.export.cols.format')}</th>
                    <th>{t('settings.export.cols.status')}</th>
                    <th>{t('settings.export.cols.size')}</th>
                    <th>{t('settings.export.cols.created')}</th>
                    <th>{t('settings.export.cols.download')}</th>
                  </tr>
                </thead>
                <tbody>
                  {exports.map((e) => (
                    <tr key={e.id}>
                      <td style={{ textTransform: 'uppercase' }}>{e.format}</td>
                      <td>
                        {t(`settings.export.status.${e.status}`)}
                        {e.status === 'running' && e.progressTotal > 0
                          ? ` (${e.progressDone}/${e.progressTotal})`
                          : ''}
                        {e.status === 'failed' && e.error ? (
                          <div style={{ color: 'var(--color-danger)', fontSize: 'var(--fs-xs)' }}>
                            {e.error}
                          </div>
                        ) : null}
                      </td>
                      <td>{fmtBytes(e.fileBytes)}</td>
                      <td>{new Date(e.createdAt).toLocaleString(locale)}</td>
                      <td>
                        {e.status === 'completed' ? (
                          <a
                            href={`/lbr-api/t/${slug}/exports/${e.id}/download`}
                            className="lbr-btn lbr-btn--secondary lbr-btn--sm"
                          >
                            {t('settings.export.download')}
                          </a>
                        ) : (
                          <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </>
  );
}
