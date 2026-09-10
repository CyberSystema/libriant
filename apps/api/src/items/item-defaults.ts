/**
 * The four rows a library must have before it can hold a single copy.
 *
 * `items` has five NOT NULL foreign keys — `holdings_record_id`, `bib_id`,
 * `item_type_id`, `owning_branch_id`, `current_branch_id`,
 * `permanent_location_id` — and until phase 15 a freshly provisioned 2.0 tenant
 * had rows for none of them. Measured on a real provision: `branches`,
 * `shelving_locations`, `item_types` and `material_types` all zero, so the very
 * first `POST /items` a library could make was a foreign-key error. The holdings
 * record is the one gap `ItemsService` closes on its own, by auto-creating a
 * default per (bib, branch); the other three cannot be invented from the request
 * because they carry a name a librarian has to choose.
 *
 * ## The same argument `circulation-defaults.ts` makes, and it is not repetition
 *
 * A DEFAULT is a value a service falls back to when it cannot find a row:
 * invisible, unattributable, and it puts a book on a shelf nobody named. A SEED
 * is a row with a name, a `created_at` and an audit trail that the librarian can
 * see, rename and archive. These are seeds. The moment they are written they
 * stop being ours — a library that renames "Main library" to "Δημοτική
 * Βιβλιοθήκη Λαυρίου" has not diverged from anything.
 *
 * ## Europe/Athens, and why a seed may state a timezone at all
 *
 * `branches.timezone` is THE `circ-5` fix and it is NOT NULL — there is no such
 * thing as a branch without one, so a seed has to choose. It chooses the
 * product's market: `addressCountry` already defaults to `GR` across this
 * codebase and `branches.default_locale` to `el`. A wrong zone here is visible
 * and fixable on the branch form in one field; a NULL one is not expressible at
 * all, and a branch created without one could not compute a due date.
 *
 * ## Idempotent by count, not by upsert
 *
 * `if (count > 0) return false` — the same shape `seedCirculationDefaults`
 * uses, and for the same reason: re-running provisioning on a library that has
 * already created its own branches must add nothing. An upsert on a fixed id
 * would silently rewrite a branch a librarian had renamed.
 */

export const DEFAULT_ITEM_IDS = {
  /**
   * Readable and stable, like `rule-default`. It is written into
   * `items.owning_branch_id` on every copy a one-branch library ever creates and
   * into `loans.checkout_branch_id` on every loan, and it is what a support
   * conversation names. A cuid would put an opaque 25-character string in both.
   */
  branch: 'branch-main',
  location: 'loc-general',
  itemType: 'itype-book',
  materialType: 'mtype-volume',
} as const;

/** The default timezone. See the docblock — this is the `circ-5` column. */
export const DEFAULT_TIMEZONE = 'Europe/Athens';

type SeedClient = {
  branch: { count: () => Promise<number>; create: (a: never) => Promise<unknown> };
  shelvingLocation: { create: (a: never) => Promise<unknown> };
  itemType: { count: () => Promise<number>; create: (a: never) => Promise<unknown> };
  materialType: { create: (a: never) => Promise<unknown> };
};

/**
 * Seed a branch, a shelving location, an item type and a material type.
 *
 * Returns whether it wrote anything, so provisioning can log it and a re-run
 * over a live library is a no-op it can say so about.
 */
export async function seedItemDefaults(client: SeedClient, now: Date): Promise<boolean> {
  // Two counts, not one, because the two halves are independent: a library could
  // conceivably have created a branch through the org screens and still have no
  // item type, and seeding neither because one exists would leave it unable to
  // catalogue.
  const [branches, itemTypes] = await Promise.all([client.branch.count(), client.itemType.count()]);
  if (branches > 0 && itemTypes > 0) return false;

  if (branches === 0) {
    await client.branch.create({
      data: {
        id: DEFAULT_ITEM_IDS.branch,
        code: 'MAIN',
        name: 'Main library',
        nameI18n: { el: 'Κεντρική βιβλιοθήκη', en: 'Main library' },
        kind: 'branch',
        timezone: DEFAULT_TIMEZONE,
        depth: 0,
        createdAt: now,
        updatedAt: now,
      },
    } as never);

    await client.shelvingLocation.create({
      data: {
        id: DEFAULT_ITEM_IDS.location,
        branchId: DEFAULT_ITEM_IDS.branch,
        code: 'GEN',
        name: 'General collection',
        nameI18n: { el: 'Γενική συλλογή', en: 'General collection' },
        opacName: 'General collection',
        opacNameI18n: { el: 'Γενική συλλογή', en: 'General collection' },
        // Browsable and visible: the open stacks are what a public library is.
        // The closed store, the workroom and the conservation lab are the
        // locations a librarian adds later and turns both flags off for.
        browsable: true,
        opacVisible: true,
        // MARC 21 Holdings 852 $c — the shelving location as it appears in an
        // export. Seeded rather than left null so a library that exports before
        // it has configured anything still says where its copies are.
        marc852c: 'GEN',
        // NULL: nothing floats until somebody says so. Phase 23 owns the rules
        // this selector feeds.
        floatingGroup: null,
        createdAt: now,
        updatedAt: now,
      },
    } as never);
  }

  if (itemTypes === 0) {
    // POLICY. What the rules matrix keys on — deliberately split from
    // `material_types`, which is display and facets only. One of each, so a
    // library can catalogue on day one without deciding its policy taxonomy
    // first.
    await client.itemType.create({
      data: {
        id: DEFAULT_ITEM_IDS.itemType,
        code: 'BOOK',
        name: 'Book',
        nameI18n: { el: 'Βιβλίο', en: 'Book' },
        createdAt: now,
        updatedAt: now,
      },
    } as never);

    await client.materialType.create({
      data: {
        id: DEFAULT_ITEM_IDS.materialType,
        code: 'VOLUME',
        name: 'Volume',
        nameI18n: { el: 'Τόμος', en: 'Volume' },
        createdAt: now,
        updatedAt: now,
      },
    } as never);
  }

  return true;
}
