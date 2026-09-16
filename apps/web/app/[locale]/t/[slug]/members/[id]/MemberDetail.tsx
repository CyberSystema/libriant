'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  FormField,
  Input,
  Modal,
  Textarea,
  useToast,
} from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError } from '@/lib/api';
import { dataPort } from '@/lib/ports';
import { translateApiError } from '@/lib/api-errors';
import type { FieldDef } from '@/components/DynamicFields';
import { formatMoney } from '@/components/money';
import { PhotoUploader } from './PhotoUploader';
import { AGE_OF_MAJORITY_YEARS, ageInCompletedYears, dsarStrings } from './dsar-strings';

/** `GET /t/:slug/patrons/:id`. */
export type PatronRecord = {
  id: string;
  patronNumber: string | null;
  fullName: string;
  sortName: string;
  status: 'active' | 'suspended' | 'closed';
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  photoAssetRef: string | null;
  patronCategoryId: string | null;
  homeBranchId: string | null;
  joinedAt: string | null;
  expiresAt: string | null;
  staffNotes: string | null;
  erasedAt: string | null;
  archivedAt: string | null;
  mergedIntoId: string | null;
  updatedAt: string;
  /** Raw, keyed by field key. Labels come from the definitions, when they load. */
  customFields: Record<string, unknown> | null;
  category: { id: string; code: string; name: string } | null;
  cards: {
    id: string;
    barcode: string;
    status: string;
    issuedAt: string;
    retiredAt: string | null;
  }[];
};

/**
 * One row of `GET /t/:slug/fees?patronId=`.
 *
 * EVERY MONEY VALUE IS A STRING. `fees.owed_cents` is a `bigint` and the
 * controller serialises it with `String(...)` rather than letting JSON turn it
 * into a float — so a component that hands it to `formatMoney`, which takes a
 * number, renders `NaN`. See {@link money} for the one place that conversion
 * happens and why it is safe.
 */
export type FeeRow = {
  id: string;
  feeTypeCode: string | null;
  description: string | null;
  amountCents: string;
  owedCents: string;
  currency: string;
  status: string;
  createdAt: string;
};

/** `GET /t/:slug/fees/balances/:patronId` — a set of rows, never a scalar. */
export type Balance = { currency: string; owedCents: string };

type Props = {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  initial: PatronRecord;
  customFieldDefs: FieldDef[];
  fees: { items: FeeRow[]; nextCursor: string | null } | null;
  feesError: string | null;
  balances: Balance[];
  openLoans: { shown: number; more: boolean } | null;
  openHolds: { shown: number; more: boolean } | null;
  canSettleFees: boolean;
  canWriteOffFees: boolean;
  canExportSubjectData: boolean;
};

/**
 * One money value, from the string the API sends.
 *
 * `Number()` on a cents string is safe to `Number.MAX_SAFE_INTEGER` — about 90
 * trillion euros — and a library fine is not going to reach it. Doing it HERE,
 * once, rather than at each call site is the point: the conversion is the trap,
 * and `formatMoney(row.owedCents, …)` compiles happily and renders `NaN`
 * because `string` satisfies nothing that would complain.
 */
function money(cents: string, currency: string, locale: Locale): string {
  return formatMoney(Number(cents), currency, locale);
}

/**
 * The patron record screen, on the 2.0 surface (phase 20n).
 *
 * ## What changed under it
 *
 * `GET /patrons/:id` returns a richer record than 1.0's member did — a resolved
 * `category`, the patron's `cards[]`, an `expiresAt`, and `customFields`, which
 * phase 20n added to that read because the upgrade had been copying them since
 * 19b and nothing returned them. It does NOT return the derived counts 1.0
 * packed into a `circulation` object, so those are separate reads and each can
 * fail on its own.
 *
 * ## Money is per-currency and arrives as strings
 *
 * 1.0 summed one `outstandingFinesCents` and labelled it in euros. A patron who
 * owes EUR 4 and USD 3 has no single number, so `GET /fees/balances/:patronId`
 * returns a ROW PER CURRENCY and this screen renders them all. Every cents
 * value is a string — see {@link money}.
 *
 * ## Settling is NOT here
 *
 * 1.0 settled one fine by id. 2.0 settles a patron's BALANCE by amount through
 * `POST /fees/payments`, which is a different model with a cash drawer, a
 * receipt and an allocation order behind it — phase 18 chose that deliberately,
 * so this is a rewrite rather than a repoint and belongs with the fees family.
 * The card reads; the buttons that would write are not drawn rather than drawn
 * broken, and `canSettleFees` is threaded through ready for them.
 */
export function MemberDetail({
  slug,
  catalog,
  locale,
  initial,
  customFieldDefs,
  fees,
  feesError,
  balances,
  openLoans,
  openHolds,
  canExportSubjectData,
}: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [patron, setPatron] = React.useState(initial);
  const [editing, setEditing] = React.useState(false);
  const [statusBusy, setStatusBusy] = React.useState(false);
  const [archiveBusy, setArchiveBusy] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  /**
   * Why the archive was refused, rendered INSIDE the dialog (frontend-05): a
   * `Modal` opens a native `<dialog>` with `showModal()`, so a toast paints
   * under the backdrop.
   */
  const [archiveError, setArchiveError] = React.useState<React.ReactNode | null>(null);
  const [exportOpen, setExportOpen] = React.useState(false);

  React.useEffect(() => setPatron(initial), [initial]);

  const dsar = dsarStrings(locale);
  const exportHref = dataPort().resourceUrl(`/t/${slug}/patrons/${patron.id}/data-export`);
  const age = patron.dateOfBirth ? ageInCompletedYears(patron.dateOfBirth, new Date()) : null;
  const isMinor = age !== null && age < AGE_OF_MAJORITY_YEARS;
  const expired = patron.expiresAt !== null && new Date(patron.expiresAt) <= new Date();

  async function setStatus(next: 'active' | 'suspended') {
    setStatusBusy(true);
    try {
      const updated = await dataPort().post<PatronRecord>(
        `/t/${slug}/patrons/${patron.id}/status`,
        { status: next },
      );
      setPatron({ ...patron, ...updated });
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
      const updated = await dataPort().post<PatronRecord>(
        `/t/${slug}/patrons/${patron.id}/archive`,
      );
      setPatron({ ...patron, ...updated });
      toast.show({ severity: 'success', title: t('members.actions.archived') });
      setArchiveOpen(false);
      router.refresh();
    } catch (err) {
      // THE FIELD NAMES CHANGED, and the 1.0 screen read the old ones.
      //
      // 1.0 sent `activeLoans` / `activeReservations`; 2.0 refuses with
      // `code: 'patron.hasOpenBusiness'` and `openLoans` / `openHolds` /
      // `owedCents`. A repoint that kept the old test would have found
      // `activeLoans === undefined` on every refusal and silently fallen back
      // to the generic message — the dialog going quiet on the one thing it
      // exists to say. 2.0 also refuses for MONEY OWED, which 1.0 never did, so
      // there is a third line to show.
      if (err instanceof ApiError && err.body.code === 'patron.hasOpenBusiness') {
        const owed = String(err.body.owedCents ?? '0');
        setArchiveError(
          <>
            <strong>{t('members.actions.archiveBlocked')}</strong>
            <div>
              {t('members.detail.activeLoans')}: {String(err.body.openLoans ?? 0)} ·{' '}
              {t('members.detail.activeReservations')}: {String(err.body.openHolds ?? 0)}
              {owed !== '0' ? (
                <>
                  {' · '}
                  {t('members.detail.owed')}: {money(owed, balances[0]?.currency ?? 'EUR', locale)}
                </>
              ) : null}
            </div>
          </>,
        );
      } else {
        setArchiveError(translateApiError(err, t, t('common.states.error')));
      }
    } finally {
      setArchiveBusy(false);
    }
  }

  async function restore() {
    setArchiveBusy(true);
    try {
      const updated = await dataPort().post<PatronRecord>(
        `/t/${slug}/patrons/${patron.id}/restore`,
      );
      setPatron({ ...patron, ...updated });
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
      <PatronEditForm
        slug={slug}
        catalog={catalog}
        locale={locale}
        patron={patron}
        onSaved={(next) => {
          setPatron({ ...patron, ...next });
          setEditing(false);
          router.refresh();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const customValues = Object.entries(patron.customFields ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );

  return (
    <>
      {patron.erasedAt ? (
        <Banner severity="warning" title={t('members.detail.erasedNotice')}>
          {t('members.detail.erasedHint')}
        </Banner>
      ) : null}
      {patron.archivedAt ? (
        <Banner severity="warning" title={t('members.detail.archivedNotice')}>
          {t('members.detail.archivedHint')}
        </Banner>
      ) : null}

      <div className="lbr-split" style={{ marginTop: 'var(--sp-4)' }}>
        <div>
          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader
              title={t('members.form.title')}
              actions={
                <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                  {t('common.actions.edit')}
                </Button>
              }
            />
            <CardBody>
              <dl className="lbr-dl">
                <dt>{t('members.columns.cardNumber')}</dt>
                <dd>{patron.patronNumber ?? '—'}</dd>
                <dt>{t('members.columns.name')}</dt>
                <dd>
                  <strong>{patron.fullName}</strong>
                </dd>
                <dt>{t('members.columns.email')}</dt>
                <dd>{patron.email ?? '—'}</dd>
                <dt>{t('members.columns.phone')}</dt>
                <dd>{patron.phone ?? '—'}</dd>
                <dt>{t('members.detail.category')}</dt>
                <dd>{patron.category?.name ?? '—'}</dd>
                <dt>{t('members.detail.expiresAt')}</dt>
                <dd>
                  {patron.expiresAt
                    ? new Date(patron.expiresAt).toLocaleDateString(locale)
                    : t('members.detail.neverExpires')}
                  {expired ? ` · ${t('members.status.expired')}` : ''}
                </dd>
                {patron.staffNotes ? (
                  <>
                    <dt>{t('members.detail.staffNotes')}</dt>
                    <dd>
                      <pre style={{ whiteSpace: 'pre-wrap', font: 'inherit', margin: 0 }}>
                        {patron.staffNotes}
                      </pre>
                    </dd>
                  </>
                ) : null}
              </dl>
            </CardBody>
          </Card>

          {patron.cards.length > 0 ? (
            <Card style={{ marginBottom: 'var(--sp-4)' }}>
              <CardHeader
                title={t('members.detail.cards')}
                subtitle={t('members.detail.cardsHint')}
              />
              <CardBody>
                <div className="lbr-table-wrap">
                  <table className="lbr-table">
                    <thead>
                      <tr>
                        <th>{t('members.columns.cardNumber')}</th>
                        <th>{t('members.columns.status')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {patron.cards.map((c) => (
                        <tr key={c.id}>
                          <td>{c.barcode}</td>
                          {/* A RETIRED card still resolves at the desk on
                              purpose — "a found card should be recognised as
                              the one that was reported lost on the 3rd, not
                              rejected as an unknown number" — so the row stays
                              and says so. */}
                          <td>{c.retiredAt ? t('members.detail.cardRetired') : c.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardBody>
            </Card>
          ) : null}

          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader title={t('loans.fines.title')} subtitle={t('members.detail.feesHint')} />
            <CardBody>
              {feesError ? (
                <Banner severity="critical">{feesError}</Banner>
              ) : balances.length === 0 && (fees?.items.length ?? 0) === 0 ? (
                <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
                  {t('members.detail.nothingOwed')}
                </p>
              ) : (
                <>
                  {/* ONE LINE PER CURRENCY. Summing them would be arithmetic on
                      two different units. */}
                  <p style={{ margin: '0 0 var(--sp-3)', fontWeight: 500 }}>
                    {balances.map((b) => money(b.owedCents, b.currency, locale)).join(' · ')}
                  </p>
                  {fees && fees.items.length > 0 ? (
                    <div className="lbr-table-wrap">
                      <table className="lbr-table">
                        <thead>
                          <tr>
                            <th>{t('members.detail.feeReason')}</th>
                            <th>{t('members.detail.owed')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fees.items.map((f) => (
                            <tr key={f.id}>
                              <td>{f.description ?? f.feeTypeCode ?? '—'}</td>
                              <td>{money(f.owedCents, f.currency, locale)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  <p
                    style={{
                      color: 'var(--color-text-muted)',
                      fontSize: 'var(--fs-xs)',
                      marginBottom: 0,
                    }}
                  >
                    {t('members.detail.settleElsewhere')}
                  </p>
                </>
              )}
            </CardBody>
          </Card>

          {customValues.length > 0 ? (
            <Card>
              <CardHeader
                title={t('members.form.customFields')}
                subtitle={customFieldDefs.length === 0 ? t('members.detail.rawFields') : undefined}
              />
              <CardBody>
                <dl className="lbr-dl">
                  {customValues.map(([key, value]) => {
                    const def = customFieldDefs.find((f) => f.fieldKey === key);
                    const label = def?.labelJson[locale] ?? def?.labelJson.en ?? key;
                    return (
                      <React.Fragment key={key}>
                        <dt>{label}</dt>
                        <dd>{Array.isArray(value) ? value.join(', ') : String(value)}</dd>
                      </React.Fragment>
                    );
                  })}
                </dl>
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
                patronId={patron.id}
                photoAssetRef={patron.photoAssetRef}
                catalog={catalog}
                locale={locale}
                onChange={(ref) => setPatron({ ...patron, photoAssetRef: ref })}
              />
            </CardBody>
          </Card>

          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader title={t('members.detail.circulation')} />
            <CardBody>
              <dl className="lbr-dl">
                <dt>{t('members.detail.activeLoans')}</dt>
                {/* An UNKNOWN count is not zero. "No loans" and "we could not
                    ask" are different answers, and only one of them means this
                    patron can be archived. */}
                <dd>{openLoans ? `${openLoans.shown}${openLoans.more ? '+' : ''}` : '—'}</dd>
                <dt>{t('members.detail.activeReservations')}</dt>
                <dd>{openHolds ? `${openHolds.shown}${openHolds.more ? '+' : ''}` : '—'}</dd>
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
                {patron.archivedAt ? (
                  <Button variant="primary" loading={archiveBusy} onClick={restore}>
                    {t('members.actions.restore')}
                  </Button>
                ) : (
                  <>
                    {patron.status === 'active' ? (
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
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setArchiveError(null);
                        setArchiveOpen(true);
                      }}
                    >
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
        onClose={() => setArchiveOpen(false)}
        title={t('members.actions.archiveConfirmTitle', { name: patron.fullName })}
        role="alertdialog"
        error={archiveError}
        actions={
          <>
            <Button variant="ghost" onClick={() => setArchiveOpen(false)}>
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
        title={dsar.title.replace('{name}', patron.fullName)}
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
        {isMinor ? (
          <Banner severity="warning">{dsar.minor.replace('{age}', String(age))}</Banner>
        ) : null}
        <p style={{ marginBottom: 0, color: 'var(--color-text-muted)' }}>{dsar.review}</p>
      </Modal>
    </>
  );
}

/**
 * The scalar fields a librarian can correct, and nothing else.
 *
 * The same shape as the catalogue's `BibSimpleForm`, and for the same reason:
 * 1.0's `MemberForm` is one component serving both create and edit, and it
 * writes 1.0 scalars to a route the cutover deletes. Repointing the whole thing
 * is the enrolment phase's job — it has to decide about the first card, the
 * home branch, the category and the expiry date. Until then this screen must
 * still be able to fix a misspelt name, so it owns a small editor over
 * `PATCH /patrons/:id` rather than mounting a form that would write to the
 * wrong table.
 */
function PatronEditForm({
  slug,
  catalog,
  locale,
  patron,
  onSaved,
  onCancel,
}: {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  patron: PatronRecord;
  onSaved: (next: PatronRecord) => void;
  onCancel: () => void;
}) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const [fullName, setFullName] = React.useState(patron.fullName);
  const [email, setEmail] = React.useState(patron.email ?? '');
  const [phone, setPhone] = React.useState(patron.phone ?? '');
  const [staffNotes, setStaffNotes] = React.useState(patron.staffNotes ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    if (fullName.trim() === '') {
      setError(t('members.errors.fullNameRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Cleared fields go as null, not as ''. A blank string is a value the
      // patron has; null is the absence of one, and only the second is what a
      // librarian deleting an old phone number means.
      const updated = await dataPort().patch<PatronRecord>(`/t/${slug}/patrons/${patron.id}`, {
        fullName: fullName.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        staffNotes: staffNotes.trim() || null,
      });
      toast.show({ severity: 'success', title: t('members.updateSuccess') });
      onSaved(updated);
    } catch (err) {
      setError(translateApiError(err, t, t('common.states.error')));
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title={t('members.form.title')} subtitle={t('members.detail.editHint')} />
      <CardBody>
        {error ? <Banner severity="critical">{error}</Banner> : null}
        <div className="lbr-form-grid">
          <FormField id="patron-name" label={t('members.columns.name')} required>
            <Input value={fullName} onChange={(e) => setFullName(e.currentTarget.value)} />
          </FormField>
          <FormField id="patron-email" label={t('members.columns.email')}>
            <Input value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
          </FormField>
          <FormField id="patron-phone" label={t('members.columns.phone')}>
            <Input value={phone} onChange={(e) => setPhone(e.currentTarget.value)} />
          </FormField>
        </div>
        <FormField id="patron-notes" label={t('members.detail.staffNotes')}>
          <Textarea
            rows={3}
            value={staffNotes}
            onChange={(e) => setStaffNotes(e.currentTarget.value)}
          />
        </FormField>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
          {t('members.detail.editScopeNote')}
        </p>
        <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' }}>
          <Button variant="primary" loading={busy} onClick={save}>
            {t('common.actions.save')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
