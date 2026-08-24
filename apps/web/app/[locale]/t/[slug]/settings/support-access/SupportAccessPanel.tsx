'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDestructive,
  useToast,
} from '@libriant/ui';
import { createTranslator, type Catalog, type Locale } from '@libriant/i18n';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';

type PendingKey = {
  id: string;
  prefix: string;
  generatedAt: string;
  expiresAt: string;
} | null;

type ActiveSession = {
  id: string;
  startedAt: string;
  expiresAt: string;
  admin: { id: string; email: string; fullName: string };
} | null;

type SessionLogEntry = {
  id: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedReason: string | null;
  admin: { email: string; fullName: string };
  actions: Array<{
    id: string;
    ts: string;
    method: string;
    path: string;
    status: number;
    targetType: string | null;
    targetId: string | null;
  }>;
};

type Props = {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  initialPending: PendingKey;
  initialActive: ActiveSession;
  initialHistory: SessionLogEntry[];
};

type GenerateResponse = {
  id: string;
  code: string;
  prefix: string;
  expiresAt: string;
};

export function SupportAccessPanel({
  slug,
  catalog,
  locale,
  initialPending,
  initialActive,
  initialHistory,
}: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = React.useState(initialPending);
  const [active, setActive] = React.useState(initialActive);
  const [revealedCode, setRevealedCode] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [revokeOpen, setRevokeOpen] = React.useState(false);
  const [endSessionOpen, setEndSessionOpen] = React.useState(false);

  const errTitle = (err: unknown) => translateApiError(err, t, t('errors.generic.title'));

  async function generate() {
    setBusy(true);
    try {
      const res = await api<GenerateResponse>(`/t/${slug}/support/keys`, {
        method: 'POST',
        body: {},
      });
      setPending({
        id: res.id,
        prefix: res.prefix,
        generatedAt: new Date().toISOString(),
        expiresAt: res.expiresAt,
      });
      setRevealedCode(res.code);
      router.refresh();
    } catch (err) {
      toast.show({ severity: 'critical', title: errTitle(err) });
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey() {
    setBusy(true);
    try {
      await api(`/t/${slug}/support/keys/pending`, { method: 'DELETE' });
      setPending(null);
      setRevealedCode(null);
      setRevokeOpen(false);
      toast.show({ severity: 'success', title: t('support.access.revoked') });
      router.refresh();
    } catch (err) {
      toast.show({ severity: 'critical', title: errTitle(err) });
    } finally {
      setBusy(false);
    }
  }

  async function endActive() {
    setBusy(true);
    try {
      await api(`/t/${slug}/support/sessions/active`, { method: 'DELETE' });
      setActive(null);
      setEndSessionOpen(false);
      toast.show({ severity: 'success', title: t('support.access.ended') });
      router.refresh();
    } catch (err) {
      toast.show({ severity: 'critical', title: errTitle(err) });
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!revealedCode) return;
    try {
      await navigator.clipboard.writeText(revealedCode);
      toast.show({ severity: 'success', title: t('support.grant.copied') });
    } catch {
      toast.show({ severity: 'warning', title: t('support.access.copyFailed') });
    }
  }

  const fmt = (iso: string) => new Date(iso).toLocaleString();

  return (
    <>
      {active ? (
        <Card style={{ marginBottom: 'var(--sp-4)' }}>
          <CardHeader title={t('support.activeSession.title')} />
          <CardBody>
            <Banner severity="warning" style={{ marginBottom: 'var(--sp-3)' }}>
              {t('support.access.activeBanner', {
                admin: active.admin.fullName,
                email: active.admin.email,
                start: fmt(active.startedAt),
                end: fmt(active.expiresAt),
              })}
            </Banner>
            <p style={{ marginTop: 0 }}>{t('support.access.endAnytime')}</p>
            <Button variant="secondary" onClick={() => setEndSessionOpen(true)}>
              {t('support.activeSession.endNow')}
            </Button>
          </CardBody>
        </Card>
      ) : null}

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title={t('support.grant.codeLabel')} />
        <CardBody>
          {revealedCode ? (
            <>
              <Banner severity="info" style={{ marginBottom: 'var(--sp-3)' }}>
                {t('support.grant.codeShownOnce')}
              </Banner>
              <pre
                style={{
                  fontSize: 'var(--fs-xl)',
                  background: 'var(--color-surface-muted)',
                  padding: 'var(--sp-3)',
                  borderRadius: 'var(--radius-md)',
                  letterSpacing: '0.1em',
                  margin: 0,
                  textAlign: 'center',
                }}
              >
                {revealedCode}
              </pre>
              <div
                style={{
                  display: 'flex',
                  gap: 'var(--sp-2)',
                  marginTop: 'var(--sp-3)',
                  flexWrap: 'wrap',
                }}
              >
                <Button variant="primary" onClick={copyCode}>
                  {t('support.grant.copy')}
                </Button>
                <Button variant="ghost" onClick={() => setRevealedCode(null)}>
                  {t('support.access.hide')}
                </Button>
              </div>
            </>
          ) : pending ? (
            <>
              <p style={{ marginTop: 0 }}>
                {t('support.access.pendingInfo', {
                  prefix: pending.prefix,
                  time: fmt(pending.expiresAt),
                })}
              </p>
              <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)' }}>
                {t('support.access.pendingHint')}
              </p>
              <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
                <Button variant="secondary" loading={busy} onClick={generate}>
                  {t('support.access.generateNew')}
                </Button>
                <Button variant="ghost" onClick={() => setRevokeOpen(true)}>
                  {t('support.access.revoke')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p style={{ marginTop: 0 }}>{t('support.grant.intro')}</p>
              <Button variant="primary" loading={busy} onClick={generate}>
                {t('support.grant.cta')}
              </Button>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('support.log.title')} />
        <CardBody>
          {initialHistory.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>{t('support.log.empty')}</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
              {initialHistory.map((s) => (
                <details key={s.id}>
                  <summary style={{ cursor: 'pointer', fontWeight: 500 }}>
                    {s.admin.fullName} ({s.admin.email}) — <time>{fmt(s.startedAt)}</time>{' '}
                    {s.endedAt ? (
                      <span style={{ color: 'var(--color-text-muted)' }}>
                        {t('support.access.endedSuffix', {
                          time: fmt(s.endedAt),
                          reason: s.endedReason ?? t('support.access.unknownReason'),
                        })}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--color-warning-text)' }}>
                        {t('support.access.stillActive')}
                      </span>
                    )}
                  </summary>
                  {s.actions.length === 0 ? (
                    <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--sp-2)' }}>
                      {t('support.access.noActions')}
                    </p>
                  ) : (
                    <div className="lbr-table-wrap" style={{ marginTop: 'var(--sp-2)' }}>
                      <table className="lbr-table">
                        <thead>
                          <tr>
                            <th>{t('support.access.col.time')}</th>
                            <th>{t('support.access.col.method')}</th>
                            <th>{t('support.access.col.path')}</th>
                            <th>{t('support.access.col.status')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.actions.map((a) => (
                            <tr key={a.id}>
                              <td>
                                <time dateTime={a.ts}>{fmt(a.ts)}</time>
                              </td>
                              <td>
                                <code>{a.method}</code>
                              </td>
                              <td>
                                <code>{a.path}</code>
                              </td>
                              <td>{a.status}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </details>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <ConfirmDestructive
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        onConfirm={revokeKey}
        busy={busy}
        title={t('support.access.revokeTitle')}
        confirmText={pending?.prefix ?? slug}
        confirmLabel={t('support.access.revokeConfirm')}
        cancelLabel={t('support.access.revokeCancel')}
      >
        <p>{t('support.access.revokeBody', { prefix: pending?.prefix ?? '' })}</p>
      </ConfirmDestructive>

      <ConfirmDestructive
        open={endSessionOpen}
        onClose={() => setEndSessionOpen(false)}
        onConfirm={endActive}
        busy={busy}
        title={t('support.access.endTitle')}
        confirmText={slug}
        confirmLabel={t('support.access.endConfirm')}
        cancelLabel={t('support.access.endCancel')}
      >
        <p>{t('support.access.endBody')}</p>
      </ConfirmDestructive>
    </>
  );
}
