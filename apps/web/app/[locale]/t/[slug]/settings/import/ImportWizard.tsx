'use client';
import * as React from 'react';
import { Banner, Button, Card, CardBody, CardHeader, EmptyState } from '@libriant/ui';
import { createTranslator, type Catalog, type Locale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';

// ---- shared shapes (mirror the API) ---------------------------------------
export type FieldDef = { key: string; label: string; kind: string; required?: boolean };
export type EntitySpec = { kind: string; fields: FieldDef[] };
type MappingTarget = { field: string | null };
type Mapping = Record<string, MappingTarget>;
type Column = { index: number; name: string };
type SampleRow = { rowNumber: number; cells: Record<string, string> };
type Counts = {
  total: number;
  valid: number;
  errors: number;
  warnings: number;
  imported: number;
  updated: number;
  skipped: number;
};
export type ImportBatchDto = {
  id: string;
  entityKind: string;
  format: string;
  status: string;
  originalName: string;
  sizeBytes: number;
  duplicateMode: 'skip' | 'update' | 'error';
  mapping: Mapping | null;
  counts: Counts;
  issuesTruncated: boolean;
  error: string | null;
  createdAt: string;
};
type DetailResponse = {
  batch: ImportBatchDto;
  columns: Column[];
  sample: SampleRow[];
  mapping: Mapping;
  targetFields: FieldDef[];
};
type Issue = {
  rowNumber: number;
  severity: string;
  field: string | null;
  code: string;
  message: string;
};

const ENTITY_ORDER = [
  'author',
  'book',
  'book_copy',
  'member',
  'loan',
  'reservation',
  'fine',
] as const;
const TERMINAL = ['completed', 'partially_completed', 'failed', 'canceled'];
const RUNNING = ['validating', 'committing'];

type Props = {
  catalog: Catalog;
  locale: Locale;
  slug: string;
  entities: EntitySpec[];
  initialBatches: ImportBatchDto[];
};

export function ImportWizard({ catalog, locale, slug, entities, initialBatches }: Props) {
  const t = createTranslator(catalog, locale);
  const apiBase = `/t/${slug}/imports`;
  const [batches, setBatches] = React.useState<ImportBatchDto[]>(initialBatches);
  const [detail, setDetail] = React.useState<DetailResponse | null>(null);
  const [mapping, setMapping] = React.useState<Mapping>({});
  const [dupMode, setDupMode] = React.useState<'skip' | 'update' | 'error'>('skip');
  const [issues, setIssues] = React.useState<Issue[]>([]);
  const [entityKind, setEntityKind] = React.useState<string>('book');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [advanced, setAdvanced] = React.useState(false);

  const status = detail?.batch.status ?? null;

  // Poll a running batch until it reaches a terminal/validated state.
  React.useEffect(() => {
    if (!detail || !RUNNING.includes(detail.batch.status)) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await api<DetailResponse>(`${apiBase}/${detail.batch.id}`);
        if (!alive) return;
        setDetail(res);
        upsertBatch(res.batch);
        if (!RUNNING.includes(res.batch.status)) {
          if (res.batch.counts.errors > 0 || res.batch.status === 'validated')
            void loadIssues(res.batch.id);
        }
      } catch {
        /* keep polling */
      }
    };
    const h = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [detail?.batch.id, detail?.batch.status]);

  function upsertBatch(b: ImportBatchDto) {
    setBatches((prev) => {
      const next = prev.filter((x) => x.id !== b.id);
      return [b, ...next].slice(0, 50);
    });
  }

  function fail(err: unknown) {
    const msg = err instanceof ApiError ? err.message : t('import.toast.error');
    setError(msg);
  }

  // ---- actions ------------------------------------------------------------
  async function doUpload(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.set('entityKind', entityKind);
    form.set('file', file);
    const formEl = e.currentTarget as HTMLFormElement;
    const fd = new FormData(formEl);
    for (const k of ['format', 'encoding', 'delimiter']) {
      const v = fd.get(k);
      if (typeof v === 'string' && v.length) form.set(k, v);
    }
    // Unchecked checkboxes don't submit, so read the header toggle directly.
    const headerEl = formEl.elements.namedItem('hasHeader') as HTMLInputElement | null;
    if (headerEl) form.set('hasHeader', headerEl.checked ? 'true' : 'false');
    setBusy(true);
    try {
      const res = await fetch(`/lbr-api${apiBase}`, {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      const body = (await res.json()) as DetailResponse & { message?: string };
      if (!res.ok) throw new ApiError(res.status, body);
      openDetail(res2detail(body));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  function res2detail(body: DetailResponse): DetailResponse {
    return body;
  }

  function openDetail(res: DetailResponse) {
    setDetail(res);
    setMapping(res.mapping ?? {});
    setDupMode(res.batch.duplicateMode ?? 'skip');
    setIssues([]);
    upsertBatch(res.batch);
    if (res.batch.counts.errors > 0 || res.batch.status === 'validated')
      void loadIssues(res.batch.id);
  }

  async function openBatch(id: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await api<DetailResponse>(`${apiBase}/${id}`);
      openDetail(res);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function loadIssues(id: string) {
    try {
      const res = await api<{ items: Issue[] }>(`${apiBase}/${id}/issues?limit=100`);
      setIssues(res.items);
    } catch {
      setIssues([]);
    }
  }

  async function saveMapping(id: string) {
    return api<ImportBatchDto>(`${apiBase}/${id}/mapping`, {
      method: 'PATCH',
      body: { mapping, duplicateMode: dupMode },
    });
  }

  async function run(phase: 'validate' | 'commit') {
    if (!detail) return;
    setError(null);
    setBusy(true);
    try {
      await saveMapping(detail.batch.id);
      const updated = await api<ImportBatchDto>(`${apiBase}/${detail.batch.id}/${phase}`, {
        method: 'POST',
      });
      const res = await api<DetailResponse>(`${apiBase}/${detail.batch.id}`);
      setDetail({ ...res, batch: updated.status ? updated : res.batch });
      upsertBatch(updated);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function removeBatch(id: string) {
    try {
      await api(`${apiBase}/${id}`, { method: 'DELETE' });
      setBatches((p) => p.filter((b) => b.id !== id));
      if (detail?.batch.id === id) setDetail(null);
    } catch (err) {
      fail(err);
    }
  }

  function reset() {
    setDetail(null);
    setIssues([]);
    setError(null);
  }

  // ---- render -------------------------------------------------------------
  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
      {error ? <Banner severity="critical">{error}</Banner> : null}

      {!detail ? (
        <UploadForm
          t={t}
          entities={entities.length ? entities.map((e) => e.kind) : [...ENTITY_ORDER]}
          entityKind={entityKind}
          setEntityKind={setEntityKind}
          advanced={advanced}
          setAdvanced={setAdvanced}
          fileRef={fileRef}
          busy={busy}
          onSubmit={doUpload}
        />
      ) : (
        <Card>
          <CardHeader
            title={detail.batch.originalName}
            subtitle={t(`import.entity.${detail.batch.entityKind}`)}
          />
          <CardBody>
            {status && RUNNING.includes(status) ? (
              <Progress t={t} batch={detail.batch} />
            ) : status && TERMINAL.includes(status) ? (
              <DonePanel
                t={t}
                batch={detail.batch}
                issues={issues}
                csvHref={`/lbr-api${apiBase}/${detail.batch.id}/errors.csv`}
                onAgain={reset}
              />
            ) : (
              <MappingEditor
                t={t}
                detail={detail}
                mapping={mapping}
                setMapping={setMapping}
                dupMode={dupMode}
                setDupMode={setDupMode}
                issues={issues}
                csvHref={`/lbr-api${apiBase}/${detail.batch.id}/errors.csv`}
                busy={busy}
                onValidate={() => run('validate')}
                onCommit={() => run('commit')}
                onBack={reset}
              />
            )}
          </CardBody>
        </Card>
      )}

      <RecentList
        t={t}
        batches={batches}
        onOpen={openBatch}
        onDelete={removeBatch}
        onNew={reset}
        showNew={!!detail}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
type T = ReturnType<typeof createTranslator>;

function UploadForm(props: {
  t: T;
  entities: string[];
  entityKind: string;
  setEntityKind: (k: string) => void;
  advanced: boolean;
  setAdvanced: (b: boolean) => void;
  fileRef: React.RefObject<HTMLInputElement | null>;
  busy: boolean;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const { t } = props;
  return (
    <Card>
      <CardHeader title={t('import.step.upload')} />
      <CardBody>
        <form onSubmit={props.onSubmit} style={{ display: 'grid', gap: 'var(--sp-3)' }}>
          <label style={labelStyle}>
            {t('import.upload.entity')}
            <select
              value={props.entityKind}
              onChange={(e) => props.setEntityKind(e.target.value)}
              style={selectStyle}
            >
              {props.entities.map((k) => (
                <option key={k} value={k}>
                  {t(`import.entity.${k}`)}
                </option>
              ))}
            </select>
          </label>

          <label style={labelStyle}>
            {t('import.upload.file')}
            <input
              ref={props.fileRef}
              type="file"
              name="fileInput"
              required
              style={{ marginTop: 4 }}
            />
            <span style={hintStyle}>{t('import.upload.fileHint')}</span>
          </label>

          <button
            type="button"
            onClick={() => props.setAdvanced(!props.advanced)}
            style={{ ...linkBtnStyle, justifySelf: 'start' }}
          >
            {props.advanced ? '▾' : '▸'} {t('import.upload.advanced')}
          </button>
          {props.advanced ? (
            <div className="lbr-form-grid" style={{ gap: 'var(--sp-2)' }}>
              <label style={labelStyle}>
                {t('import.upload.format')}
                <select name="format" defaultValue="" style={selectStyle}>
                  <option value="">{t('import.upload.auto')}</option>
                  <option value="csv">CSV</option>
                  <option value="tsv">TSV</option>
                  <option value="xlsx">Excel (.xlsx)</option>
                  <option value="marc">MARC (.mrc)</option>
                  <option value="marcxml">MARCXML (.xml)</option>
                </select>
              </label>
              <label style={labelStyle}>
                {t('import.upload.encoding')}
                <select name="encoding" defaultValue="" style={selectStyle}>
                  <option value="">{t('import.upload.auto')}</option>
                  <option value="utf-8">UTF-8</option>
                  <option value="windows-1253">Windows-1253 (Greek)</option>
                  <option value="windows-1252">Windows-1252</option>
                  <option value="iso-8859-7">ISO-8859-7</option>
                </select>
              </label>
              <label style={labelStyle}>
                {t('import.upload.delimiter')}
                <select name="delimiter" defaultValue="" style={selectStyle}>
                  <option value="">{t('import.upload.auto')}</option>
                  <option value=",">,</option>
                  <option value=";">;</option>
                  <option value={'\t'}>Tab</option>
                  <option value="|">|</option>
                </select>
              </label>
              <label style={{ ...labelStyle, alignSelf: 'end', flexDirection: 'row', gap: 8 }}>
                <input type="checkbox" name="hasHeader" value="true" defaultChecked />
                {t('import.upload.hasHeader')}
              </label>
            </div>
          ) : null}

          <Button type="submit" loading={props.busy} style={{ justifySelf: 'start' }}>
            {props.busy ? t('import.upload.uploading') : t('import.upload.submit')}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function MappingEditor(props: {
  t: T;
  detail: DetailResponse;
  mapping: Mapping;
  setMapping: (m: Mapping) => void;
  dupMode: 'skip' | 'update' | 'error';
  setDupMode: (m: 'skip' | 'update' | 'error') => void;
  issues: Issue[];
  csvHref: string;
  busy: boolean;
  onValidate: () => void;
  onCommit: () => void;
  onBack: () => void;
}) {
  const { t, detail, mapping } = props;
  const validated = detail.batch.status === 'validated';

  function setCol(col: string, field: string | null) {
    props.setMapping({ ...mapping, [col]: { field } });
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
      {validated ? (
        <Report t={t} batch={detail.batch} issues={props.issues} csvHref={props.csvHref} />
      ) : null}

      <div>
        <h3 style={{ margin: '0 0 4px' }}>{t('import.map.title')}</h3>
        <p style={hintStyle}>{t('import.map.hint')}</p>
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t('import.map.source')}</th>
                <th style={thStyle}>{t('import.map.target')}</th>
                <th style={thStyle}>{t('import.map.sample')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.columns.map((col) => {
                const target = mapping[col.name]?.field ?? null;
                const sample = detail.sample[0]?.cells[col.name] ?? '';
                return (
                  <tr key={col.name}>
                    <td style={tdStyle}>
                      <code>{col.name}</code>
                    </td>
                    <td style={tdStyle}>
                      <select
                        value={target ?? ''}
                        onChange={(e) => setCol(col.name, e.target.value || null)}
                        style={selectStyle}
                      >
                        <option value="">{t('import.map.ignore')}</option>
                        {detail.targetFields.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                            {f.required ? ` (${t('import.map.required')})` : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ ...tdStyle, color: 'var(--color-text-muted)' }}>{sample}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <label style={{ ...labelStyle, maxWidth: 360 }}>
        {t('import.map.duplicate')}
        <select
          value={props.dupMode}
          onChange={(e) => props.setDupMode(e.target.value as 'skip' | 'update' | 'error')}
          style={selectStyle}
        >
          <option value="skip">{t('import.map.dup.skip')}</option>
          <option value="update">{t('import.map.dup.update')}</option>
          <option value="error">{t('import.map.dup.error')}</option>
        </select>
      </label>

      <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
        <Button variant="secondary" onClick={props.onValidate} loading={props.busy}>
          {validated ? t('import.review.revalidate') : t('import.map.validate')}
        </Button>
        <Button onClick={props.onCommit} loading={props.busy}>
          {t('import.map.commit')}
        </Button>
        <Button variant="ghost" onClick={props.onBack} disabled={props.busy}>
          {t('import.map.back')}
        </Button>
      </div>
    </div>
  );
}

function Report(props: { t: T; batch: ImportBatchDto; issues: Issue[]; csvHref: string }) {
  const { t, batch } = props;
  return (
    <div>
      <h3 style={{ margin: '0 0 8px' }}>{t('import.review.title')}</h3>
      <CountGrid t={t} c={batch.counts} keys={['total', 'valid', 'errors', 'warnings']} />
      {batch.counts.errors === 0 ? (
        <Banner severity="info" style={{ marginTop: 'var(--sp-2)' }}>
          {t('import.review.noIssues')}
        </Banner>
      ) : (
        <IssueTable
          t={t}
          issues={props.issues}
          csvHref={props.csvHref}
          truncated={batch.issuesTruncated}
        />
      )}
    </div>
  );
}

function Progress(props: { t: T; batch: ImportBatchDto }) {
  const { t, batch } = props;
  const label =
    batch.status === 'validating'
      ? t('import.progress.validating')
      : t('import.progress.committing');
  const done = batch.counts.valid + batch.counts.errors;
  return (
    <div
      style={{ display: 'grid', gap: 'var(--sp-2)', placeItems: 'center', padding: 'var(--sp-4)' }}
    >
      <div className="lbr-spinner" aria-hidden style={spinnerStyle} />
      <strong>{label}</strong>
      <span style={hintStyle}>
        {t('import.progress.processed', { done, total: batch.counts.total })}
      </span>
    </div>
  );
}

function DonePanel(props: {
  t: T;
  batch: ImportBatchDto;
  issues: Issue[];
  csvHref: string;
  onAgain: () => void;
}) {
  const { t, batch } = props;
  const sev =
    batch.status === 'completed' ? 'info' : batch.status === 'failed' ? 'critical' : 'warning';
  const title =
    batch.status === 'completed'
      ? t('import.done.completed')
      : batch.status === 'failed'
        ? t('import.done.failed')
        : batch.status === 'canceled'
          ? t('import.done.canceled')
          : t('import.done.partial');
  return (
    <div style={{ display: 'grid', gap: 'var(--sp-3)' }}>
      <Banner severity={sev}>{title}</Banner>
      {batch.error ? <p style={{ color: 'var(--color-danger)' }}>{batch.error}</p> : null}
      <CountGrid
        t={t}
        c={batch.counts}
        keys={['imported', 'updated', 'skipped', 'errors', 'warnings']}
      />
      {batch.counts.errors > 0 ? (
        <IssueTable
          t={t}
          issues={props.issues}
          csvHref={props.csvHref}
          truncated={batch.issuesTruncated}
        />
      ) : null}
      <Button onClick={props.onAgain} style={{ justifySelf: 'start' }}>
        {t('import.done.again')}
      </Button>
    </div>
  );
}

function CountGrid(props: { t: T; c: Counts; keys: Array<keyof Counts> }) {
  const { t, c } = props;
  return (
    <div style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
      {props.keys.map((k) => (
        <div key={k} style={statStyle}>
          <span style={{ fontSize: 'var(--fs-xl)', fontWeight: 700 }}>{c[k]}</span>
          <span style={hintStyle}>{t(`import.review.counts.${k}`)}</span>
        </div>
      ))}
    </div>
  );
}

function IssueTable(props: { t: T; issues: Issue[]; csvHref: string; truncated: boolean }) {
  const { t } = props;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h4 style={{ margin: '8px 0' }}>{t('import.review.issues')}</h4>
        <a href={props.csvHref} className="lbr-btn lbr-btn--ghost lbr-btn--sm">
          {t('import.review.download')}
        </a>
      </div>
      <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>{t('import.review.col.row')}</th>
              <th style={thStyle}>{t('import.review.col.field')}</th>
              <th style={thStyle}>{t('import.review.col.message')}</th>
            </tr>
          </thead>
          <tbody>
            {props.issues.map((it, i) => (
              <tr key={i}>
                <td style={tdStyle}>{it.rowNumber}</td>
                <td style={tdStyle}>{it.field ?? '—'}</td>
                <td
                  style={{
                    ...tdStyle,
                    color: it.severity === 'error' ? 'var(--color-danger)' : 'inherit',
                  }}
                >
                  {it.message}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.truncated ? (
        <p style={hintStyle}>{t('import.review.truncated', { count: props.issues.length })}</p>
      ) : null}
    </div>
  );
}

function RecentList(props: {
  t: T;
  batches: ImportBatchDto[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  showNew: boolean;
}) {
  const { t } = props;
  return (
    <Card>
      <CardHeader
        title={t('import.list.title')}
        actions={
          props.showNew ? (
            <Button size="sm" variant="secondary" onClick={props.onNew}>
              {t('import.list.new')}
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        {props.batches.length === 0 ? (
          <EmptyState title={t('import.list.empty')} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t('import.list.col.file')}</th>
                  <th style={thStyle}>{t('import.list.col.entity')}</th>
                  <th style={thStyle}>{t('import.list.col.status')}</th>
                  <th style={thStyle}>{t('import.list.col.rows')}</th>
                  <th style={thStyle} />
                </tr>
              </thead>
              <tbody>
                {props.batches.map((b) => (
                  <tr key={b.id}>
                    <td style={tdStyle}>{b.originalName}</td>
                    <td style={tdStyle}>{t(`import.entity.${b.entityKind}`)}</td>
                    <td style={tdStyle}>
                      <StatusBadge t={t} status={b.status} />
                    </td>
                    <td style={tdStyle}>{b.counts.total || '—'}</td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button onClick={() => props.onOpen(b.id)} style={linkBtnStyle}>
                        {t('import.list.view')}
                      </button>{' '}
                      <button
                        onClick={() => props.onDelete(b.id)}
                        style={{ ...linkBtnStyle, color: 'var(--color-danger)' }}
                      >
                        {t('import.list.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function StatusBadge(props: { t: T; status: string }) {
  const color =
    props.status === 'completed'
      ? 'var(--color-success, #2e7d32)'
      : props.status === 'failed'
        ? 'var(--color-danger)'
        : props.status === 'partially_completed' || props.status === 'canceled'
          ? 'var(--color-warning, #b26a00)'
          : 'var(--color-text-muted)';
  return (
    <span style={{ color, fontWeight: 600, fontSize: 'var(--fs-sm)' }}>
      {props.t(`import.status.${props.status}`)}
    </span>
  );
}

// ---- inline styles --------------------------------------------------------
const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 'var(--fs-sm)',
  fontWeight: 600,
};
const selectStyle: React.CSSProperties = {
  padding: 'var(--sp-2)',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--color-border-muted)',
  background: 'var(--color-surface)',
  fontSize: 'var(--fs-sm)',
};
const hintStyle: React.CSSProperties = {
  fontSize: 'var(--fs-sm)',
  color: 'var(--color-text-muted)',
  fontWeight: 400,
};
const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 'var(--fs-sm)',
};
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: 'var(--sp-2)',
  borderBottom: '1px solid var(--color-border-muted)',
  color: 'var(--color-text-muted)',
  fontWeight: 600,
};
const tdStyle: React.CSSProperties = {
  padding: 'var(--sp-2)',
  borderBottom: '1px solid var(--color-border-muted, #eee)',
  verticalAlign: 'top',
};
const statStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 90,
  padding: 'var(--sp-2)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--color-surface-muted, #f7f7f8)',
};
const linkBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--color-primary)',
  cursor: 'pointer',
  fontSize: 'var(--fs-sm)',
  padding: 0,
};
const spinnerStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  border: '3px solid var(--color-border-muted)',
  borderTopColor: 'var(--color-primary)',
  animation: 'lbr-spin 0.8s linear infinite',
};
