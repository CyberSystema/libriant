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
  useToast,
} from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { dataPort } from '@/lib/ports';
import { translateApiError } from '@/lib/api-errors';
import { printDocument } from '@/lib/print';
import {
  UNTITLED_TITLE,
  readContributors,
  readDisplayTitle,
  readSimpleFields,
  type MarcRecord,
} from '@/lib/marc-simple-fields';
import { CoverUploader } from './CoverUploader';
import { BibSimpleForm } from './BibSimpleForm';
import { BarcodeScanner, SCAN_FORMATS, scanningSupported } from '@/components/BarcodeScanner';

/** `GET /t/:slug/catalog/bib/:id`. */
export type BibRecordRead = {
  id: string;
  publicNo: string;
  kind: string;
  schema: string;
  status: string;
  version: number;
  contentHash: string;
  rowVersion: string;
  record: MarcRecord;
  controlNumber: string | null;
  controlNumberSource: string | null;
  needsReview: boolean;
  createdAt: string;
  updatedAt: string;
  /** The projection's one non-projected column (phase 20k added the read). */
  coverAssetRef: string | null;
  source: {
    format: string;
    encoding: string | null;
    normalization: string | null;
    roundtrips: boolean;
    hasSourceBlob: boolean;
    anomalies: unknown;
  };
};

export type ItemStatus =
  'available' | 'on_loan' | 'in_transit' | 'awaiting_pickup' | 'in_process' | 'missing';

/** One row of `GET /t/:slug/items?bibId=`. The subset this screen renders. */
export type ItemRow = {
  id: string;
  barcode: string | null;
  callNumberPrefix: string | null;
  callNumberBase: string | null;
  callNumberSuffix: string | null;
  copyNumber: string | null;
  status: ItemStatus;
  itemTypeId: string;
  owningBranchId: string;
  currentBranchId: string;
  permanentLocationId: string;
  temporaryLocationId: string | null;
};

export type BranchRow = { id: string; code: string; name: string };
export type ItemTypeRow = { id: string; code: string; name: string };
export type LocationRow = { id: string; branchId: string; code: string; name: string };

type Props = {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  record: BibRecordRead;
  copies: ItemRow[];
  /** The list was capped. Said out loud rather than shown as "all of them". */
  moreCopies: boolean;
  branches: BranchRow[];
  itemTypes: ItemTypeRow[];
  locations: LocationRow[];
};

/**
 * The catalogue record screen, on the 2.0 read and write surface (phase 20k).
 *
 * ## What changed under it, and why the screen changed shape
 *
 * 1.0's `GET /catalog/books/:id` returned a row: title, publisher, ISBN, its
 * copies and its cover, all as scalars. `GET /catalog/bib/:id` returns a MARC
 * RECORD and nothing derived from it, so:
 *
 *   - the summary is read out of `record.fields` — there is no `title` column
 *     to render, and the fields a form can safely edit are the five
 *     `SIMPLE_FIELDS` the phase-20j builder knows how to address;
 *   - the copies come from `GET /items?bibId=`, a separate paged list, because
 *     a copy in 2.0 belongs to a holdings record and carries a call number, a
 *     branch and a shelving location rather than a free-text shelf string;
 *   - editing goes through {@link BibSimpleForm}, which PATCHes path ops with
 *     a content-hash precondition, not a whole-object PUT.
 *
 * ## Delete is a TOMBSTONE and leaves the screen
 *
 * 1.0 archived a book and kept it readable, so the detail page could show an
 * "archived" banner with a Restore button beside it. 2.0's delete sets
 * `deleted_at`, and `BibReadService.read` filters those out — §5 commits to
 * OAI-PMH `deletedRecord=persistent`, which is a promise to HARVESTERS about
 * the database, not a promise that the staff screen can still open the record.
 * So a successful delete navigates to the catalogue list. `POST :id/restore-
 * deleted` undoes it and has no button here, because there is no screen that
 * lists deleted records to press it from; that is recorded in the divergence
 * log rather than faked with a button that needs an id nobody can see.
 *
 * NOT to be confused with `POST :id/restore`, which restores a prior VERSION of
 * a live record. Two routes, one word, opposite blast radii.
 */
export function BookDetail({
  slug,
  catalog,
  locale,
  record,
  copies,
  moreCopies,
  branches,
  itemTypes,
  locations,
}: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [rec, setRec] = React.useState(record);
  const [rows, setRows] = React.useState(copies);
  const [editing, setEditing] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteReason, setDeleteReason] = React.useState('');
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  /**
   * Why the delete was refused, rendered INSIDE the dialog (frontend-05). A
   * critical toast cannot serve here: `Modal` opens a native `<dialog>` with
   * `showModal()`, so the toast paints under the backdrop. And the refusal
   * that matters — "this record still has copies" — is one the librarian acts
   * on in the table behind the dialog.
   */
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const [addCopyOpen, setAddCopyOpen] = React.useState(false);
  const [printingCopyId, setPrintingCopyId] = React.useState<string | null>(null);
  const [withdrawing, setWithdrawing] = React.useState<ItemRow | null>(null);
  const [withdrawBusy, setWithdrawBusy] = React.useState(false);
  const [withdrawError, setWithdrawError] = React.useState<string | null>(null);

  React.useEffect(() => setRec(record), [record]);
  React.useEffect(() => setRows(copies), [copies]);

  const title = readDisplayTitle(rec.record) || UNTITLED_TITLE;
  const values = readSimpleFields(rec.record);
  const contributors = readContributors(rec.record);

  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? id;
  const locationName = (id: string) => locations.find((l) => l.id === id)?.name ?? id;
  const typeName = (id: string) => itemTypes.find((i) => i.id === id)?.name ?? id;
  const callNumber = (c: ItemRow) =>
    [c.callNumberPrefix, c.callNumberBase, c.callNumberSuffix].filter(Boolean).join(' ');
  /**
   * How to name one copy in a sentence.
   *
   * Every one of these can be absent in 2.0 — a barcode is optional, a call
   * number is optional, a copy number is optional — so the id is the floor. A
   * confirmation that reads "Withdraw copy ?" is one a librarian cannot check
   * before pressing.
   */
  const copyLabel = (c: ItemRow) => (c.barcode ?? callNumber(c)) || c.copyNumber || c.id;

  // Print a barcode/spine label for one copy. Silent in the desktop shell; opens
  // the print route (which auto-prints) in a browser.
  async function printLabel(copyId: string) {
    setPrintingCopyId(copyId);
    try {
      // NO `bookId`. The label route resolves the record from the copy now —
      // an item knows its `bibId`, so passing it separately was one more way
      // for the two to disagree.
      const res = await printDocument({ locale, slug, kind: 'label', id: copyId });
      toast.show(
        res.ok
          ? { severity: 'success', title: t('catalog.book.print.labelSent') }
          : { severity: 'critical', title: t('catalog.book.print.labelFailed') },
      );
    } finally {
      setPrintingCopyId(null);
    }
  }

  function openDelete() {
    setDeleteReason('');
    setDeleteError(null);
    setDeleteOpen(true);
  }

  async function remove() {
    const reason = deleteReason.trim();
    // Mirrors `DeleteRecordDto` (3-500). Checked here so the librarian is told
    // before a round trip, and by the API because this check is a courtesy.
    if (reason.length < 3) {
      setDeleteError(t('catalog.book.errors.reasonTooShort'));
      return;
    }
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await dataPort().delete(
        `/t/${slug}/catalog/bib/${rec.id}?reason=${encodeURIComponent(reason)}`,
      );
      toast.show({ severity: 'success', title: t('catalog.book.deleted') });
      // The record is unreadable from here on, so do not stay on a page that
      // would 404 on its next refresh.
      router.replace(`/${locale}/t/${slug}/catalog`);
    } catch (err) {
      setDeleteError(translateApiError(err, t, t('common.states.error')));
      setDeleteBusy(false);
    }
  }

  async function withdraw() {
    const copy = withdrawing;
    if (!copy) return;
    setWithdrawBusy(true);
    setWithdrawError(null);
    try {
      await dataPort().delete(`/t/${slug}/items/${copy.id}`);
      setRows((cs) => cs.filter((c) => c.id !== copy.id));
      toast.show({ severity: 'success', title: t('catalog.book.copyWithdrawn') });
      setWithdrawing(null);
      router.refresh();
    } catch (err) {
      setWithdrawError(translateApiError(err, t, t('common.states.error')));
    } finally {
      setWithdrawBusy(false);
    }
  }

  if (editing) {
    return (
      <Card>
        <CardHeader title={t('catalog.book.editRecord')} subtitle={t('catalog.book.editHint')} />
        <CardBody>
          <BibSimpleForm
            slug={slug}
            catalog={catalog}
            locale={locale}
            recordId={rec.id}
            record={rec.record}
            contentHash={rec.contentHash}
            onSaved={(next) => {
              // The PATCH answers with the new record AND the new hash, and the
              // next edit needs both: a form re-opened against the old hash
              // would be refused by its own optimistic-lock check.
              setRec({ ...rec, record: next.record, contentHash: next.contentHash });
              setEditing(false);
              router.refresh();
            }}
            onCancel={() => setEditing(false)}
          />
        </CardBody>
      </Card>
    );
  }

  return (
    <>
      {rec.needsReview ? (
        <Banner severity="warning" title={t('catalog.book.needsReviewNotice')}>
          {t('catalog.book.needsReviewHint')}
        </Banner>
      ) : null}

      <div className="lbr-split" style={{ marginTop: 'var(--sp-4)' }}>
        <div>
          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader
              title={t('catalog.book.summary')}
              actions={
                <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                  {t('common.actions.edit')}
                </Button>
              }
            />
            <CardBody>
              <dl className="lbr-dl">
                <dt>{t('catalog.book.titleLabel')}</dt>
                <dd>
                  <strong>{title}</strong>
                </dd>
                <dt>{t('catalog.book.authorsLabel')}</dt>
                <dd>{contributors.length === 0 ? '—' : contributors.join(' · ')}</dd>
                {values.edition ? (
                  <>
                    <dt>{t('catalog.book.editionLabel')}</dt>
                    <dd>{values.edition}</dd>
                  </>
                ) : null}
                {values.publisher ? (
                  <>
                    <dt>{t('catalog.book.publisherLabel')}</dt>
                    <dd>{values.publisher}</dd>
                  </>
                ) : null}
                {values.publicationYear ? (
                  <>
                    <dt>{t('catalog.book.yearLabel')}</dt>
                    <dd>{values.publicationYear}</dd>
                  </>
                ) : null}
                {values.isbn ? (
                  <>
                    <dt>ISBN</dt>
                    <dd>{values.isbn}</dd>
                  </>
                ) : null}
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={t('catalog.book.copies')}
              subtitle={t('catalog.book.copiesHint')}
              actions={
                <Button variant="primary" size="sm" onClick={() => setAddCopyOpen(true)}>
                  + {t('catalog.book.addCopy')}
                </Button>
              }
            />
            <CardBody>
              {rows.length === 0 ? (
                <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
                  {t('catalog.book.noCopies')}
                </p>
              ) : (
                <>
                  <div className="lbr-table-wrap">
                    <table className="lbr-table">
                      <thead>
                        <tr>
                          <th>{t('catalog.book.copyBarcode')}</th>
                          <th>{t('catalog.book.copyCallNumber')}</th>
                          <th>{t('catalog.book.copyStatus')}</th>
                          <th>{t('catalog.book.copyLocation')}</th>
                          <th>{t('catalog.book.copyType')}</th>
                          <th>{t('catalog.book.print.column')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((c) => (
                          <tr key={c.id}>
                            {/* A barcode is OPTIONAL in 2.0: a copy can be
                                catalogued before its label is printed. */}
                            <td>{c.barcode ?? '—'}</td>
                            <td>{callNumber(c) || '—'}</td>
                            <td>{t(`catalog.book.itemStatus.${c.status}`)}</td>
                            <td>
                              {locationName(c.temporaryLocationId ?? c.permanentLocationId)}
                              <div
                                style={{
                                  color: 'var(--color-text-muted)',
                                  fontSize: 'var(--fs-xs)',
                                }}
                              >
                                {branchName(c.currentBranchId)}
                              </div>
                            </td>
                            <td>{typeName(c.itemTypeId)}</td>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              <Button
                                variant="ghost"
                                size="sm"
                                loading={printingCopyId === c.id}
                                disabled={c.barcode === null}
                                onClick={() => printLabel(c.id)}
                              >
                                {t('catalog.book.printLabel')}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setWithdrawError(null);
                                  setWithdrawing(c);
                                }}
                              >
                                {t('catalog.book.withdrawCopy')}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {moreCopies ? (
                    <p
                      style={{
                        color: 'var(--color-text-muted)',
                        fontSize: 'var(--fs-xs)',
                        marginBottom: 0,
                      }}
                    >
                      {t('catalog.book.moreCopies', { count: rows.length })}
                    </p>
                  ) : null}
                </>
              )}
            </CardBody>
          </Card>
        </div>

        <div>
          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader title={t('catalog.book.cover')} />
            <CardBody>
              <CoverUploader
                slug={slug}
                recordId={rec.id}
                coverAssetRef={rec.coverAssetRef}
                catalog={catalog}
                locale={locale}
                onChange={(ref) => setRec({ ...rec, coverAssetRef: ref })}
              />
            </CardBody>
          </Card>

          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader title={t('catalog.book.record')} />
            <CardBody>
              <dl className="lbr-dl">
                <dt>{t('catalog.book.controlNumber')}</dt>
                <dd>{rec.controlNumber ?? '—'}</dd>
                <dt>{t('catalog.book.recordVersion')}</dt>
                <dd>{rec.version}</dd>
                <dt>{t('catalog.book.recordFormat')}</dt>
                <dd>{rec.schema.toUpperCase()}</dd>
                <dt>{t('catalog.book.recordSource')}</dt>
                <dd>{rec.source.format}</dd>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t('catalog.book.detailActions')} />
            <CardBody>
              <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
                <Button variant="ghost" onClick={openDelete}>
                  {t('catalog.book.delete')}
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={t('catalog.book.deleteConfirmTitle', { title })}
        role="alertdialog"
        error={deleteError}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="danger" loading={deleteBusy} onClick={remove}>
              {t('catalog.book.delete')}
            </Button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>{t('catalog.book.deleteConfirmBody')}</p>
        <FormField
          id="bib-delete-reason"
          label={t('catalog.book.deleteReasonLabel')}
          hint={t('catalog.book.deleteReasonHint')}
          required
        >
          <Input
            value={deleteReason}
            onChange={(e) => setDeleteReason(e.currentTarget.value)}
            maxLength={500}
          />
        </FormField>
      </Modal>

      <Modal
        open={withdrawing !== null}
        onClose={() => setWithdrawing(null)}
        title={t('catalog.book.withdrawConfirmTitle', {
          barcode: withdrawing ? copyLabel(withdrawing) : '',
        })}
        role="alertdialog"
        error={withdrawError}
        actions={
          <>
            <Button variant="ghost" onClick={() => setWithdrawing(null)}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="danger" loading={withdrawBusy} onClick={withdraw}>
              {t('catalog.book.withdrawCopy')}
            </Button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>{t('catalog.book.withdrawConfirmBody')}</p>
      </Modal>

      <AddCopyModal
        open={addCopyOpen}
        onClose={() => setAddCopyOpen(false)}
        slug={slug}
        bibId={rec.id}
        catalog={catalog}
        locale={locale}
        branches={branches}
        itemTypes={itemTypes}
        locations={locations}
        onCreated={() => {
          setAddCopyOpen(false);
          // The POST answers with an id and a call-number key, not a row, so
          // the list is re-read rather than guessed at from the form values.
          router.refresh();
        }}
      />
    </>
  );
}

/**
 * Add a copy.
 *
 * THREE REQUIRED IDS, where 1.0 asked for a barcode and a shelf string:
 * `itemTypeId` decides what the circulation rules match on, `owningBranchId`
 * decides which library owns it, and `permanentLocationId` is the shelf — and a
 * shelving location belongs to a branch, so the location list narrows when the
 * branch changes. A library that has not set any of the three cannot add a copy
 * at all, and the form says which one is missing rather than posting a body the
 * API will refuse with a 400 nobody can act on.
 */
function AddCopyModal({
  open,
  onClose,
  slug,
  bibId,
  catalog,
  locale,
  branches,
  itemTypes,
  locations,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  bibId: string;
  catalog: Catalog;
  locale: Locale;
  branches: BranchRow[];
  itemTypes: ItemTypeRow[];
  locations: LocationRow[];
  onCreated: () => void;
}) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const [barcode, setBarcode] = React.useState('');
  const [branchId, setBranchId] = React.useState('');
  const [itemTypeId, setItemTypeId] = React.useState('');
  const [locationId, setLocationId] = React.useState('');
  const [callNumber, setCallNumber] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [scanning, setScanning] = React.useState(false);
  // Client-only feature check — gated via state to avoid a hydration mismatch.
  const [canScan, setCanScan] = React.useState(false);
  React.useEffect(() => setCanScan(scanningSupported()), []);

  const branchLocations = locations.filter((l) => l.branchId === branchId);

  /** The only location of a branch that has one, so nobody picks from a list of 1. */
  const soleLocationOf = (branch: string) => {
    const forBranch = locations.filter((l) => l.branchId === branch);
    return forBranch.length === 1 ? (forBranch[0]?.id ?? '') : '';
  };

  /**
   * Changing the branch CLEARS the location.
   *
   * A shelving location belongs to exactly one branch, and the API takes the
   * two ids independently — so a location left over from the previously
   * selected branch would put the copy on a shelf in another building, and
   * nothing downstream would call that an error.
   */
  function chooseBranch(next: string) {
    setBranchId(next);
    setLocationId(soleLocationOf(next));
  }

  React.useEffect(() => {
    if (!open) return;
    setBarcode('');
    setCallNumber('');
    setError(null);
    setScanning(false);
    // Preselect where there is no choice to make. A one-branch library should
    // not have to pick its only branch on every copy.
    const branch = branches.length === 1 ? (branches[0]?.id ?? '') : '';
    setBranchId(branch);
    setItemTypeId(itemTypes.length === 1 ? (itemTypes[0]?.id ?? '') : '');
    setLocationId(branch ? soleLocationOf(branch) : '');
  }, [open, branches, itemTypes, locations]);

  const missing =
    branches.length === 0
      ? t('catalog.book.addCopyNoBranches')
      : itemTypes.length === 0
        ? t('catalog.book.addCopyNoItemTypes')
        : locations.length === 0
          ? t('catalog.book.addCopyNoLocations')
          : null;

  async function submit() {
    if (!branchId || !itemTypeId || !locationId) {
      setError(t('catalog.book.errors.copyFieldsRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        bibId,
        itemTypeId,
        owningBranchId: branchId,
        permanentLocationId: locationId,
      };
      if (barcode.trim()) body.barcode = barcode.trim();
      // One box, not three. A call number is written as one string on a spine
      // and a librarian types it that way; prefix and suffix are cataloguing
      // refinements the copy editor can split out later.
      if (callNumber.trim()) body.callNumberBase = callNumber.trim();
      await dataPort().post(`/t/${slug}/items`, body);
      toast.show({ severity: 'success', title: t('catalog.book.copyAdded') });
      onCreated();
    } catch (err) {
      setError(translateApiError(err, t, t('common.states.error')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('catalog.book.addCopy')}
      // frontend-05: the slot, not a hand-rolled Banner in the body. Same
      // critical banner, plus the focus move and the `aria-describedby` link
      // that make a duplicate-barcode refusal announce itself to a screen
      // reader and scroll into view in a body long enough to hide it.
      error={error}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={submit} disabled={missing !== null}>
            {t('catalog.book.addCopySubmit')}
          </Button>
        </>
      }
    >
      {missing ? <Banner severity="warning">{missing}</Banner> : null}

      <FormField id="copy-branch" label={t('catalog.book.copyBranch')} required>
        <select
          className="lbr-input"
          value={branchId}
          onChange={(e) => chooseBranch(e.currentTarget.value)}
        >
          <option value="" disabled>
            —
          </option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </FormField>

      <FormField
        id="copy-location"
        label={t('catalog.book.copyLocation')}
        hint={branchId ? undefined : t('catalog.book.copyLocationHint')}
        required
      >
        <select
          className="lbr-input"
          value={locationId}
          disabled={!branchId}
          onChange={(e) => setLocationId(e.currentTarget.value)}
        >
          <option value="" disabled>
            —
          </option>
          {branchLocations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </FormField>

      <FormField id="copy-type" label={t('catalog.book.copyType')} required>
        <select
          className="lbr-input"
          value={itemTypeId}
          onChange={(e) => setItemTypeId(e.currentTarget.value)}
        >
          <option value="" disabled>
            —
          </option>
          {itemTypes.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </FormField>

      <FormField id="copy-callnumber" label={t('catalog.book.copyCallNumber')}>
        <Input value={callNumber} onChange={(e) => setCallNumber(e.currentTarget.value)} />
      </FormField>

      <FormField
        id="copy-barcode"
        label={t('catalog.book.copyBarcode')}
        hint={t('catalog.book.copyBarcodeOptionalHint')}
      >
        <Input
          spellCheck={false}
          value={barcode}
          onChange={(e) => setBarcode(e.currentTarget.value)}
        />
      </FormField>
      {canScan ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          style={{ marginTop: 'var(--sp-2)' }}
          onClick={() => setScanning(true)}
        >
          {t('catalog.book.copyScan')}
        </Button>
      ) : null}

      <BarcodeScanner
        open={scanning}
        onClose={() => setScanning(false)}
        formats={SCAN_FORMATS.label}
        title={t('catalog.book.copyScanTitle')}
        catalog={catalog}
        locale={locale}
        onScan={(value) => {
          setBarcode(value.trim());
          setScanning(false);
        }}
      />
    </Modal>
  );
}
