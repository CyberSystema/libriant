'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, FormField, Input, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

type Props = {
  tenantId: string;
  initialTags: string[];
  initialKnownTags: string[];
};

/**
 * Edit the tag set for one tenant. Tags are lowercase free-form labels;
 * the admin types a comma-separated list and the server normalises them
 * (trim, lowercase, dedupe, max 50 chars each).
 */
export function TenantTagsEditor({ tenantId, initialTags, initialKnownTags }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [value, setValue] = React.useState(initialTags.join(', '));
  const [busy, setBusy] = React.useState(false);
  const known = initialKnownTags.filter((t) => !initialTags.includes(t));

  async function save() {
    setBusy(true);
    try {
      const tags = value
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const res = await api<{ tenant: { tags: string[] } }>(`/admin/tenants/${tenantId}/tags`, {
        method: 'PUT',
        body: { tags },
      });
      setValue(res.tenant.tags.join(', '));
      toast.show({ severity: 'success', title: 'Tags saved.' });
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    } finally {
      setBusy(false);
    }
  }

  function appendTag(t: string) {
    const existing = value
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (existing.includes(t)) return;
    setValue([...existing, t].join(', '));
  }

  return (
    <>
      <FormField
        id="tags"
        label="Tags (comma-separated)"
        hint="Lowercase letters / digits / hyphens. Saved trimmed + deduped."
      >
        <Input
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          placeholder="eu-region, beta"
        />
      </FormField>
      {known.length > 0 ? (
        <div style={{ marginTop: 'var(--sp-2)', fontSize: 'var(--fs-sm)' }}>
          <span style={{ color: 'var(--color-text-muted)' }}>Used elsewhere: </span>
          {known.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => appendTag(t)}
              className="lbr-btn lbr-btn--ghost lbr-btn--sm"
              style={{ marginRight: 'var(--sp-1)' }}
            >
              + {t}
            </button>
          ))}
        </div>
      ) : null}
      <div style={{ marginTop: 'var(--sp-3)' }}>
        <Button variant="primary" loading={busy} onClick={save}>
          Save tags
        </Button>
      </div>
    </>
  );
}
