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

const AUDIENCE: Record<PublicPlanSlug, { audience: string; sizeCue: string }> = {
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

/** Greek thousands separator is the dot: 5.000, not 5,000 and not 5 000. */
export function grNumber(n: number): string {
  return n.toLocaleString('el-GR');
}

/** Storage caps are stored in MB; show GB once that reads more naturally. */
export function storageLabel(mb: number): string {
  return mb >= 1024 ? `${grNumber(mb / 1024)} GB` : `${grNumber(mb)} MB`;
}

/**
 * Price, in the el-GR convention the whole site uses: symbol last, non-breaking
 * space before it, no decimals on whole amounts — and never «0 €», because a
 * zero price is not a price, it is the absence of one.
 */
export function priceLabel(eur: number): string {
  return eur === 0 ? 'Δωρεάν' : `${grNumber(eur)} €`;
}

export const PUBLIC_PLANS: PublicPlan[] = PUBLIC_PLAN_SLUGS.map((slug) => {
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
    ...AUDIENCE[slug],
    features: seed.features as PublicPlan['features'],
  };
});

export type PricingRow = {
  /** Feature key, or a synthetic key for a row the product does not model. */
  key: string;
  label: string;
  note?: string;
  render: (plan: PublicPlan) => string;
};

const yesNo = (v: unknown): string => (v === true ? '✓' : '—');

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
export const PRICING_ROWS: PricingRow[] = [
  {
    key: 'max_books',
    label: 'Τίτλοι στον κατάλογο',
    note: 'Δέκα αντίτυπα του ίδιου βιβλίου μετράνε ως ένας τίτλος.',
    render: (p) => grNumber(Number(p.features.max_books)),
  },
  {
    key: 'max_members',
    label: 'Εγγεγραμμένα μέλη',
    note: 'Τα αρχειοθετημένα μέλη δεν μετράνε.',
    render: (p) => grNumber(Number(p.features.max_members)),
  },
  {
    key: 'staff_seats',
    label: 'Λογαριασμοί προσωπικού',
    note: 'Οι ανενεργοί λογαριασμοί δεν πιάνουν θέση.',
    render: (p) => grNumber(Number(p.features.staff_seats)),
  },
  {
    key: 'max_storage_mb',
    label: 'Χώρος για εξώφυλλα και αρχεία',
    render: (p) => storageLabel(Number(p.features.max_storage_mb)),
  },
  {
    key: 'reservations_enabled',
    label: 'Κρατήσεις και ουρά κρατήσεων',
    render: (p) => yesNo(p.features.reservations_enabled),
  },
  {
    key: 'isbn_lookup_enabled',
    label: 'Συμπλήρωση στοιχείων με ISBN',
    render: (p) => yesNo(p.features.isbn_lookup_enabled),
  },
  {
    key: 'bulk_import_enabled',
    label: 'Μαζική εισαγωγή από CSV, Excel ή MARC',
    render: (p) => yesNo(p.features.bulk_import_enabled),
  },
  {
    key: 'email_notifications_enabled',
    label: 'Ειδοποιήσεις email προς τα μέλη',
    render: (p) => yesNo(p.features.email_notifications_enabled),
  },
  {
    key: 'max_custom_fields_per_entity',
    label: 'Δικά σας πεδία, ανά είδος εγγραφής',
    note: 'Ισχύει χωριστά για κάθε είδος εγγραφής.',
    render: (p) => grNumber(Number(p.features.max_custom_fields_per_entity)),
  },
];
