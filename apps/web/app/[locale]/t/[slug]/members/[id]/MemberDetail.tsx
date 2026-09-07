'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Banner, Button, Card, CardBody, CardHeader, Modal, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import type { FieldDef } from '@/components/DynamicFields';
import { FinesPanel, type FinesListResponse } from '@/components/FinesPanel';
import { formatMoney } from '@/components/money';
import { MemberForm, type MemberInitial } from '../new/MemberForm';
import { PhotoUploader } from './PhotoUploader';
import { AGE_OF_MAJORITY_YEARS, ageInCompletedYears, dsarStrings } from './dsar-strings';
import { dataPort } from '@/lib/ports';

type Status = 'active' | 'suspended' | 'archived';

export type DetailMember = MemberInitial & {
  status: Status;
  archivedAt: string | null;
  photoAssetRef: string | null;
  staffNotes: string | null;
  joinedAt: string;
  circulation: {
    activeLoans: number;
    activeReservations: number;
    outstandingFinesCents: number;
    outstandingFinesCount: number;
  };
};

type Props = {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  initial: DetailMember;
  customFields: FieldDef[];
  /** This member's outstanding fines, server-rendered. Null when the fetch failed. */
  fines: FinesListResponse | null;
  finesError: string | null;
  /** owner | admin | librarian — may record a payment. */
  canSettleFines: boolean;
  /** owner | admin — may write a fine off. */
  canWriteOffFines: boolean;
  /**
   * owner | admin | librarian — may produce this member's Art. 15 / Art. 20
   * file. A volunteer may read the page but is refused the export by the API
   * (privacy-legal-15); hiding the control keeps them out of a 403 rather than
   * being the thing that stops them.
   */
  canExportSubjectData: boolean;
};

/**
 * Two-mode detail page:
 *
 *   - **View** — read-only summary card + circulation card + actions (set
 *     status / archive / restore / photo upload).
 *   - **Edit** — reuses `<MemberForm>` with `initial={member}` so the
 *     librarian can change anything they could when creating the row.
 *
 * State changes (suspend / reactivate / archive / restore) call dedicated
 * endpoints; refresh-via-router keeps server-rendered counts current.
 */
export function MemberDetail({
  slug,
  catalog,
  locale,
  initial,
  customFields,
  fines,
  finesError,
  canSettleFines,
  canWriteOffFines,
  canExportSubjectData,
}: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [member, setMember] = React.useState<DetailMember>(initial);
  const [editing, setEditing] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  /**
   * Why the archive was refused, rendered INSIDE the confirmation dialog
   * (frontend-05). It used to be a critical toast, and `Modal` opens a native
   * `<dialog>` via `showModal()` — top layer, everything outside inert — so
   * the toast was painted under the backdrop and could be neither read nor
   * dismissed. "This member still has 2 open loans" is precisely the message
   * that must reach the librarian, and it never did.
   */
  const [archiveError, setArchiveError] = React.useState<React.ReactNode>(null);
  const openArchive = () => {
    setArchiveError(null);
    setArchiveOpen(true);
  };
  const closeArchive = () => {
    setArchiveError(null);
    setArchiveOpen(false);
  };
  const [statusBusy, setStatusBusy] = React.useState(false);
  const [archiveBusy, setArchiveBusy] = React.useState(false);
  /**
   * privacy-legal-15. The download is a plain link to the API rather than a
   * fetch-then-Blob dance: the endpoint answers with
   * `Content-Disposition: attachment`, `/lbr-api/*` is same-origin through the
   * Next rewrite so the session cookie rides along, and a link that the browser
   * saves straight to disk never puts a patron's whole record on a screen at
   * the counter.
   *
   * It still sits behind a dialog. Producing this file is a disclosure to a
   * person standing in front of the librarian, and the two things they have to
   * get right — who is entitled to receive it, and whether the subject is a
   * child — belong in front of them at that moment, not in a manual.
   */
  const [exportOpen, setExportOpen] = React.useState(false);
  const dsar = dsarStrings(locale);
  const exportHref = dataPort().resourceUrl(`/t/${slug}/members/${member.id}/data-export`);
  /**
   * Derived from the date of birth already on this page — no extra request.
   *
   * The school-library presumption (a `school` tenant with no date of birth on
   * file) is deliberately NOT mirrored here: the library's type is owner/admin
   * -only over the API, so fetching it would 403 for the librarian this control
   * is for. It lives in the produced bundle's `handling` notice instead, which
   * costs one lookup per export rather than one per page view.
   */
  const memberAge = member.dateOfBirth ? ageInCompletedYears(member.dateOfBirth, new Date()) : null;
  const memberIsMinor = memberAge !== null && memberAge < AGE_OF_MAJORITY_YEARS;

  React.useEffect(() => {
    setMember(initial);
  }, [initial]);

  async function setStatus(next: 'active' | 'suspended', reason?: string) {
    setStatusBusy(true);
    try {
      const updated = await api<DetailMember>(`/t/${slug}/members/${member.id}/status`, {
        method: 'PUT',
        body: { status: next, ...(reason ? { reason } : {}) },
      });
      setMember({ ...member, ...updated });
      toast.show({
        severity: 'success',
        title: t(next === 'active' ? 'members.actions.reactivated' : 'members.actions.suspended'),
      });
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: translateApiError(err, t, t('common.states.error')),
      });
    } finally {
      setStatusBusy(false);
    }
  }

  async function archive() {
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      const updated = await api<DetailMember>(`/t/${slug}/members/${member.id}`, {
        method: 'DELETE',
      });
      setMember({ ...member, ...updated });
      toast.show({ severity: 'success', title: t('members.actions.archived') });
      closeArchive();
      router.refresh();
    } catch (err) {
      const message = translateApiError(err, t, t('common.states.error'));
      // The API may include a structured body with active loan / reservation
      // counts when archive is refused. Surface that directly — in the dialog
      // the librarian is standing in, not in a toast behind it.
      if (err instanceof ApiError && err.body.activeLoans !== undefined) {
        // Composed from EXISTING catalogue keys rather than a new sentence, so
        // the counts are bilingual today. `${n} loan(s), ${n} reservation(s)`
        // was hardcoded English in a product that ships Greek first.
        setArchiveError(
          <>
            <strong>{t('members.actions.archiveBlocked')}</strong>
            <div>
              {t('members.detail.activeLoans')}: {String(err.body.activeLoans)} ·{' '}
              {t('members.detail.activeReservations')}: {String(err.body.activeReservations ?? 0)}
            </div>
          </>,
        );
      } else {
        setArchiveError(message);
      }
    } finally {
      setArchiveBusy(false);
    }
  }

  async function restore() {
    setArchiveBusy(true);
    try {
      const updated = await api<DetailMember>(`/t/${slug}/members/${member.id}`, {
        method: 'PATCH',
        body: { archived: false },
      });
      setMember({ ...member, ...updated });
      toast.show({ severity: 'success', title: t('members.actions.restored') });
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: translateApiError(err, t, t('common.states.error')),
      });
    } finally {
      setArchiveBusy(false);
    }
  }

  if (editing) {
    return (
      <Card>
        <CardHeader title={t('members.form.title')} subtitle={t('members.form.subtitle')} />
        <CardBody>
          <MemberForm
            slug={slug}
            catalog={catalog}
            locale={locale}
            customFields={customFields}
            initial={member}
            cancelHref={`/${locale}/t/${slug}/members/${member.id}`}
            onSaved={(updated) => {
              setMember({ ...member, ...updated });
              setEditing(false);
            }}
          />
        </CardBody>
      </Card>
    );
  }

  // The library's own currency, which this endpoint does not send: the member
  // payload has `outstandingFinesCents` and no currency at all, so this page
  // used to label every library's debts in euros. The fines list carries the
  // configured one on both its summaries; EUR is only the fallback for the case
  // where that request failed and there is no fines card to read it from.
  const currency = fines?.summary?.currency ?? fines?.tenantSummary.currency ?? 'EUR';
  const fmtCurrency = (cents: number) => formatMoney(cents, currency, locale);

  return (
    <>
      {member.archivedAt ? (
        <Banner severity="warning" title={t('members.detail.archivedNotice')}>
          {t('members.detail.archivedHint')}
        </Banner>
      ) : member.status === 'suspended' ? (
        <Banner severity="info">{t('members.detail.suspendedHint')}</Banner>
      ) : null}

      <div
        className="lbr-split"
        style={{
          marginTop: 'var(--sp-4)',
        }}
      >
        <div>
          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader
              title={t('members.detail.summary')}
              actions={
                <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                  {t('common.actions.edit')}
                </Button>
              }
            />
            <CardBody>
              <dl className="lbr-dl">
                <dt>{t('members.form.fullName')}</dt>
                <dd>{member.fullName}</dd>
                <dt>{t('members.form.memberNumber')}</dt>
                <dd>{member.memberNumber}</dd>
                {member.email ? (
                  <>
                    <dt>{t('members.form.email')}</dt>
                    <dd>{member.email}</dd>
                  </>
                ) : null}
                {member.phone ? (
                  <>
                    <dt>{t('members.form.phone')}</dt>
                    <dd>{member.phone}</dd>
                  </>
                ) : null}
                {member.dateOfBirth ? (
                  <>
                    <dt>{t('members.form.dateOfBirth')}</dt>
                    <dd>{new Date(member.dateOfBirth).toLocaleDateString(locale)}</dd>
                  </>
                ) : null}
                <dt>{t('members.detail.joined')}</dt>
                <dd>{new Date(member.joinedAt).toLocaleDateString(locale)}</dd>
                {member.addressLine1 || member.city || member.country ? (
                  <>
                    <dt>{t('members.form.address')}</dt>
                    <dd>
                      {[member.addressLine1, member.city, member.postalCode, member.country]
                        .filter(Boolean)
                        .join(', ')}
                    </dd>
                  </>
                ) : null}
              </dl>
            </CardBody>
          </Card>

          {/* Money before custom fields: a person is standing at the counter. */}
          <div style={{ marginBottom: 'var(--sp-4)' }}>
            {finesError ? (
              <Card>
                <CardHeader title={t('loans.fines.title')} />
                <CardBody>
                  <Banner severity="critical">{finesError}</Banner>
                </CardBody>
              </Card>
            ) : fines ? (
              <FinesPanel
                slug={slug}
                locale={locale}
                catalog={catalog}
                scope={{ kind: 'member', memberId: member.id }}
                initial={fines}
                canSettle={canSettleFines}
                canWriteOff={canWriteOffFines}
                // Settling a fine moves the circulation card above without a
                // reload — the API returns the member's recomputed totals with
                // the resolution for exactly this.
                onSummaryChange={(summary) =>
                  setMember((prev) => ({
                    ...prev,
                    circulation: {
                      ...prev.circulation,
                      outstandingFinesCents: summary.outstandingCents,
                      outstandingFinesCount: summary.outstandingCount,
                    },
                  }))
                }
              />
            ) : null}
          </div>

          {customFields.length > 0 ? (
            <Card style={{ marginBottom: 'var(--sp-4)' }}>
              <CardHeader title={t('members.form.customFields')} />
              <CardBody>
                {Object.keys(member.customFields).length === 0 ? (
                  <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
                    {t('members.detail.noCustomValues')}
                  </p>
                ) : (
                  <dl className="lbr-dl">
                    {Object.entries(member.customFields).map(([key, value]) => {
                      if (value === null || value === undefined || value === '') return null;
                      const def = customFields.find((f) => f.fieldKey === key);
                      const label =
                        def?.labelJson[locale] ?? def?.labelJson.en ?? def?.labelJson.el ?? key;
                      return (
                        <React.Fragment key={key}>
                          <dt>{label}</dt>
                          <dd>
                            {Array.isArray(value)
                              ? value.join(', ')
                              : typeof value === 'boolean'
                                ? value
                                  ? 'Yes'
                                  : 'No'
                                : String(value)}
                          </dd>
                        </React.Fragment>
                      );
                    })}
                  </dl>
                )}
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div>
          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader title={t('members.detail.photo')} />
            <CardBody>
              <PhotoUploader
                slug={slug}
                memberId={member.id}
                photoAssetRef={member.photoAssetRef}
                catalog={catalog}
                locale={locale}
                onChange={(ref) => setMember({ ...member, photoAssetRef: ref })}
              />
            </CardBody>
          </Card>

          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader title={t('members.detail.circulation')} />
            <CardBody>
              <dl className="lbr-dl">
                <dt>{t('members.detail.activeLoans')}</dt>
                <dd>
                  <Link href={`/${locale}/t/${slug}/loans?memberId=${member.id}&status=active`}>
                    {member.circulation.activeLoans}
                  </Link>
                </dd>
                <dt>{t('members.detail.activeReservations')}</dt>
                <dd>
                  <Link href={`/${locale}/t/${slug}/reservations?memberId=${member.id}`}>
                    {member.circulation.activeReservations}
                  </Link>
                </dd>
                <dt>{t('members.detail.outstandingFines')}</dt>
                <dd>
                  {fmtCurrency(member.circulation.outstandingFinesCents)}
                  {member.circulation.outstandingFinesCount > 0 ? (
                    // The count, not just the total: two fines adding up to
                    // €0.00 and no fines at all are the same amount, and only
                    // one of them has anything to settle.
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      {' · '}
                      {t('loans.fines.summary.count', {
                        count: member.circulation.outstandingFinesCount,
                      })}
                    </span>
                  ) : null}
                </dd>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t('members.detail.actions')} />
            <CardBody>
              <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
                {canExportSubjectData ? (
                  <Button variant="secondary" onClick={() => setExportOpen(true)}>
                    {dsar.action}
                  </Button>
                ) : null}
                {member.archivedAt ? (
                  <Button variant="primary" loading={archiveBusy} onClick={restore}>
                    {t('members.actions.restore')}
                  </Button>
                ) : (
                  <>
                    {member.status === 'active' ? (
                      <Button
                        variant="secondary"
                        loading={statusBusy}
                        onClick={() => setStatus('suspended')}
                      >
                        {t('members.actions.suspend')}
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        loading={statusBusy}
                        onClick={() => setStatus('active')}
                      >
                        {t('members.actions.reactivate')}
                      </Button>
                    )}
                    <Button variant="ghost" onClick={openArchive}>
                      {t('members.actions.archive')}
                    </Button>
                  </>
                )}
              </div>
            </CardBody>
          </Card>
        </div>
      </div>

      <Modal
        open={archiveOpen}
        onClose={closeArchive}
        title={t('members.actions.archiveConfirmTitle', { name: member.fullName })}
        role="alertdialog"
        error={archiveError}
        actions={
          <>
            <Button variant="ghost" onClick={closeArchive}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="danger" loading={archiveBusy} onClick={archive}>
              {t('members.actions.archive')}
            </Button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>{t('members.actions.archiveConfirmBody')}</p>
      </Modal>

      <Modal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title={dsar.title.replace('{name}', member.fullName)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setExportOpen(false)}>
              {dsar.cancel}
            </Button>
            <a
              className="lbr-btn lbr-btn--primary lbr-btn--md"
              href={exportHref}
              download
              onClick={() => setExportOpen(false)}
            >
              {dsar.download}
            </a>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>{dsar.body}</p>
        <p>{dsar.contains}</p>
        {memberIsMinor ? (
          <Banner severity="warning">{dsar.minor.replace('{age}', String(memberAge))}</Banner>
        ) : null}
        <p style={{ marginBottom: 0, color: 'var(--color-text-muted)' }}>{dsar.review}</p>
      </Modal>
    </>
  );
}
