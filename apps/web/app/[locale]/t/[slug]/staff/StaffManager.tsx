'use client';
import * as React from 'react';
import { Banner, Button, Card, CardBody, CardHeader, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';

type StaffRole = 'owner' | 'admin' | 'librarian' | 'volunteer';
type AssignableRole = 'admin' | 'librarian' | 'volunteer';

export type StaffMember = {
  id: string;
  email: string | null;
  username: string | null;
  fullName: string;
  role: StaffRole;
  status: 'invited' | 'active' | 'disabled';
  mustChangeCredentials: boolean;
  lastLoginAt: string | null;
  createdAt: string;
};

const ASSIGNABLE: AssignableRole[] = ['admin', 'librarian', 'volunteer'];

export function StaffManager({
  slug,
  locale,
  catalog,
  initialStaff,
  currentUserId,
}: {
  slug: string;
  locale: Locale;
  catalog: Catalog;
  initialStaff: StaffMember[];
  currentUserId: string;
}) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const [staff, setStaff] = React.useState(initialStaff);
  const [newRole, setNewRole] = React.useState<AssignableRole>('librarian');
  const [newName, setNewName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [reveal, setReveal] = React.useState<{ username: string; password: string } | null>(null);

  const roleLabel = (r: StaffRole) =>
    r === 'owner' ? t('settings.staff.owner') : t(`settings.staff.roles.${r}`);

  function fail(err: unknown) {
    toast.show({
      severity: 'critical',
      title: translateApiError(err, t, t('common.states.error')),
    });
  }

  async function createStaff(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{
        user: {
          id: string;
          username: string;
          fullName: string;
          role: StaffRole;
          status: StaffMember['status'];
        };
        tempPassword: string;
      }>(`/t/${slug}/staff`, {
        method: 'POST',
        body: { role: newRole, fullName: newName.trim() || undefined },
      });
      setStaff((prev) => [
        ...prev,
        {
          id: res.user.id,
          email: null,
          username: res.user.username,
          fullName: res.user.fullName,
          role: res.user.role,
          status: res.user.status,
          mustChangeCredentials: true,
          lastLoginAt: null,
          createdAt: new Date().toISOString(),
        },
      ]);
      setReveal({ username: res.user.username, password: res.tempPassword });
      setNewName('');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(m: StaffMember) {
    try {
      const res = await api<{ tempPassword: string }>(`/t/${slug}/staff/${m.id}/reset-password`, {
        method: 'POST',
      });
      setReveal({ username: m.username ?? m.fullName, password: res.tempPassword });
      setStaff((prev) =>
        prev.map((s) => (s.id === m.id ? { ...s, mustChangeCredentials: true } : s)),
      );
    } catch (err) {
      fail(err);
    }
  }

  async function changeRole(m: StaffMember, role: AssignableRole) {
    try {
      await api(`/t/${slug}/staff/${m.id}/role`, { method: 'PATCH', body: { role } });
      setStaff((prev) => prev.map((s) => (s.id === m.id ? { ...s, role } : s)));
      toast.show({ severity: 'success', title: t('settings.staff.roleUpdated') });
    } catch (err) {
      fail(err);
    }
  }

  async function deactivate(m: StaffMember) {
    if (!window.confirm(t('settings.staff.deactivateConfirm', { name: m.fullName }))) return;
    try {
      await api(`/t/${slug}/staff/${m.id}/deactivate`, { method: 'POST' });
      setStaff((prev) => prev.filter((s) => s.id !== m.id));
    } catch (err) {
      fail(err);
    }
  }

  return (
    <>
      {reveal ? (
        <Banner severity="success" style={{ marginBottom: 'var(--sp-4)' }}>
          {t('settings.staff.credsBody', { username: reveal.username, password: reveal.password })}
        </Banner>
      ) : null}

      <Card style={{ marginBottom: 'var(--sp-5)' }}>
        <CardHeader
          title={t('settings.staff.createTitle')}
          subtitle={t('settings.staff.createHint')}
        />
        <CardBody>
          <form
            onSubmit={createStaff}
            style={{
              display: 'flex',
              gap: 'var(--sp-3)',
              alignItems: 'flex-end',
              flexWrap: 'wrap',
            }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
              <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 500 }}>
                {t('settings.staff.role')}
              </span>
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.currentTarget.value as AssignableRole)}
                className="lbr-input"
              >
                {ASSIGNABLE.map((r) => (
                  <option key={r} value={r}>
                    {t(`settings.staff.roles.${r}`)}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
              <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 500 }}>
                {t('settings.staff.nameOptional')}
              </span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.currentTarget.value)}
                className="lbr-input"
                placeholder={t('settings.staff.namePlaceholder')}
              />
            </label>
            <Button type="submit" variant="primary" loading={busy}>
              {t('settings.staff.create')}
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('settings.staff.listTitle')} />
        <CardBody>
          <div className="lbr-table-wrap">
            <table className="lbr-table">
              <thead>
                <tr>
                  <th>{t('settings.staff.cols.member')}</th>
                  <th>{t('settings.staff.cols.login')}</th>
                  <th>{t('settings.staff.cols.role')}</th>
                  <th>{t('settings.staff.cols.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((m) => {
                  const isOwner = m.role === 'owner';
                  const isSelf = m.id === currentUserId;
                  return (
                    <tr key={m.id}>
                      <td>
                        <strong>{m.fullName}</strong>
                        {m.mustChangeCredentials ? (
                          <div
                            style={{ color: 'var(--color-warning-text)', fontSize: 'var(--fs-xs)' }}
                          >
                            {t('settings.staff.pendingSetup')}
                          </div>
                        ) : null}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>
                        {m.username ?? m.email ?? '—'}
                      </td>
                      <td>
                        {isOwner ? (
                          roleLabel('owner')
                        ) : (
                          <select
                            value={m.role}
                            onChange={(e) => changeRole(m, e.currentTarget.value as AssignableRole)}
                            className="lbr-input"
                            aria-label={t('settings.staff.cols.role')}
                          >
                            {ASSIGNABLE.map((r) => (
                              <option key={r} value={r}>
                                {t(`settings.staff.roles.${r}`)}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        {isOwner ? (
                          <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                        ) : (
                          <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
                            {m.username ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => resetPassword(m)}
                              >
                                {t('settings.staff.reset')}
                              </Button>
                            ) : null}
                            {!isSelf ? (
                              <Button variant="danger" size="sm" onClick={() => deactivate(m)}>
                                {t('settings.staff.deactivate')}
                              </Button>
                            ) : null}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </>
  );
}
