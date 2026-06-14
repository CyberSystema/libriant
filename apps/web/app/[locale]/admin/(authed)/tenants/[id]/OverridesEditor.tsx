'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

type Feature = {
  key: string;
  type: 'integer' | 'boolean' | 'text';
  label: string;
  description: string;
  defaultInt: number | null;
  defaultBool: boolean | null;
  defaultText: string | null;
  unit: string | null;
  sortOrder: number;
};

type Override = {
  id: string;
  featureKey: string;
  valueInt: number | null;
  valueBool: boolean | null;
  valueText: string | null;
  expiresAt: string | null;
  note: string | null;
};

type Plan = {
  values: Array<{
    featureKey: string;
    valueInt: number | null;
    valueBool: boolean | null;
    valueText: string | null;
  }>;
};

type Props = {
  tenantId: string;
  features: Feature[];
  overrides: Override[];
  plan: Plan | null;
  locale: string;
};

/**
 * Per-feature override table. One row per feature in the catalog; columns
 * show the effective source (override → plan → default), and inline
 * Input/Button controls let the admin set or clear the override.
 *
 * Editing is granular: edit one row, hit Save → API upsert → row replaces
 * itself in local state. Clear button DELETEs the override row.
 */
export function OverridesEditor({ tenantId, features, overrides, plan }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [local, setLocal] = React.useState<Record<string, Override | null>>(
    Object.fromEntries(overrides.map((o) => [o.featureKey, o])),
  );
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);

  function planValue(key: string, type: Feature['type']) {
    const v = plan?.values.find((p) => p.featureKey === key);
    if (!v) return null;
    if (type === 'integer') return v.valueInt;
    if (type === 'boolean') return v.valueBool;
    return v.valueText;
  }

  function defaultValue(f: Feature) {
    if (f.type === 'integer') return f.defaultInt;
    if (f.type === 'boolean') return f.defaultBool;
    return f.defaultText;
  }

  function effectiveValue(f: Feature): unknown {
    const override = local[f.key];
    if (override) {
      if (f.type === 'integer') return override.valueInt;
      if (f.type === 'boolean') return override.valueBool;
      return override.valueText;
    }
    const planVal = planValue(f.key, f.type);
    if (planVal !== null && planVal !== undefined) return planVal;
    return defaultValue(f);
  }

  function source(f: Feature): 'override' | 'plan' | 'default' {
    if (local[f.key]) return 'override';
    const planVal = planValue(f.key, f.type);
    if (planVal !== null && planVal !== undefined) return 'plan';
    return 'default';
  }

  async function save(f: Feature) {
    setBusy(f.key);
    try {
      const raw = drafts[f.key] ?? '';
      const body: Record<string, unknown> = { featureKey: f.key };
      if (f.type === 'integer') {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          toast.show({ severity: 'critical', title: 'Enter a number.' });
          setBusy(null);
          return;
        }
        body.valueInt = parsed;
      } else if (f.type === 'boolean') {
        body.valueBool = raw === 'true';
      } else {
        body.valueText = raw;
      }
      const res = await api<{ override: Override }>(`/admin/tenants/${tenantId}/overrides`, {
        method: 'PUT',
        body,
      });
      setLocal((prev) => ({ ...prev, [f.key]: res.override }));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[f.key];
        return next;
      });
      toast.show({ severity: 'success', title: `Override set for ${f.label}.` });
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    } finally {
      setBusy(null);
    }
  }

  async function clear(f: Feature) {
    setBusy(f.key);
    try {
      await api(`/admin/tenants/${tenantId}/overrides/${f.key}`, { method: 'DELETE' });
      setLocal((prev) => ({ ...prev, [f.key]: null }));
      toast.show({ severity: 'success', title: `Override cleared for ${f.label}.` });
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    } finally {
      setBusy(null);
    }
  }

  function renderEditor(f: Feature) {
    const draft = drafts[f.key];
    const override = local[f.key];
    const currentRaw =
      draft ??
      (override
        ? f.type === 'integer'
          ? String(override.valueInt ?? '')
          : f.type === 'boolean'
            ? String(override.valueBool ?? '')
            : (override.valueText ?? '')
        : '');
    if (f.type === 'boolean') {
      return (
        <select
          className="lbr-input"
          value={currentRaw}
          onChange={(e) => setDrafts((prev) => ({ ...prev, [f.key]: e.currentTarget.value }))}
          style={{ width: 100 }}
        >
          <option value="">—</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    }
    return (
      <Input
        type={f.type === 'integer' ? 'number' : 'text'}
        value={currentRaw}
        onChange={(e) => setDrafts((prev) => ({ ...prev, [f.key]: e.currentTarget.value }))}
        style={{ width: f.type === 'integer' ? 120 : 200 }}
      />
    );
  }

  return (
    <div className="lbr-table-wrap">
      <table className="lbr-table">
        <thead>
          <tr>
            <th>Feature</th>
            <th>Type</th>
            <th>Effective</th>
            <th>Source</th>
            <th>Override</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {features
            .slice()
            .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
            .map((f) => {
              const eff = effectiveValue(f);
              const src = source(f);
              return (
                <tr key={f.key}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{f.label}</div>
                    <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                      <code style={{ fontFamily: 'var(--font-mono)' }}>{f.key}</code>
                    </div>
                  </td>
                  <td>{f.type}</td>
                  <td>
                    {eff === null || eff === undefined ? (
                      <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                    ) : (
                      <strong>
                        {String(eff)}
                        {f.unit ? (
                          <span
                            style={{
                              color: 'var(--color-text-muted)',
                              marginLeft: 4,
                              fontWeight: 400,
                            }}
                          >
                            {f.unit}
                          </span>
                        ) : null}
                      </strong>
                    )}
                  </td>
                  <td>
                    <span
                      style={{
                        fontSize: 'var(--fs-xs)',
                        color:
                          src === 'override'
                            ? 'var(--color-primary)'
                            : src === 'plan'
                              ? 'var(--color-info)'
                              : 'var(--color-text-muted)',
                      }}
                    >
                      {src}
                    </span>
                  </td>
                  <td>{renderEditor(f)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={busy === f.key}
                      onClick={() => save(f)}
                    >
                      Save
                    </Button>
                    {local[f.key] ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === f.key}
                        onClick={() => clear(f)}
                        style={{ marginLeft: 4 }}
                      >
                        Clear
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
