'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, FormField, Input, Modal, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

type Plan = { id: string; slug: string; name: string };

type Props = {
  tenantId: string;
  plans: Plan[];
  billingMode: 'stripe' | 'manual';
};

/**
 * Owner-level billing actions for a tenant. Two flows:
 *
 *   - **Set plan** — force-change the tenant's plan without payment.
 *     Useful for support refunds, on-prem manual provisioning, and
 *     beta-grandfathering tenants into a higher tier.
 *   - **Set paid-until** — only enabled for manual-billed tenants. Extends
 *     the `paidUntil` so features stay live until the next invoice cycle.
 *
 * launch-readiness-02 — why there is a note under the two of them.
 *
 * Set plan writes `billingMode: plan.billingMode` (billing.service.ts,
 * `applyAdminPlanChange`), and every sellable plan is seeded `stripe`. So
 * "give this library Municipal" through this screen produces
 * `municipal / stripe / paidUntil = null`, Set paid-until disappears because it
 * refuses a non-manual subscription, and the effective-plan resolver only
 * enforces `paidUntil` for manual subscriptions — the twelve free months the
 * founding libraries were promised end up with no end date at all, and nothing
 * on this screen says so. Verified against a control plane on 2026-08-27:
 * set-plan → 201 `billingMode: "stripe"`, set-paid-until → 400 "Manual
 * paid-until only applies to manually-billed plans."
 *
 * The note is rendered where the mistake is made rather than only in a runbook,
 * because the operator making it is looking at this dropdown, not at
 * docs/RUNBOOK.md.
 */
export function AdminBillingActions({ tenantId, plans, billingMode }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [planSlug, setPlanSlug] = React.useState('');
  const [planBusy, setPlanBusy] = React.useState(false);
  const [paidUntilModalOpen, setPaidUntilModalOpen] = React.useState(false);
  const [paidUntil, setPaidUntil] = React.useState('');
  const [paidBusy, setPaidBusy] = React.useState(false);

  async function setPlan() {
    if (!planSlug) return;
    setPlanBusy(true);
    try {
      await api(`/admin/billing/tenants/${tenantId}/set-plan`, {
        method: 'POST',
        body: { planSlug },
      });
      toast.show({ severity: 'success', title: `Plan updated to ${planSlug}.` });
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    } finally {
      setPlanBusy(false);
    }
  }

  async function applyPaidUntil() {
    if (!paidUntil) return;
    setPaidBusy(true);
    try {
      await api(`/admin/billing/tenants/${tenantId}/set-paid-until`, {
        method: 'POST',
        body: { paidUntil: `${paidUntil}T23:59:59.000Z` },
      });
      toast.show({ severity: 'success', title: 'Paid-until updated.' });
      setPaidUntilModalOpen(false);
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    } finally {
      setPaidBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-2)' }}>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
        <select
          className="lbr-input"
          value={planSlug}
          onChange={(e) => setPlanSlug(e.currentTarget.value)}
          style={{ width: 200 }}
        >
          <option value="">Set plan to…</option>
          {plans.map((p) => (
            <option key={p.id} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
        <Button variant="secondary" loading={planBusy} disabled={!planSlug} onClick={setPlan}>
          Apply
        </Button>
        {billingMode === 'manual' ? (
          <Button variant="ghost" onClick={() => setPaidUntilModalOpen(true)}>
            Set paid-until
          </Button>
        ) : null}

        <Modal
          open={paidUntilModalOpen}
          onClose={() => setPaidUntilModalOpen(false)}
          title="Set paid-until"
          actions={
            <>
              <Button variant="ghost" onClick={() => setPaidUntilModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" loading={paidBusy} onClick={applyPaidUntil}>
                Apply
              </Button>
            </>
          }
        >
          <FormField
            id="paid-until"
            label="Paid until"
            hint="Manual-billed tenants stay on the plan until this date."
          >
            <Input
              type="date"
              value={paidUntil}
              onChange={(e) => setPaidUntil(e.currentTarget.value)}
              min={new Date().toISOString().slice(0, 10)}
            />
          </FormField>
        </Modal>
      </div>
      {billingMode === 'stripe' ? (
        <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', margin: 0 }}>
          This subscription is <strong>stripe</strong>-billed, so there is no Set paid-until.
          Applying a plan here keeps it that way — it copies the plan&apos;s own billing mode —
          which means a founding-offer free year set up this way would have{' '}
          <strong>no end date</strong>. The twelve months are set by{' '}
          <code>pnpm tenant:create --billing-mode=manual --paid-until=…</code> at creation, or by
          the two-step in the launch-offer reply playbook for a library that already exists.
        </p>
      ) : null}
    </div>
  );
}
