'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SEARCH_MIN_CHARS } from '@libriant/shared/search';
import { Banner, Button, Card, CardBody, FormField, Textarea, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import { Combobox } from '@/components/Combobox';

type MemberOption = { id: string; memberNumber: string; fullName: string; email: string | null };
type BookOption = {
  id: string;
  title: string;
  authors: Array<{ authorId: string; fullName: string; order: number }>;
};

type Props = {
  slug: string;
  catalog: Catalog;
  locale: Locale;
};

/**
 * Place-hold form. A reservation is a member-on-book interest: any future
 * copy that becomes available satisfies the hold. The API decides whether
 * to immediately promote to `ready` (if there's an available copy and
 * this would be the head of the queue) or simply queue it.
 *
 * After submit we toast the outcome (queued at position N, or "ready to
 * pick up") and route back to the reservations list so the librarian
 * sees the new row right away.
 */
export function PlaceHoldForm({ slug, catalog, locale }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [book, setBook] = React.useState<BookOption | null>(null);
  const [member, setMember] = React.useState<MemberOption | null>(null);
  const [notes, setNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!book || !member) {
      setFormError(t('reservations.placeHold.missingFields'));
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await api<{
        reservation: { id: string; queuePosition: number | null };
        outcome: 'queued' | 'ready';
      }>(`/t/${slug}/reservations`, {
        method: 'POST',
        body: {
          bookId: book.id,
          memberId: member.id,
          notes: notes.trim() || undefined,
        },
      });
      toast.show({
        severity: 'success',
        title:
          res.outcome === 'ready'
            ? t('reservations.placeHold.successReady')
            : t('reservations.placeHold.successQueued', {
                position: res.reservation.queuePosition ?? 1,
              }),
        body: `${book.title} → ${member.fullName}`,
      });
      router.push(`/${locale}/t/${slug}/reservations`);
      router.refresh();
    } catch (err) {
      setFormError(translateApiError(err, t, t('common.states.error')));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {formError ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {formError}
        </Banner>
      ) : null}
      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardBody>
          <FormField id="hold-book" label={t('reservations.placeHold.book')} required>
            <Combobox<BookOption>
              id="hold-book"
              placeholder={t('reservations.placeHold.bookPlaceholder')}
              clearLabel={t('common.combobox.clear')}
              noMatchesText={t('common.combobox.noMatches')}
              value={book}
              onChange={setBook}
              endpoint={(q) => `/t/${slug}/catalog/books?q=${encodeURIComponent(q)}&limit=8`}
              minQueryChars={SEARCH_MIN_CHARS}
              minCharsText={t('common.search.minChars', { count: SEARCH_MIN_CHARS })}
              renderOption={(b) => (
                <div>
                  <div style={{ fontWeight: 500 }}>{b.title}</div>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                    {b.authors.map((a) => a.fullName).join(', ') || '—'}
                  </div>
                </div>
              )}
              renderSelected={(b) => (
                <div>
                  <div style={{ fontWeight: 500 }}>{b.title}</div>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                    {b.authors.map((a) => a.fullName).join(', ') || '—'}
                  </div>
                </div>
              )}
            />
          </FormField>
          <FormField id="hold-member" label={t('reservations.placeHold.member')} required>
            <Combobox<MemberOption>
              id="hold-member"
              placeholder={t('reservations.placeHold.memberPlaceholder')}
              clearLabel={t('common.combobox.clear')}
              noMatchesText={t('common.combobox.noMatches')}
              value={member}
              onChange={setMember}
              endpoint={(q) =>
                `/t/${slug}/members?q=${encodeURIComponent(q)}&limit=8&status=active`
              }
              renderOption={(m) => (
                <div>
                  <div style={{ fontWeight: 500 }}>{m.fullName}</div>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                    {m.memberNumber}
                    {m.email ? ` · ${m.email}` : ''}
                  </div>
                </div>
              )}
              renderSelected={(m) => (
                <div>
                  <div style={{ fontWeight: 500 }}>{m.fullName}</div>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                    {m.memberNumber}
                  </div>
                </div>
              )}
            />
          </FormField>
          <FormField id="hold-notes" label={t('reservations.placeHold.notes')}>
            <Textarea
              id="hold-notes"
              placeholder={t('reservations.placeHold.notesPlaceholder')}
              value={notes}
              onChange={(e) => setNotes(e.currentTarget.value)}
              rows={3}
            />
          </FormField>
        </CardBody>
      </Card>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
        <Link
          href={`/${locale}/t/${slug}/reservations`}
          className="lbr-btn lbr-btn--ghost lbr-btn--md"
        >
          {t('common.actions.cancel')}
        </Link>
        <Button type="submit" variant="primary" loading={submitting} disabled={!book || !member}>
          {t('reservations.placeHold.submit')}
        </Button>
      </div>
    </form>
  );
}
