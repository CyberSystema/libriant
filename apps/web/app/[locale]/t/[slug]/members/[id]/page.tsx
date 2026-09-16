import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { currentSession, requestCookieHeader } from '@/lib/session';
import { ApiError } from '@/lib/api';
import { dataPort } from '@/lib/ports';
import { translateApiError } from '@/lib/api-errors';
import type { FieldDef } from '@/components/DynamicFields';
import { MemberDetail, type Balance, type FeeRow, type PatronRecord } from './MemberDetail';

export const dynamic = 'force-dynamic';

type FieldsResponse = { entityKind: string; fields: FieldDef[] };
type Page<T> = { items: T[]; nextCursor: string | null };

/**
 * How many open loans / holds to ask for when all the card shows is a count.
 *
 * There is no count route, and inventing one for a summary card would be a
 * route to maintain for a number. Asking for a page and reporting "25+" when
 * `nextCursor` comes back is honest about what was measured; a librarian who
 * needs the exact figure opens the list, which is one click away and is the
 * screen that can page.
 */
const COUNT_PROBE = 25;

export default async function PatronDetailPage(props: {
  params: Promise<{ locale: string; slug: string; id: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();
  const port = dataPort();

  let patron: PatronRecord | null = null;
  let fetchError: string | null = null;
  try {
    patron = await port.get<PatronRecord>(`/t/${params.slug}/patrons/${params.id}`, { cookie });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    fetchError = translateApiError(err, t, t('common.states.error'));
  }

  /**
   * The DEFINITIONS that label the stored custom fields.
   *
   * Best-effort, exactly as before: served by the customization controller,
   * which is NOT one of the five modules the cutover deletes and which is still
   * on the 1.0 client. The VALUES now come from the patron record itself
   * (phase 20n added `customFields` to that read — the upgrade has been copying
   * them since 19b and no route returned them). So a library whose definitions
   * do not resolve still sees what is stored, keyed raw, rather than nothing.
   */
  let customFields: FieldDef[] = [];
  try {
    const res = await port.get<FieldsResponse>(`/t/${params.slug}/data-model/fields/member`, {
      cookie,
    });
    customFields = res.fields;
  } catch {
    customFields = [];
  }

  // What the patron owes, rendered by the desk before JS hydrates. Outstanding
  // only: that is the question being asked at the counter.
  //
  // A failure here is NOT silently swallowed the way the definitions are. An
  // empty fees card and a fees card we could not load look identical, and one
  // of them tells a librarian a patron owes nothing when they may owe EUR 12.
  let fees: Page<FeeRow> | null = null;
  let feesError: string | null = null;
  let balances: Balance[] = [];
  try {
    [fees, balances] = await Promise.all([
      port.get<Page<FeeRow>>(
        `/t/${params.slug}/fees?patronId=${encodeURIComponent(params.id)}&status=outstanding&limit=25`,
        { cookie },
      ),
      // PER CURRENCY, and a set of rows rather than a scalar. 1.0 summed one
      // `outstandingFinesCents`; a patron who owes EUR 4 and USD 3 has no single
      // number, and the 1.0 card labelled every library's debts in euros.
      port
        .get<{ balances: Balance[] }>(`/t/${params.slug}/fees/balances/${params.id}`, { cookie })
        .then((r) => r.balances),
    ]);
  } catch (err) {
    feesError = translateApiError(err, t, t('loans.fines.loadFailed'));
  }

  // The two counts the circulation card shows. Each degrades to null — an
  // unknown count is rendered as such rather than as zero, because "no loans"
  // and "we could not ask" are different answers and only one of them means
  // this patron can be archived.
  const [loans, holds] = await Promise.all([
    port
      .get<Page<unknown>>(
        `/t/${params.slug}/circulation/patrons/${params.id}/loans?status=open&limit=${COUNT_PROBE}`,
        { cookie },
      )
      .catch(() => null),
    port
      .get<Page<unknown>>(
        `/t/${params.slug}/holds/for-patron?patronId=${encodeURIComponent(params.id)}&limit=${COUNT_PROBE}`,
        { cookie },
      )
      .catch(() => null),
  ]);

  // Who may do what. The API is the enforcement; this only keeps a volunteer
  // from being shown a button that would 403 in their face. An impersonating
  // Libriant admin has no tenant session and is treated as owner, exactly as
  // the tenant layout already resolves them to get this far.
  const session = await currentSession().catch(() => null);
  const role = session?.user.role ?? 'owner';
  const canSettle = role === 'owner' || role === 'admin' || role === 'librarian';
  const canWriteOff = role === 'owner' || role === 'admin';
  // privacy-legal-15: same three roles as a payment, and for the same reason —
  // the volunteer role reads the desk's screens but does not hand a copy of
  // somebody's whole record to whoever asked for it.
  const canExportSubjectData = canSettle;

  if (!patron) {
    return (
      <>
        <PageHeader title={t('members.title')} />
        <Banner severity="critical">{fetchError ?? t('common.states.error')}</Banner>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={patron.fullName}
        subtitle={patron.patronNumber ?? undefined}
        trail={
          <Link href={`/${params.locale}/t/${params.slug}/members`} style={{ color: 'inherit' }}>
            ← {t('members.title')}
          </Link>
        }
      />
      <MemberDetail
        slug={params.slug}
        catalog={catalog}
        locale={params.locale}
        initial={patron}
        customFieldDefs={customFields}
        fees={fees}
        feesError={feesError}
        balances={balances}
        openLoans={loans ? { shown: loans.items.length, more: loans.nextCursor !== null } : null}
        openHolds={holds ? { shown: holds.items.length, more: holds.nextCursor !== null } : null}
        canSettleFees={canSettle}
        canWriteOffFees={canWriteOff}
        canExportSubjectData={canExportSubjectData}
      />
    </>
  );
}
