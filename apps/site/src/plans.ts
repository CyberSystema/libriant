/**
 * The pricing table, derived from the product's own plan definitions.
 *
 * The numbers on the pricing page are the numbers the product actually
 * enforces, because both come from `packages/db-control/prisma/seed-data.ts`.
 * Nobody has to remember to update a table when a cap changes, and the site
 * cannot advertise a limit the software does not honour.
 *
 * Greek labels and the decision about WHICH rows a visitor sees are marketing
 * choices and live here. The values never do.
 */

import { planSeeds } from '../../../packages/db-control/prisma/seed-data.js';
import type { Lang } from './shell.js';

/** Explicit allowlist — this is also what keeps On-prem/Enterprise off the grid. */
export const PUBLIC_PLAN_SLUGS = ['starter', 'community', 'municipal', 'institutional'] as const;

export type PublicPlanSlug = (typeof PUBLIC_PLAN_SLUGS)[number];

export type PublicPlan = {
  slug: PublicPlanSlug;
  name: string;
  priceEur: number;
  /** Who this tier is actually for. Never «πιο δημοφιλές» — there are no customers yet. */
  audience: string;
  /** The one-line size cue that lets a librarian self-identify. */
  sizeCue: string;
  features: Record<string, number | boolean | string | null | undefined>;
};

const AUDIENCE_EL: Record<PublicPlanSlug, { audience: string; sizeCue: string }> = {
  starter: {
    audience: 'Για μια μικρή σχολική ή κοινοτική βιβλιοθήκη',
    sizeCue: 'Έως 500 τίτλοι, ένας άνθρωπος στο γραφείο',
  },
  community: {
    audience: 'Για μια βιβλιοθήκη χωριού ή μικρού δήμου',
    sizeCue: 'Μερικές χιλιάδες τίτλοι, δύο ή τρία άτομα προσωπικό',
  },
  municipal: {
    audience: 'Για μια δημοτική βιβλιοθήκη με καθημερινή κίνηση',
    sizeCue: 'Δεκάδες χιλιάδες τίτλοι, ομάδα προσωπικού, παραρτήματα',
  },
  institutional: {
    audience: 'Για ακαδημαϊκή ή μεγάλη δημόσια βιβλιοθήκη',
    sizeCue: 'Πάνω από 100.000 τίτλοι και πολυμελές προσωπικό',
  },
};

const AUDIENCE_EN: Record<PublicPlanSlug, { audience: string; sizeCue: string }> = {
  starter: {
    audience: 'For a small school or community library',
    sizeCue: 'Up to 500 titles, one person at the desk',
  },
  community: {
    audience: 'For a village or small-municipality library',
    sizeCue: 'A few thousand titles, two or three staff',
  },
  municipal: {
    audience: 'For a municipal library with daily traffic',
    sizeCue: 'Tens of thousands of titles, a staff team, branches',
  },
  institutional: {
    audience: 'For an academic or large public library',
    sizeCue: 'Over 100,000 titles and a large staff team',
  },
};

const AUDIENCE: Record<Lang, Record<PublicPlanSlug, { audience: string; sizeCue: string }>> = {
  el: AUDIENCE_EL,
  en: AUDIENCE_EN,
};

/** Greek groups thousands with a dot (5.000); English with a comma (5,000). */
export function num(n: number, lang: Lang = 'el'): string {
  return n.toLocaleString(lang === 'el' ? 'el-GR' : 'en-GB');
}

/** Storage caps are stored in MB; show GB once that reads more naturally. */
export function storageLabel(mb: number, lang: Lang = 'el'): string {
  return mb >= 1024 ? `${num(mb / 1024, lang)} GB` : `${num(mb, lang)} MB`;
}

/**
 * Price, in the el-GR convention the whole site uses: symbol last, non-breaking
 * space before it, no decimals on whole amounts — and never «0 €», because a
 * zero price is not a price, it is the absence of one.
 */
export function priceLabel(eur: number, lang: Lang = 'el'): string {
  if (eur === 0) return lang === 'el' ? 'Δωρεάν' : 'Free';
  // Greek puts the symbol last after a non-breaking space; English puts it first.
  return lang === 'el' ? `${num(eur, 'el')}\u00A0€` : `€${num(eur, 'en')}`;
}

export function publicPlans(lang: Lang = 'el'): PublicPlan[] {
  return PUBLIC_PLAN_SLUGS.map((slug) => {
    const seed = planSeeds.find((p) => p.slug === slug);
    if (!seed) {
      // Fail the build rather than silently ship a table missing a column.
      throw new Error(
        `plans.ts: no plan with slug "${slug}" in seed-data.ts. ` +
          `Either the plan was renamed or PUBLIC_PLAN_SLUGS is stale.`,
      );
    }
    return {
      slug,
      name: seed.name,
      priceEur: seed.monthlyPriceCents / 100,
      ...AUDIENCE[lang][slug],
      features: seed.features as PublicPlan['features'],
    };
  });
}

export type PricingRow = {
  /** Feature key, or a synthetic key for a row the product does not model. */
  key: string;
  label: string;
  note?: string;
  render: (plan: PublicPlan) => string;
};

const yesNo = (v: unknown): string => (v === true ? '✓' : '—');

/** Greek and English label + note for each visible row. */
const ROW_COPY: Record<string, Record<Lang, { label: string; note?: string }>> = {
  max_books: {
    el: {
      label: 'Τίτλοι στον κατάλογο',
      note: 'Δέκα αντίτυπα του ίδιου βιβλίου μετράνε ως ένας τίτλος.',
    },
    en: { label: 'Titles in the catalogue', note: 'Ten copies of one book count as one title.' },
  },
  max_members: {
    el: { label: 'Εγγεγραμμένα μέλη', note: 'Τα αρχειοθετημένα μέλη δεν μετράνε.' },
    en: { label: 'Registered members', note: 'Archived members do not count.' },
  },
  staff_seats: {
    el: { label: 'Λογαριασμοί προσωπικού', note: 'Οι ανενεργοί λογαριασμοί δεν πιάνουν θέση.' },
    en: { label: 'Staff seats', note: 'Deactivated accounts do not take up a seat.' },
  },
  max_storage_mb: {
    el: { label: 'Χώρος για εξώφυλλα και αρχεία' },
    en: { label: 'Space for covers and files' },
  },
  reservations_enabled: {
    el: { label: 'Κρατήσεις και ουρά κρατήσεων' },
    en: { label: 'Holds and hold queue' },
  },
  isbn_lookup_enabled: {
    el: { label: 'Συμπλήρωση στοιχείων με ISBN' },
    en: { label: 'Fill in details by ISBN' },
  },
  bulk_import_enabled: {
    el: {
      label: 'Μαζική εισαγωγή από CSV, Excel ή MARC',
      note: 'Σε κάθε πακέτο με συνδρομή. Στο δωρεάν Starter τη μετάπτωση την τρέχουμε εμείς, με κωδικό υποστήριξης που δημιουργείτε εσείς.',
    },
    en: {
      label: 'Bulk import from CSV, Excel or MARC',
      note: 'On every paid plan. On the free Starter tier we run the migration for you, using a support code you generate.',
    },
  },
  email_notifications_enabled: {
    el: { label: 'Ειδοποιήσεις email προς τα μέλη' },
    en: { label: 'Email notifications to members' },
  },
  max_custom_fields_per_entity: {
    el: {
      label: 'Δικά σας πεδία, ανά είδος εγγραφής',
      note: 'Ισχύει χωριστά για κάθε είδος εγγραφής.',
    },
    en: {
      label: 'Custom fields, per record kind',
      note: 'Applies separately to each record kind.',
    },
  },
};

/**
 * The rows a visitor sees, in order.
 *
 * Six of the fifteen feature keys are deliberately absent, and each omission is
 * a correctness decision rather than an editorial one:
 *
 *   max_custom_collections, max_records_per_collection
 *     — no web UI reaches them; a librarian cannot create a collection today.
 *   api_access_enabled
 *     — no route guard, no token model, no documentation. It is a flag only.
 *   custom_subdomain_enabled
 *     — nothing provisions DNS or TLS for a tenant subdomain.
 *   priority_support
 *     — there is no SLA, no queue and no ticketing to prioritise within.
 *   audit_log_retention_days
 *     — nothing prunes audit rows, so a printed retention figure would be an
 *       unenforced restriction that misinforms in whichever direction it drifts.
 *
 * Selling any of them would be selling a cell that no code honours.
 */
export function pricingRows(lang: Lang = 'el'): PricingRow[] {
  const n = (k: string) => (p: PublicPlan) => num(Number(p.features[k]), lang);
  const b = (k: string) => (p: PublicPlan) => yesNo(p.features[k]);
  const renderers: Record<string, (p: PublicPlan) => string> = {
    max_books: n('max_books'),
    max_members: n('max_members'),
    staff_seats: n('staff_seats'),
    max_storage_mb: (p) => storageLabel(Number(p.features.max_storage_mb), lang),
    reservations_enabled: b('reservations_enabled'),
    isbn_lookup_enabled: b('isbn_lookup_enabled'),
    bulk_import_enabled: b('bulk_import_enabled'),
    email_notifications_enabled: b('email_notifications_enabled'),
    max_custom_fields_per_entity: n('max_custom_fields_per_entity'),
  };
  return Object.keys(ROW_COPY).map((key) => {
    const copy = ROW_COPY[key]?.[lang];
    const render = renderers[key];
    // A row with copy but no renderer, or vice versa, is a build error rather
    // than an empty cell nobody notices.
    if (!copy || !render) {
      throw new Error(
        `plans.ts: pricing row "${key}" is missing ${!copy ? 'copy' : 'a renderer'}.`,
      );
    }
    return { key, ...copy, render };
  });
}

/* ---------------------------------------------------------------------------
 * Rendering. Values come from the seeds above; only presentation lives here.
 * ------------------------------------------------------------------------- */

function e(v: unknown): string {
  return String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

const CARD_COPY: Record<
  Lang,
  {
    offerFlag: string;
    per: string;
    titles: string;
    members: string;
    seat: string;
    seats: string;
    storage: string;
  }
> = {
  el: {
    offerFlag: 'Το πακέτο της προσφοράς',
    per: 'τον μήνα',
    titles: 'τίτλοι',
    members: 'μέλη',
    seat: 'λογαριασμός προσωπικού',
    seats: 'λογαριασμοί προσωπικού',
    storage: 'για εξώφυλλα και αρχεία',
  },
  en: {
    offerFlag: 'The launch-offer plan',
    per: 'a month',
    titles: 'titles',
    members: 'members',
    seat: 'staff seat',
    seats: 'staff seats',
    storage: 'for covers and files',
  },
};

/**
 * Four plan cards. Each carries an audience badge rather than a «most popular»
 * flag — there are no customers yet, so popularity would be an invention.
 */
export function renderPlanCards(offerPlanSlug: string, lang: Lang = 'el'): string {
  const t = CARD_COPY[lang];
  return `<div class="plans">
      ${publicPlans(lang)
        .map((p) => {
          const featured = p.slug === offerPlanSlug;
          const seats = Number(p.features.staff_seats);
          return `<article class="plan${featured ? ' plan--featured' : ''}">
        ${featured ? `<span class="plan__flag">${e(t.offerFlag)}</span>` : ''}
        <h3 class="plan__name">${e(p.name)}</h3>
        <p class="plan__price">${e(priceLabel(p.priceEur, lang))}${p.priceEur > 0 ? `<span class="plan__per">${e(t.per)}</span>` : ''}</p>
        <p class="plan__audience">${e(p.audience)}</p>
        <p class="plan__cue">${e(p.sizeCue)}</p>
        <ul class="plan__caps">
          <li><strong>${e(num(Number(p.features.max_books), lang))}</strong> ${e(t.titles)}</li>
          <li><strong>${e(num(Number(p.features.max_members), lang))}</strong> ${e(t.members)}</li>
          <li><strong>${e(num(seats, lang))}</strong> ${e(seats === 1 ? t.seat : t.seats)}</li>
          <li><strong>${e(storageLabel(Number(p.features.max_storage_mb), lang))}</strong> ${e(t.storage)}</li>
        </ul>
      </article>`;
        })
        .join('\n      ')}
    </div>`;
}

/** The comparison grid. Rows are chosen in pricingRows; values are read. */
export function renderComparisonTable(lang: Lang = 'el'): string {
  const plans = publicPlans(lang);
  const yes = lang === 'el' ? 'Ναι' : 'Yes';
  const no = lang === 'el' ? 'Όχι' : 'No';
  const featureCol = lang === 'el' ? 'Δυνατότητα' : 'Feature';
  return `<div class="table-wrap">
      <table class="cmp cmp--plans">
        <thead>
          <tr>
            <th scope="col"><span class="visually-hidden">${e(featureCol)}</span></th>
            ${plans.map((p) => `<th scope="col">${e(p.name)}<span class="cmp__price">${e(priceLabel(p.priceEur, lang))}</span></th>`).join('\n            ')}
          </tr>
        </thead>
        <tbody>
          ${pricingRows(lang)
            .map(
              (row) => `<tr>
            <th scope="row">${e(row.label)}${row.note ? `<span class="cmp__note">${e(row.note)}</span>` : ''}</th>
            ${plans
              .map((p) => {
                const v = row.render(p);
                const cls = v === '✓' ? ' class="yes"' : v === '—' ? ' class="no"' : '';
                const label = v === '✓' ? yes : v === '—' ? no : v;
                return `<td${cls}><span class="visually-hidden">${e(label)}</span><span aria-hidden="true">${e(v)}</span></td>`;
              })
              .join('\n            ')}
          </tr>`,
            )
            .join('\n          ')}
        </tbody>
      </table>
    </div>`;
}
