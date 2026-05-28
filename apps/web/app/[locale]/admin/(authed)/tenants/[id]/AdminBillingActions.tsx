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
  );
}
