import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Banner, Card, CardBody, CardHeader, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { currentSession, requestCookieHeader } from '@/lib/session';
import { api, type ListResponse } from '@/lib/api';
import type { FieldDef } from '@/components/DynamicFields';
import { MemberForm } from '../members/new/MemberForm';
import { BookForm } from '../catalog/new/BookForm';
import { StepIndicator } from './StepIndicator';

export const dynamic = 'force-dynamic';

type FieldsResponse = { entityKind: string; fields: FieldDef[] };

const STEPS = ['welcome', 'member', 'book', 'done'] as const;
type StepKey = (typeof STEPS)[number];

function nextStep(current: StepKey): StepKey {
  const ix = STEPS.indexOf(current);
  return STEPS[Math.min(ix + 1, STEPS.length - 1)] as StepKey;
}

/**
 * Multi-step welcome wizard for fresh tenants. The librarian lands here
 * right after signup — the dashboard's onboarding-nudge banner also
 * points to this page.
 *
 *   Step 1 (`welcome`) — confirm library details, set expectations.
 *   Step 2 (`member`)  — add the first member, or skip.
 *   Step 3 (`book`)    — add the first book, or skip.
 *   Step 4 (`done`)    — recap + dashboard link.
 *
 * State is read from the URL (`?step=...`) so refresh + back-button work.
 * The actual "first member" / "first book" facts come from the API counts —
 * the wizard doesn't track its own per-user "completed" flag.
 */
export default async function OnboardingPage(props: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();
  const session = await currentSession();
  if (!session) redirect(`/${params.locale}/login`);

  const stepParam = (searchParams.step ?? 'welcome') as StepKey;
  if (!STEPS.includes(stepParam)) redirect(`/${params.locale}/t/${params.slug}/onboarding`);

  // Check progress via member / book counts. A failure here is non-fatal —
  // we just default to "nothing done yet" and let the librarian re-do
  // a step if they want.
  let memberCount = 0;
  let bookCount = 0;
  let memberFields: FieldDef[] = [];
  let bookFields: FieldDef[] = [];
  try {
    const [members, books, memberDefs, bookDefs] = await Promise.all([
      api<ListResponse<unknown>>(`/t/${params.slug}/members?limit=1`, { cookie }),
      api<ListResponse<unknown>>(`/t/${params.slug}/catalog/books?limit=1`, { cookie }),
      api<FieldsResponse>(`/t/${params.slug}/data-model/fields/member`, { cookie }).catch(() => ({
        entityKind: 'member',
        fields: [] as FieldDef[],
      })),
      api<FieldsResponse>(`/t/${params.slug}/data-model/fields/book`, { cookie }).catch(() => ({
        entityKind: 'book',
        fields: [] as FieldDef[],
      })),
    ]);
    memberCount = members.items.length;
    bookCount = books.items.length;
    memberFields = memberDefs.fields;
    bookFields = bookDefs.fields;
  } catch {
    /* keep defaults */
  }

  const base = `/${params.locale}/t/${params.slug}/onboarding`;
  const dashboard = `/${params.locale}/t/${params.slug}`;
  const indicatorSteps = [
    { key: 'welcome', label: t('onboarding.steps.welcome'), done: stepParam !== 'welcome' },
    { key: 'member', label: t('onboarding.steps.member'), done: memberCount > 0 },
    { key: 'book', label: t('onboarding.steps.book'), done: bookCount > 0 },
    { key: 'done', label: t('onboarding.steps.done'), done: stepParam === 'done' },
  ];

  return (
    <>
      <PageHeader
        title={t('onboarding.welcome.title')}
        subtitle={t('onboarding.welcome.subtitle')}
      />
      <StepIndicator steps={indicatorSteps} current={stepParam} />

      {stepParam === 'welcome' ? (
        <Card>
          <CardHeader title={t('onboarding.welcome.cardTitle', { name: session.tenant.name })} />
          <CardBody>
            <p style={{ marginTop: 0 }}>{t('onboarding.welcome.body1')}</p>
            <p style={{ fontWeight: 600, margin: '0 0 var(--sp-3) 0' }}>
              {t('onboarding.choose.intro')}
            </p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: 'var(--sp-4)',
              }}
            >
              <Card variant="outlined" style={{ display: 'flex', flexDirection: 'column' }}>
                <h3 style={{ marginTop: 0 }}>{t('onboarding.choose.scratch.title')}</h3>
                <p style={{ color: 'var(--color-text-muted)', flex: 1 }}>
                  {t('onboarding.choose.scratch.body')}
                </p>
                <Link
                  href={`${base}?step=${nextStep('welcome')}`}
                  className="lbr-btn lbr-btn--primary lbr-btn--md"
                  style={{ width: '100%' }}
                >
                  {t('onboarding.choose.scratch.cta')}
                </Link>
              </Card>

              <Card variant="outlined" style={{ display: 'flex', flexDirection: 'column' }}>
                <h3 style={{ marginTop: 0 }}>{t('onboarding.choose.import.title')}</h3>
                <p style={{ color: 'var(--color-text-muted)', flex: 1 }}>
                  {t('onboarding.choose.import.body')}
                </p>
                <Link
                  href={`/${params.locale}/t/${params.slug}/settings/import`}
                  className="lbr-btn lbr-btn--secondary lbr-btn--md"
                  style={{ width: '100%' }}
                >
                  {t('onboarding.choose.import.cta')}
                </Link>
              </Card>
            </div>
            <div style={{ marginTop: 'var(--sp-4)' }}>
              <Link href={dashboard} className="lbr-btn lbr-btn--ghost lbr-btn--md">
                {t('onboarding.skipAll')}
              </Link>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {stepParam === 'member' ? (
        <>
          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader
              title={t('onboarding.member.title')}
              subtitle={t('onboarding.member.subtitle')}
              actions={
                <Link
                  href={`${base}?step=${nextStep('member')}`}
                  className="lbr-btn lbr-btn--ghost lbr-btn--sm"
                >
                  {t('onboarding.skipStep')}
                </Link>
              }
            />
            <CardBody>
              {memberCount > 0 ? (
                <Banner severity="success" style={{ marginBottom: 'var(--sp-3)' }}>
                  {t('onboarding.member.already')}
                </Banner>
              ) : null}
              <MemberForm
                slug={params.slug}
                catalog={catalog}
                locale={params.locale}
                customFields={memberFields}
                returnTo={`${base}?step=${nextStep('member')}`}
              />
            </CardBody>
          </Card>
        </>
      ) : null}

      {stepParam === 'book' ? (
        <Card style={{ marginBottom: 'var(--sp-4)' }}>
          <CardHeader
            title={t('onboarding.book.title')}
            subtitle={t('onboarding.book.subtitle')}
            actions={
              <Link
                href={`${base}?step=${nextStep('book')}`}
                className="lbr-btn lbr-btn--ghost lbr-btn--sm"
              >
                {t('onboarding.skipStep')}
              </Link>
            }
          />
          <CardBody>
            {bookCount > 0 ? (
              <Banner severity="success" style={{ marginBottom: 'var(--sp-3)' }}>
                {t('onboarding.book.already')}
              </Banner>
            ) : null}
            <BookForm
              slug={params.slug}
              catalog={catalog}
              locale={params.locale}
              customFields={bookFields}
              returnTo={`${base}?step=${nextStep('book')}`}
            />
          </CardBody>
        </Card>
      ) : null}

      {stepParam === 'done' ? (
        <Card>
          <CardHeader title={t('onboarding.done.title')} />
          <CardBody>
            <p style={{ marginTop: 0 }}>{t('onboarding.done.body1')}</p>
            <ul>
              <li>{t('onboarding.done.bullet1')}</li>
              <li>{t('onboarding.done.bullet2')}</li>
              <li>{t('onboarding.done.bullet3')}</li>
            </ul>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-4)' }}>
              <Link href={dashboard} className="lbr-btn lbr-btn--primary lbr-btn--md">
                {t('onboarding.done.toDashboard')}
              </Link>
            </div>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
