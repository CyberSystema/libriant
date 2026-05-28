'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, Modal, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';
import { type ActiveAnnouncement } from '@/lib/announcements';

type Props = {
  slug: string;
  initial: ActiveAnnouncement[];
};

const SEVERITY_TO_BANNER: Record<ActiveAnnouncement['severity'], 'info' | 'warning' | 'critical'> =
  {
    info: 'info',
    warning: 'warning',
    critical: 'critical',
  };

/**
 * Top-of-page banners + critical-ack modal. Behavior table:
 *
 *   info       — blue, dismissible (one-click hide), per-tenant scope.
 *   warning    — orange, dismissible (one-click hide), per-tenant scope.
 *   critical
 *     no ack   — red, sticky (no dismiss control), per-tenant scope.
 *     requires — red, sticky + BLOCKING MODAL until this user acknowledges.
 *                Per-user delivery row; each user has to ack their own copy.
 *
 * Dismiss + ack mutate state via the API, then locally remove the item so
 * the UI is instantly responsive without waiting for the 60 s cache to
 * lapse. A page reload would also reflect the new state.
 */
export function AnnouncementsTopBanners({ slug, initial }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = React.useState(initial);
  const [pending, setPending] = React.useState<string | null>(null);

  // The critical+ack item that's blocking THIS user. At most one at a time;
  // if there are several, we stack them — show one, ack it, then the next.
  const blocking = items.find((i) => i.severity === 'critical' && i.requiresAck);

  async function dismiss(id: string) {
    setPending(id);
    try {
      await api(`/t/${slug}/announcements/${id}/dismiss`, { method: 'POST', body: {} });
      setItems((prev) => prev.filter((x) => x.id !== id));
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    } finally {
      setPending(null);
    }
  }

  async function acknowledge(id: string) {
    setPending(id);
    try {
      await api(`/t/${slug}/announcements/${id}/ack`, { method: 'POST', body: {} });
      setItems((prev) => prev.filter((x) => x.id !== id));
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    } finally {
      setPending(null);
    }
  }

  // Non-blocking items render as a stack of banners at the top. Blocking
  // ones use the modal below and are excluded from the banner list (we
  // don't double-render them).
  const banners = items.filter((i) => !(i.severity === 'critical' && i.requiresAck));

  return (
    <>
      {banners.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--sp-2)',
            marginBottom: 'var(--sp-3)',
          }}
        >
          {banners.map((a) => (
            <Banner key={a.id} severity={SEVERITY_TO_BANNER[a.severity]}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 'var(--sp-3)',
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 'var(--sp-1)' }}>{a.title}</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{a.bodyMarkdown}</div>
                </div>
                {a.dismissible ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={pending === a.id}
                    onClick={() => dismiss(a.id)}
                  >
                    Dismiss
                  </Button>
                ) : null}
              </div>
            </Banner>
          ))}
        </div>
      ) : null}

      {blocking ? (
        <Modal
          open
          onClose={() => {
            /* not closeable — must acknowledge */
          }}
          title={blocking.title}
          actions={
            <Button
              variant="primary"
              loading={pending === blocking.id}
              onClick={() => acknowledge(blocking.id)}
            >
              I understand
            </Button>
          }
        >
          <div style={{ whiteSpace: 'pre-wrap' }}>{blocking.bodyMarkdown}</div>
          <p
            style={{
              fontSize: 'var(--fs-xs)',
              color: 'var(--color-text-muted)',
              marginTop: 'var(--sp-3)',
            }}
          >
            You'll see this every time you sign in until you acknowledge it.
          </p>
        </Modal>
      ) : null}
    </>
  );
}
