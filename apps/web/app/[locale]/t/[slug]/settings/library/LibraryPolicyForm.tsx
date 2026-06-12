'use client';
import * as React from 'react';
import { Button, Card, CardBody, CardHeader, FormField, Input, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';

export type TenantSettingsView = {
  currency: string;
  loanPeriodDays: number;
  renewalsEnabled: boolean;
  maxRenewals: number;
  overdueFinesEnabled: boolean;
  finePerDayCents: number;
  fineCapCents: number;
  lostItemFeesEnabled: boolean;
  lostItemDefaultFeeCents: number;
  reservationsEnabled: boolean;
  holdPickupHours: number;
  maxActiveLoans: number;
  reservationsAllowedByPlan: boolean;
};

/** Form state: numbers held as strings so the inputs don't fight the user. */
type FormState = {
  currency: string;
  loanPeriodDays: string;
  renewalsEnabled: boolean;
  maxRenewals: string;
  overdueFinesEnabled: boolean;
  finePerDay: string; // major units (e.g. "0.20")
  fineCap: string; // major units
  lostItemFeesEnabled: boolean;
  lostItemDefaultFee: string; // major units
  reservationsEnabled: boolean;
  holdPickupHours: string;
  maxActiveLoans: string;
};

const toMajor = (cents: number): string => (cents / 100).toString();
const fromMajor = (s: string): number => Math.max(0, Math.round(Number.parseFloat(s || '0') * 100));
const toInt = (s: string): number => Math.max(0, Math.trunc(Number.parseFloat(s || '0')));

function fromView(v: TenantSettingsView): FormState {
  return {
    currency: v.currency,
    loanPeriodDays: String(v.loanPeriodDays),
    renewalsEnabled: v.renewalsEnabled,
    maxRenewals: String(v.maxRenewals),
    overdueFinesEnabled: v.overdueFinesEnabled,
    finePerDay: toMajor(v.finePerDayCents),
    fineCap: toMajor(v.fineCapCents),
    lostItemFeesEnabled: v.lostItemFeesEnabled,
    lostItemDefaultFee: toMajor(v.lostItemDefaultFeeCents),
    reservationsEnabled: v.reservationsEnabled,
    holdPickupHours: String(v.holdPickupHours),
    maxActiveLoans: String(v.maxActiveLoans),
  };
}

/** The numeric payload a form state resolves to (what the API speaks). */
function toPayload(f: FormState) {
  return {
    currency: f.currency.trim().toUpperCase(),
    loanPeriodDays: toInt(f.loanPeriodDays),
    renewalsEnabled: f.renewalsEnabled,
    maxRenewals: toInt(f.maxRenewals),
    overdueFinesEnabled: f.overdueFinesEnabled,
    finePerDayCents: fromMajor(f.finePerDay),
    fineCapCents: fromMajor(f.fineCap),
    lostItemFeesEnabled: f.lostItemFeesEnabled,
    lostItemDefaultFeeCents: fromMajor(f.lostItemDefaultFee),
    reservationsEnabled: f.reservationsEnabled,
    holdPickupHours: toInt(f.holdPickupHours),
    maxActiveLoans: toInt(f.maxActiveLoans),
  };
}

/** Only the keys whose resolved value differs from the saved baseline. */
function diffPayload(
  current: ReturnType<typeof toPayload>,
  baseline: ReturnType<typeof toPayload>,
): Partial<ReturnType<typeof toPayload>> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(current) as (keyof typeof current)[]) {
    if (current[k] !== baseline[k]) out[k] = current[k];
  }
  return out;
}

function SwitchRow({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        padding: 'var(--sp-2) 0',
      }}
    >
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18, flexShrink: 0 }}
      />
      <span style={{ fontWeight: 600 }}>{label}</span>
    </label>
  );
}

export function LibraryPolicyForm({
  slug,
  locale,
  catalog,
  initial,
}: {
  slug: string;
  locale: Locale;
  catalog: Catalog;
  initial: TenantSettingsView;
}) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const [form, setForm] = React.useState<FormState>(() => fromView(initial));
  const [baseline, setBaseline] = React.useState<TenantSettingsView>(initial);
  const [busy, setBusy] = React.useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const cur = form.currency.trim().toUpperCase() || baseline.currency;
  const dirty = React.useMemo(
    () => Object.keys(diffPayload(toPayload(form), toPayload(fromView(baseline)))).length > 0,
    [form, baseline],
  );

  async function save() {
    const patch = diffPayload(toPayload(form), toPayload(fromView(baseline)));
    if (Object.keys(patch).length === 0) return;
    setBusy(true);
    try {
      const updated = await api<TenantSettingsView>(`/t/${slug}/settings`, {
        method: 'PATCH',
        body: patch,
      });
      setBaseline(updated);
      setForm(fromView(updated));
      toast.show({ severity: 'success', title: t('settings.library.saved') });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : '';
      toast.show({
        severity: 'critical',
        title: t('settings.library.saveError'),
        body: msg || undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  const num = (
    key: keyof FormState,
    labelKey: string,
    opts: { money?: boolean; disabled?: boolean } = {},
  ) => (
    <FormField
      id={`lib-${key}`}
      label={opts.money ? `${t(`settings.${labelKey}`)} (${cur})` : t(`settings.${labelKey}`)}
    >
      <Input
        type="number"
        min={0}
        step={opts.money ? '0.01' : '1'}
        inputMode={opts.money ? 'decimal' : 'numeric'}
        value={form[key] as string}
        disabled={opts.disabled}
        onChange={(e) => set(key, e.target.value as FormState[typeof key])}
      />
    </FormField>
  );

  const sectionGrid: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: 'var(--sp-4)',
    marginTop: 'var(--sp-3)',
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)', maxWidth: 880 }}>
      {/* Lending */}
      <Card>
        <CardHeader
          title={t('settings.library.circulation.title')}
          subtitle={t('settings.library.circulation.desc')}
        />
        <CardBody>
          <div style={sectionGrid}>
            <FormField id="lib-currency" label={t('settings.library.field.currency')}>
              <Input
                value={form.currency}
                maxLength={3}
                onChange={(e) => set('currency', e.target.value.toUpperCase())}
              />
            </FormField>
            {num('loanPeriodDays', 'library.field.loanPeriodDays')}
            {num('maxActiveLoans', 'library.field.maxActiveLoans')}
          </div>
        </CardBody>
      </Card>

      {/* Renewals */}
      <Card>
        <CardHeader
          title={t('settings.library.renewals.title')}
          subtitle={t('settings.library.renewals.desc')}
        />
        <CardBody>
          <SwitchRow
            id="lib-renewalsEnabled"
            label={t('settings.library.field.renewalsEnabled')}
            checked={form.renewalsEnabled}
            onChange={(v) => set('renewalsEnabled', v)}
          />
          <div style={sectionGrid}>
            {num('maxRenewals', 'library.field.maxRenewals', { disabled: !form.renewalsEnabled })}
          </div>
        </CardBody>
      </Card>

      {/* Overdue fines */}
      <Card>
        <CardHeader
          title={t('settings.library.fines.title')}
          subtitle={t('settings.library.fines.desc')}
        />
        <CardBody>
          <SwitchRow
            id="lib-overdueFinesEnabled"
            label={t('settings.library.field.overdueFinesEnabled')}
            checked={form.overdueFinesEnabled}
            onChange={(v) => set('overdueFinesEnabled', v)}
          />
          <div style={sectionGrid}>
            {num('finePerDay', 'library.field.finePerDayCents', {
              money: true,
              disabled: !form.overdueFinesEnabled,
            })}
            {num('fineCap', 'library.field.fineCapCents', {
              money: true,
              disabled: !form.overdueFinesEnabled,
            })}
          </div>
        </CardBody>
      </Card>

      {/* Lost-item fees */}
      <Card>
        <CardHeader
          title={t('settings.library.lostItems.title')}
          subtitle={t('settings.library.lostItems.desc')}
        />
        <CardBody>
          <SwitchRow
            id="lib-lostItemFeesEnabled"
            label={t('settings.library.field.lostItemFeesEnabled')}
            checked={form.lostItemFeesEnabled}
            onChange={(v) => set('lostItemFeesEnabled', v)}
          />
          <div style={sectionGrid}>
            {num('lostItemDefaultFee', 'library.field.lostItemDefaultFeeCents', {
              money: true,
              disabled: !form.lostItemFeesEnabled,
            })}
          </div>
        </CardBody>
      </Card>

      {/* Reservations */}
      <Card>
        <CardHeader
          title={t('settings.library.reservations.title')}
          subtitle={t('settings.library.reservations.desc')}
        />
        <CardBody>
          <SwitchRow
            id="lib-reservationsEnabled"
            label={t('settings.library.field.reservationsEnabled')}
            checked={form.reservationsEnabled && baseline.reservationsAllowedByPlan}
            disabled={!baseline.reservationsAllowedByPlan}
            onChange={(v) => set('reservationsEnabled', v)}
          />
          {!baseline.reservationsAllowedByPlan && (
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)', margin: 0 }}>
              {t('settings.library.reservationsPlanLocked')}
            </p>
          )}
          <div style={sectionGrid}>
            {num('holdPickupHours', 'library.field.holdPickupHours', {
              disabled: !form.reservationsEnabled || !baseline.reservationsAllowedByPlan,
            })}
          </div>
        </CardBody>
      </Card>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
        <Button variant="primary" onClick={save} loading={busy} disabled={!dirty || busy}>
          {t('settings.library.save')}
        </Button>
      </div>
    </div>
  );
}
