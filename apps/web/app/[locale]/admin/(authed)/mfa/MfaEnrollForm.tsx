'use client';
import * as React from 'react';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  FormField,
  Input,
  useToast,
} from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

type Props = {
  initialEnabled: boolean;
  initialError: string | null;
};

type SetupResponse = { secret: string; otpauthUrl: string };

/**
 * Three-state enrollment UI:
 *
 *   1. Already enabled  →  green banner + nothing to do.
 *   2. Not enabled, no setup in progress → big "Set up authenticator" button.
 *   3. Setup in progress (we have a secret) → reveal otpauth URL + secret,
 *      ask for a 6-digit code, verify and flip to (1).
 */
export function MfaEnrollForm({ initialEnabled, initialError }: Props) {
  const toast = useToast();
  const [enabled, setEnabled] = React.useState(initialEnabled);
  const [pending, setPending] = React.useState<SetupResponse | null>(null);
  const [code, setCode] = React.useState('');
  const [startingUp, setStartingUp] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);

  async function startSetup() {
    setStartingUp(true);
    try {
      const res = await api<SetupResponse>('/admin/mfa/setup', { method: 'POST' });
      setPending(res);
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    } finally {
      setStartingUp(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setVerifying(true);
    try {
      await api('/admin/mfa/verify', { method: 'POST', body: { code } });
      setEnabled(true);
      setPending(null);
      setCode('');
      toast.show({ severity: 'success', title: 'Authenticator enabled.' });
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    } finally {
      setVerifying(false);
    }
  }

  if (initialError) {
    return <Banner severity="critical">{initialError}</Banner>;
  }

  if (enabled) {
    return (
      <Banner severity="success">
        Your authenticator is set up. You can now redeem support keys for libraries.
      </Banner>
    );
  }

  if (!pending) {
    return (
      <Card>
        <CardBody>
          <p style={{ marginTop: 0 }}>
            You need to set up an authenticator app before you can redeem a library's support key.
            Click below to start.
          </p>
          <Button variant="primary" loading={startingUp} onClick={startSetup}>
            Set up authenticator
          </Button>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Scan or copy this into your authenticator app" />
      <CardBody>
        <ol style={{ paddingLeft: 'var(--sp-4)' }}>
          <li>Open your authenticator app and add a new entry.</li>
          <li>
            Paste this provisioning URL (or scan as a QR code in apps that support it):
            <pre
              style={{
                background: 'var(--color-surface-muted)',
                padding: 'var(--sp-2)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--fs-xs)',
                overflowX: 'auto',
                marginTop: 'var(--sp-1)',
              }}
            >
              {pending.otpauthUrl}
            </pre>
            <details style={{ marginTop: 'var(--sp-1)' }}>
              <summary>…or type the secret manually</summary>
              <code
                style={{
                  display: 'inline-block',
                  marginTop: 'var(--sp-1)',
                  letterSpacing: '0.05em',
                }}
              >
                {pending.secret}
              </code>
            </details>
          </li>
          <li>Enter the 6-digit code your app shows now:</li>
        </ol>
        <form onSubmit={verify} style={{ marginTop: 'var(--sp-3)' }}>
          <FormField id="totp" label="6-digit code">
            <Input
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.currentTarget.value.replace(/\D/g, ''))}
              required
            />
          </FormField>
          <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
            <Button
              type="submit"
              variant="primary"
              loading={verifying}
              disabled={code.length !== 6}
            >
              Verify + enable
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setPending(null);
                setCode('');
              }}
            >
              Start over
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
