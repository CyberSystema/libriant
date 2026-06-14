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

type PlanValue = {
  featureKey: string;
  valueInt: number | null;
  valueBool: boolean | null;
  valueText: string | null;
};

type Props = {
  planSlug: string;
  features: Feature[];
  planValues: PlanValue[];
};

/**
 * Plan feature editor — one row per feature in the catalog. Effective
 * value comes from the plan when set, else the catalog default. PUT to
 * `/admin/plans/:slug/features` upserts a value; setting it back to the
 * default would normally require a delete endpoint (out of scope here —
 * for now we leave the row in place with the same value).
 */
export function PlanFeatureEditor({ planSlug, features, planValues }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = React.useState<Map<string, PlanValue>>(
    () => new Map(planValues.map((v) => [v.featureKey, v])),
  );
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);

  function currentValue(f: Feature): unknown {
    const v = values.get(f.key);
    if (!v) return null;
    if (f.type === 'integer') return v.valueInt;
    if (f.type === 'boolean') return v.valueBool;
    return v.valueText;
  }

  function effectiveValue(f: Feature): unknown {
    const set = currentValue(f);
    if (set !== null && set !== undefined) return set;
    if (f.type === 'integer') return f.defaultInt;
    if (f.type === 'boolean') return f.defaultBool;
    return f.defaultText;
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
      const res = await api<{ plan: { values: PlanValue[] } }>(
        `/admin/plans/${planSlug}/features`,
        { method: 'PUT', body },
      );
      setValues(new Map(res.plan.values.map((v) => [v.featureKey, v])));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[f.key];
        return next;
      });
      toast.show({ severity: 'success', title: `${f.label} updated.` });
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
    const v = values.get(f.key);
    const currentRaw =
      draft ??
      (v
        ? f.type === 'integer'
          ? String(v.valueInt ?? '')
          : f.type === 'boolean'
            ? String(v.valueBool ?? '')
            : (v.valueText ?? '')
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
            <th>Value</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {features
            .slice()
            .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
            .map((f) => {
              const eff = effectiveValue(f);
              const source = values.get(f.key) ? 'plan' : 'default';
              return (
                <tr key={f.key}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{f.label}</div>
                    <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                      <code style={{ fontFamily: 'var(--font-mono)' }}>{f.key}</code>
                      {f.description ? ` · ${f.description}` : ''}
                    </div>
                  </td>
                  <td>{f.type}</td>
                  <td>
                    {eff === null || eff === undefined ? (
                      <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                    ) : (
                      <span>
                        <strong>{String(eff)}</strong>
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
                        <span
                          style={{
                            color:
                              source === 'plan'
                                ? 'var(--color-primary)'
                                : 'var(--color-text-muted)',
                            fontSize: 'var(--fs-xs)',
                            marginLeft: 'var(--sp-2)',
                          }}
                        >
                          {source}
                        </span>
                      </span>
                    )}
                  </td>
                  <td>{renderEditor(f)}</td>
                  <td>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={busy === f.key}
                      onClick={() => save(f)}
                    >
                      Save
                    </Button>
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
