'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FormError,
  FormField,
  Input,
  Textarea,
  useToast,
} from '@libriant/ui';
import { ApiError, api } from '@/lib/api';
import { type Audience, type Severity, audienceToJson } from '../types';

type TenantRow = { id: string; slug: string; name: string };
type PlanRow = { slug: string; name: string };

type Props = {
  tenants: TenantRow[];
  plans: PlanRow[];
  knownTags: string[];
};

const SEVERITIES: Severity[] = ['info', 'warning', 'critical'];

export function AnnouncementComposer({ tenants, plans, knownTags }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [title, setTitle] = React.useState('');
  const [bodyMarkdown, setBody] = React.useState('');
  const [severity, setSeverity] = React.useState<Severity>('info');
  const [kind, setKind] = React.useState<Audience['kind']>('all');
  const [selectedTenants, setSelectedTenants] = React.useState<string[]>([]);
  const [selectedPlans, setSelectedPlans] = React.useState<string[]>([]);
  const [tagsInput, setTagsInput] = React.useState('');
  const [deliverInApp, setDeliverInApp] = React.useState(true);
  const [deliverEmail, setDeliverEmail] = React.useState(false);
  const [publishAt, setPublishAt] = React.useState('');
  const [expiresAt, setExpiresAt] = React.useState('');
  const [dismissible, setDismissible] = React.useState(true);
  const [requiresAck, setRequiresAck] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function buildAudience(): Audience {
    switch (kind) {
      case 'all':
        return { kind: 'all' };
      case 'tenant_ids':
        return { kind: 'tenant_ids', tenantIds: selectedTenants };
      case 'plan_slugs':
        return { kind: 'plan_slugs', planSlugs: selectedPlans };
      case 'tags':
        return {
          kind: 'tags',
          tags: tagsInput
            .split(',')
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean),
        };
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const audience = buildAudience();
    if (audience.kind === 'tenant_ids' && audience.tenantIds.length === 0) {
      setError('Pick at least one library.');
      return;
    }
    if (audience.kind === 'plan_slugs' && audience.planSlugs.length === 0) {
      setError('Pick at least one plan.');
      return;
    }
    if (audience.kind === 'tags' && audience.tags.length === 0) {
      setError('Add at least one tag.');
      return;
    }
    if (!deliverInApp && !deliverEmail) {
      setError('Pick at least one delivery channel.');
      return;
    }
    if (requiresAck && severity !== 'critical') {
      setError('Only critical announcements can require an acknowledgement.');
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ announcement: { id: string; title: string } }>(
        '/admin/announcements',
        {
          method: 'POST',
          body: {
            title,
            bodyMarkdown,
            severity,
            audience: audienceToJson(audience),
            deliverInApp,
            deliverEmail,
            publishAt: publishAt ? new Date(publishAt).toISOString() : null,
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            dismissible: requiresAck ? false : dismissible,
            requiresAck,
          },
        },
      );
      toast.show({
        severity: 'success',
        title: `Announcement "${res.announcement.title}" created.`,
      });
      router.push(`/admin/announcements/${res.announcement.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function toggleArrayValue(arr: string[], v: string): string[] {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  }

  return (
    <form onSubmit={submit}>
      <FormError style={{ marginBottom: 'var(--sp-3)' }}>{error}</FormError>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title="Message" />
        <CardBody>
          <FormField id="title" label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
              maxLength={200}
              required
            />
          </FormField>
          <FormField id="body" label="Body (Markdown)">
            <Textarea
              value={bodyMarkdown}
              onChange={(e) => setBody(e.currentTarget.value)}
              rows={8}
              maxLength={20000}
              required
            />
          </FormField>
          <FormField id="severity" label="Severity">
            <select
              className="lbr-input"
              value={severity}
              onChange={(e) => setSeverity(e.currentTarget.value as Severity)}
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s === 'critical'
                    ? 'Critical — red sticky banner'
                    : s === 'warning'
                      ? 'Warning — orange dismissible'
                      : 'Info — blue dismissible'}
                </option>
              ))}
            </select>
          </FormField>
        </CardBody>
      </Card>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title="Audience" />
        <CardBody>
          <FormField id="kind" label="Who sees this?">
            <select
              className="lbr-input"
              value={kind}
              onChange={(e) => setKind(e.currentTarget.value as Audience['kind'])}
            >
              <option value="all">All active libraries</option>
              <option value="tenant_ids">Pick specific libraries</option>
              <option value="plan_slugs">Libraries on specific plans</option>
              <option value="tags">Libraries with specific tags</option>
            </select>
          </FormField>

          {kind === 'tenant_ids' ? (
            <div
              style={{
                maxHeight: 240,
                overflowY: 'auto',
                border: '1px solid var(--color-border)',
                padding: 'var(--sp-2)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {tenants.map((t) => (
                <label key={t.id} style={{ display: 'block', padding: '4px 0' }}>
                  <input
                    type="checkbox"
                    checked={selectedTenants.includes(t.id)}
                    onChange={() => setSelectedTenants((arr) => toggleArrayValue(arr, t.id))}
                  />{' '}
                  {t.name} <code style={{ color: 'var(--color-text-muted)' }}>{t.slug}</code>
                </label>
              ))}
            </div>
          ) : null}

          {kind === 'plan_slugs' ? (
            <div>
              {plans.map((p) => (
                <label key={p.slug} style={{ display: 'inline-block', marginRight: 'var(--sp-3)' }}>
                  <input
                    type="checkbox"
                    checked={selectedPlans.includes(p.slug)}
                    onChange={() => setSelectedPlans((arr) => toggleArrayValue(arr, p.slug))}
                  />{' '}
                  {p.name} <code style={{ color: 'var(--color-text-muted)' }}>{p.slug}</code>
                </label>
              ))}
            </div>
          ) : null}

          {kind === 'tags' ? (
            <>
              <FormField
                id="tags"
                label="Tags (comma-separated)"
                hint={
                  knownTags.length
                    ? `Known tags: ${knownTags.join(', ')}`
                    : 'No tags yet. Tag libraries from their detail page.'
                }
              >
                <Input
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.currentTarget.value)}
                  placeholder="eu-region, beta"
                />
              </FormField>
            </>
          ) : null}
        </CardBody>
      </Card>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title="Delivery + scheduling" />
        <CardBody>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--sp-4)',
              marginBottom: 'var(--sp-3)',
            }}
          >
            <label>
              <input
                type="checkbox"
                checked={deliverInApp}
                onChange={(e) => setDeliverInApp(e.currentTarget.checked)}
              />{' '}
              Show in-app banner
            </label>
            <label>
              <input
                type="checkbox"
                checked={deliverEmail}
                onChange={(e) => setDeliverEmail(e.currentTarget.checked)}
              />{' '}
              Send email
            </label>
          </div>
          <div className="lbr-form-grid">
            <FormField id="publishAt" label="Publish at" hint="Leave blank to publish now.">
              <Input
                type="datetime-local"
                value={publishAt}
                onChange={(e) => setPublishAt(e.currentTarget.value)}
              />
            </FormField>
            <FormField id="expiresAt" label="Expires at" hint="Leave blank to never expire.">
              <Input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.currentTarget.value)}
              />
            </FormField>
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--sp-4)',
              marginTop: 'var(--sp-3)',
            }}
          >
            <label>
              <input
                type="checkbox"
                checked={dismissible}
                disabled={requiresAck}
                onChange={(e) => setDismissible(e.currentTarget.checked)}
              />{' '}
              Dismissible
            </label>
            <label>
              <input
                type="checkbox"
                checked={requiresAck}
                onChange={(e) => {
                  setRequiresAck(e.currentTarget.checked);
                  if (e.currentTarget.checked) setDismissible(false);
                }}
              />{' '}
              Require acknowledgement (critical only — blocks UI per user)
            </label>
          </div>
        </CardBody>
      </Card>

      <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
        <Button type="submit" variant="primary" loading={busy} disabled={!title || !bodyMarkdown}>
          Create
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
