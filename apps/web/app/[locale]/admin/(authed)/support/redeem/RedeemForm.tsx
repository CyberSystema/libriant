'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, FormError, FormField, Input, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

type RedeemResponse = {
  session: { id: string; tenantId: string; expiresAt: string };
  tenant: { id: string; slug: string; name: string };
};

export function RedeemForm({ locale }: { locale: string }) {
  const router = useRouter();
  const toast = useToast();
  const [code, setCode] = React.useState('');
  const [totp, setTotp] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api<RedeemResponse>('/admin/support/redeem', {
        method: 'POST',
        body: { code: code.trim(), totp: totp.trim() },
      });
      toast.show({
        severity: 'success',
        title: `Support session opened for ${res.tenant.name}.`,
      });
      router.push(`/${locale}/t/${res.tenant.slug}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody>
        <FormError style={{ marginBottom: 'var(--sp-3)' }}>{error}</FormError>
        <form onSubmit={submit}>
          <FormField id="code" label="Support code" hint="Looks like SUPPORT-XXXXXX.">
            <Input
              autoFocus
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
              placeholder="SUPPORT-XXXXXX"
              required
            />
          </FormField>
          <FormField id="totp" label="Authenticator code">
            <Input
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              autoComplete="one-time-code"
              value={totp}
              onChange={(e) => setTotp(e.currentTarget.value.replace(/\D/g, ''))}
              required
            />
          </FormField>
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={!code || totp.length !== 6}
            >
              Open support session
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
