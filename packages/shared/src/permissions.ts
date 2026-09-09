/**
 * The permission catalog — what a member of library staff may do.
 *
 * WHAT THIS REPLACES. Authorization was four roles checked by
 * `apps/api/src/tenancy/roles.guard.ts`: `owner`, `admin`, `librarian`,
 * `volunteer`, with `@StaffWrite()` as shorthand for the first three. That is
 * enough for a five-person school library and runs out immediately above it:
 *
 *   A library cannot say "Maria may waive a fine, but not one over €5." The
 *   whole of fee forgiveness is one bit, held by two roles.
 *
 *   A library cannot say "Kostas runs the Kifisia branch." There is no branch
 *   dimension at all, so a multi-branch service gives everyone the whole fleet
 *   or nothing.
 *
 *   A library cannot add a role. The four are compiled into an enum, so
 *   "cataloguer who cannot touch circulation" is a feature request.
 *
 * And it does not scale in the direction this product is going: acquisitions,
 * serials, ILL and the report builder each bring their own verbs, and folding
 * them into four roles means every new module makes `admin` broader.
 *
 * THE SHAPE. A permission is a KEY. A role is a named set of keys, plus a
 * numeric LIMIT on the keys that take one. A person holds roles, optionally
 * scoped to a branch, plus per-person overrides. Nothing is implied: a key not
 * granted is denied, and `PermissionGuard` fails closed.
 *
 * ONE VOCABULARY, NOT SEVERAL. OAuth scopes (M10) are a projection of these
 * keys, never a parallel list — the moment there are two vocabularies for "may
 * waive a fine", they disagree, and the one nobody is looking at is the one
 * that grants it.
 *
 * KEYS ARE FOREVER. A key is written into a library's `role_permissions` rows
 * the day they customise a role. Renaming one silently drops the grant, so a
 * rename is a migration, not an edit.
 *
 * WHAT IS AND IS NOT HERE. Every key the shipped product enforces today is
 * below. Namespaces for modules that do not exist yet — `acq.*`, `ser.*`,
 * `ill.*`, `erm.*`, `opac.*`, `plugin.*` — are RESERVED in {@link
 * PERMISSION_MODULES} and their keys arrive with their phases. Inventing 90
 * keys for unwritten features would be 90 guesses nothing can check.
 *
 * Patron authorization is a different plane entirely and is not modelled here:
 * a patron is not staff with fewer permissions, and `PatronGuard` never
 * consults this catalog.
 */

export type PermissionKind = 'action' | 'limit';

export interface PermissionDescriptor {
  readonly key: string;
  /**
   * `action` is a plain may/may-not. `limit` additionally carries a numeric
   * ceiling — `circ.fee.waive` with `limitNum: 500` waives up to €5.00 and
   * refuses €5.01 — so the grant is a number, not a bit.
   */
  readonly kind: PermissionKind;
  readonly module: PermissionModule;
  /** Shown in the role editor. Not a translation key: staff-facing copy lives in locales/. */
  readonly label: string;
}

export const PERMISSION_MODULES = {
  cat: 'Cataloguing',
  circ: 'Circulation',
  patron: 'Patrons',
  data: 'Data model',
  report: 'Reports',
  billing: 'Billing',
  support: 'Support access',
  admin: 'Library administration',
  // Reserved. Keys arrive with the phase that builds the module; see the
  // roadmap in docs/architecture/libriant-2.0/.
  acq: 'Acquisitions',
  ser: 'Serials',
  erm: 'Electronic resources',
  ill: 'Interlibrary loan',
  opac: 'Public catalogue',
  plugin: 'Plugins',
} as const;

export type PermissionModule = keyof typeof PERMISSION_MODULES;

const def = (
  key: string,
  module: PermissionModule,
  label: string,
  kind: PermissionKind = 'action',
): PermissionDescriptor => ({ key, module, label, kind });

export const PERMISSIONS: readonly PermissionDescriptor[] = [
  // --- cataloguing --------------------------------------------------------
  def('cat.bib.read', 'cat', 'View the catalogue'),
  def('cat.bib.write', 'cat', 'Create and edit bibliographic records'),
  def('cat.bib.delete', 'cat', 'Archive bibliographic records'),
  def('cat.item.write', 'cat', 'Create and edit copies'),
  def('cat.item.delete', 'cat', 'Archive copies'),
  def('cat.cover.write', 'cat', 'Upload and remove cover images'),
  def('cat.isbn.lookup', 'cat', 'Look up bibliographic data by ISBN'),
  // Deliberately NOT held by librarian, while `cat.cover.write` is. Uploading a
  // file and destroying one are different acts, and the storage routes have
  // said so since authn-authz-06 — the upload is staff-write, the delete is
  // owner/admin. Splitting the key is what preserves that.
  def('cat.file.delete', 'cat', 'Delete a stored file'),

  // --- circulation --------------------------------------------------------
  def('circ.loan.read', 'circ', 'View loans'),
  def('circ.loan.checkout', 'circ', 'Check items out'),
  def('circ.loan.edit', 'circ', 'Edit a loan'),
  def('circ.loan.return', 'circ', 'Check items in'),
  def('circ.loan.renew', 'circ', 'Renew a loan'),
  def('circ.loan.mark_lost', 'circ', 'Declare an item lost'),
  def('circ.hold.read', 'circ', 'View holds'),
  def('circ.hold.place', 'circ', 'Place a hold'),
  def('circ.hold.edit', 'circ', 'Edit a hold'),
  def('circ.hold.cancel', 'circ', 'Cancel a hold'),
  def('circ.hold.expire', 'circ', 'Expire a hold that was not collected'),
  def('circ.hold.fulfill', 'circ', 'Fulfil a hold'),
  def('circ.fee.read', 'circ', 'View fees'),
  def('circ.fee.pay', 'circ', 'Take payment for a fee'),
  // The two that carry a ceiling. A library can hand fee forgiveness to the
  // desk without handing over the whole balance sheet.
  def('circ.fee.waive', 'circ', 'Waive a fee, up to a limit', 'limit'),
  def('circ.fee.void', 'circ', 'Void a fee, up to a limit', 'limit'),
  // The rules matrix and the five policies behind it (2.0 phase 13). READ is
  // separate from MANAGE because `/circulation/explain` — "why is this book due
  // on the 19th?" — is a question a librarian at the desk has to be able to
  // answer for a patron standing in front of them, and it is the question §6
  // says Koha, Alma and FOLIO cannot answer at all. Handing over the ability to
  // ANSWER it should not hand over the ability to change what the answer is.
  def('circ.policy.read', 'circ', 'View circulation rules and why a loan was priced'),
  def('circ.policy.manage', 'circ', 'Change circulation rules, policies and calendars'),

  // --- patrons ------------------------------------------------------------
  def('patron.read', 'patron', 'View patrons'),
  def('patron.write', 'patron', 'Create and edit patrons'),
  def('patron.status', 'patron', 'Suspend or reinstate a patron'),
  def('patron.archive', 'patron', 'Archive a patron'),
  def('patron.photo.write', 'patron', 'Upload and remove patron photos'),
  // Deliberately separate from patron.read. A subject-access bundle is every
  // loan a person has ever taken, and handing it out is not the same act as
  // looking someone up at the desk. Support access never holds it.
  def('patron.pii.export', 'patron', 'Export a patron’s personal data (GDPR)'),
  // Irreversible. Held by owner and admin only, and never by support.
  def('patron.erase', 'patron', 'Erase a patron’s personal data permanently'),
  // Two records for one person, folded into one (2.0 phase 14). Separate from
  // `patron.write` because it moves another person's loans, fees and cards onto
  // a record, and because it is only reversible by hand — `merged_into_id` and
  // the `patron_merges` row say what happened, but nothing un-merges.
  def('patron.merge', 'patron', 'Merge two patron records into one'),
  // Placing and lifting a block is desk work: it is what a librarian does when
  // somebody has four books thirty days over. It is NOT `patron.status`, which
  // suspends a person for everything.
  def('patron.block.manage', 'patron', 'Place and lift a block on a patron'),

  // --- the tenant's own data model ---------------------------------------
  def('data.field.read', 'data', 'View custom fields'),
  def('data.field.manage', 'data', 'Add and change custom fields'),
  def('data.collection.read', 'data', 'View custom collections'),
  def('data.collection.manage', 'data', 'Add and change custom collections'),
  def('data.record.read', 'data', 'View records in a custom collection'),
  def('data.record.write', 'data', 'Create and edit records in a custom collection'),
  def('data.record.delete', 'data', 'Delete records from a custom collection'),

  // --- reports ------------------------------------------------------------
  def('report.dashboard.read', 'report', 'View the dashboard'),

  // --- billing ------------------------------------------------------------
  def('billing.read', 'billing', 'View the subscription'),
  def('billing.manage', 'billing', 'Change or cancel the subscription'),

  // --- support access -----------------------------------------------------
  def('support.key.manage', 'support', 'Issue and revoke support access keys'),
  def('support.session.read', 'support', 'View support sessions and their audit log'),
  def('support.session.revoke', 'support', 'End an active support session'),

  // --- library administration --------------------------------------------
  def('admin.settings.read', 'admin', 'View library settings'),
  def('admin.settings.edit', 'admin', 'Change library settings'),
  def('admin.library.read', 'admin', 'View the library profile'),
  def('admin.library.edit', 'admin', 'Change the library profile'),
  def('admin.branding.manage', 'admin', 'Change the library’s branding'),
  def('admin.staff.manage', 'admin', 'Invite, edit and deactivate staff'),
  def('admin.audit.read', 'admin', 'View the activity log'),
  def('admin.import.manage', 'admin', 'Import data'),
  def('admin.export.manage', 'admin', 'Export data'),
  def('admin.plan.read', 'admin', 'View the plan and its usage'),
  def('admin.legal.read', 'admin', 'View the legal agreements'),
  // Owner only, and the only key in the catalog that is. Accepting terms binds
  // the library, which is not a delegable act.
  def('admin.legal.accept', 'admin', 'Accept the legal agreements on behalf of the library'),
  def('admin.desktop.download', 'admin', 'Download the desktop application'),
  def('admin.announcement.read', 'admin', 'See platform announcements'),
  // Reserved for M10 (SSO, SCIM, passkeys). Declared now because the support
  // role is defined by what it does NOT hold, and that list has to be stable.
  def('admin.identity.manage', 'admin', 'Manage single sign-on and identity providers'),
] as const;

export const PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);

const BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));

export function getPermission(key: string): PermissionDescriptor | undefined {
  return BY_KEY.get(key);
}

export function isPermissionKey(value: unknown): value is string {
  return typeof value === 'string' && BY_KEY.has(value);
}

/** Keys that take a numeric ceiling. */
export const LIMIT_PERMISSION_KEYS: readonly string[] = PERMISSIONS.filter(
  (p) => p.kind === 'limit',
).map((p) => p.key);

// ---------------------------------------------------------------------------
// Built-in role templates
// ---------------------------------------------------------------------------

/**
 * The four shipped roles, defined so the decision for every existing route is
 * IDENTICAL to what `RolesGuard` decided.
 *
 * That equivalence is not a claim, it is a test: `authorization-matrix.spec.ts`
 * enumerates every registered route from the Nest router and asserts, for each
 * of the four roles, that the permission model reaches the same verdict the
 * role check did. The frozen record of the old behaviour is committed beside
 * it. If a template here changes, that test says which routes moved.
 *
 * `SUPPORT` is the exception, and deliberately: it is `admin` MINUS the keys
 * below. A Libriant admin inside a consented four-hour support window used to
 * act with the full `admin` role, which meant they could export a patron's
 * complete borrowing history and erase a patron outright. A library consenting
 * to "help me fix my catalogue" did not consent to either.
 *
 * WHAT IS DELIBERATELY *NOT* ON THIS LIST, and why. Support keeps
 * `admin.staff.manage`, `billing.manage`, `admin.export.manage` and
 * `support.key.manage`, because `apps/api/src/support/impersonation-policy.ts`
 * already fences those — by PATH and by METHOD, so reads pass and writes do
 * not, with a specific message per rule and a stable id recorded on the
 * library's own audit row.
 *
 * Denying the KEY instead was tried and was worse in two measurable ways.
 * Guards run before interceptors, so the permission refusal fired first and
 * replaced the policy's message ("a password minted here would still work
 * after this four-hour window closes") with a generic one, and lost the audit
 * id with it. And a key is not method-scoped: denying `admin.staff.manage`
 * also blocked `GET /t/:slug/staff`, which the policy allows on purpose —
 * "support has to be able to see who works there in order to help". The
 * existing support-impersonation suite caught both.
 *
 * So the rule is: if the harm is a WRITE UNDER A PATH, the policy owns it. If
 * the harm is holding a capability at all, this list owns it.
 */
export const SUPPORT_DENIED_KEYS: readonly string[] = [
  // Every loan a person has ever taken. A read, so no write-scoped path rule
  // covers it, and not something "help me fix my catalogue" includes.
  'patron.pii.export',
  // Irreversible, and under `members`, which has no path rule.
  'patron.erase',
  // No route yet — M10. Declared now because this list defines the role by
  // what it does not hold, and that definition has to be stable before the
  // first identity route exists rather than after.
  'admin.identity.manage',
];

/** Everything a volunteer may do: look, and never touch. */
const VOLUNTEER: readonly string[] = [
  'cat.bib.read',
  'cat.isbn.lookup',
  'circ.loan.read',
  'circ.hold.read',
  'circ.fee.read',
  'patron.read',
  'data.field.read',
  'data.collection.read',
  'data.record.read',
  'report.dashboard.read',
  'admin.desktop.download',
  'admin.announcement.read',
  // Reads a volunteer already had. `GET /t/:slug/settings` and the three
  // billing reads carry no role check today, so putting these in `admin` and
  // `billing` alone would have QUIETLY REVOKED them — which is what the
  // equivalence matrix caught, on eight decisions, before a line of controller
  // was touched.
  'admin.settings.read',
  'billing.read',
];

/** Adds the daily work of a circulation desk and a cataloguer. */
const LIBRARIAN: readonly string[] = [
  ...VOLUNTEER,
  'cat.bib.write',
  'cat.bib.delete',
  'cat.item.write',
  'cat.item.delete',
  'cat.cover.write',
  'circ.loan.checkout',
  'circ.loan.edit',
  'circ.loan.return',
  'circ.loan.renew',
  'circ.loan.mark_lost',
  'circ.hold.place',
  'circ.hold.edit',
  'circ.hold.cancel',
  'circ.hold.expire',
  'circ.hold.fulfill',
  'circ.fee.pay',
  // Read, not manage. A librarian must be able to answer "why is this due on the
  // 19th?"; changing what the answer is belongs to whoever is accountable for
  // the library's policy.
  'circ.policy.read',
  'patron.write',
  'patron.status',
  'patron.archive',
  'patron.photo.write',
  'patron.block.manage',
  'patron.pii.export',
  'data.record.write',
  'data.record.delete',
];

/** Runs the library: settings, staff, money, and the destructive verbs. */
const ADMIN: readonly string[] = [
  ...LIBRARIAN,
  'cat.file.delete',
  'circ.fee.waive',
  'circ.fee.void',
  'circ.policy.manage',
  'patron.erase',
  'patron.merge',
  'data.field.manage',
  'data.collection.manage',
  'billing.manage',
  'support.key.manage',
  'support.session.read',
  'support.session.revoke',
  'admin.settings.edit',
  'admin.library.read',
  'admin.library.edit',
  'admin.branding.manage',
  'admin.staff.manage',
  'admin.audit.read',
  'admin.import.manage',
  'admin.export.manage',
  'admin.plan.read',
  'admin.legal.read',
  'admin.identity.manage',
];

/** Everything, including the one key that binds the library legally. */
const OWNER: readonly string[] = [...ADMIN, 'admin.legal.accept'];

export type BuiltInRoleKey = 'owner' | 'admin' | 'librarian' | 'volunteer' | 'support';

export interface RoleTemplate {
  readonly key: BuiltInRoleKey;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly string[];
}

export const ROLE_TEMPLATES: Readonly<Record<BuiltInRoleKey, RoleTemplate>> = {
  owner: {
    key: 'owner',
    name: 'Owner',
    description: 'Everything, including accepting the legal agreements.',
    permissions: dedupe(OWNER),
  },
  admin: {
    key: 'admin',
    name: 'Administrator',
    description: 'Runs the library: settings, staff, billing and the destructive actions.',
    permissions: dedupe(ADMIN),
  },
  librarian: {
    key: 'librarian',
    name: 'Librarian',
    description: 'The daily work of a circulation desk and a cataloguer.',
    permissions: dedupe(LIBRARIAN),
  },
  volunteer: {
    key: 'volunteer',
    name: 'Volunteer',
    description: 'May look at everything and change nothing.',
    permissions: dedupe(VOLUNTEER),
  },
  support: {
    key: 'support',
    name: 'Libriant support',
    description:
      'What a Libriant administrator holds inside a consented support window: the ' +
      'administrator role, minus a patron’s personal data, staff management and identity ' +
      'configuration.',
    permissions: dedupe(ADMIN).filter((k) => !SUPPORT_DENIED_KEYS.includes(k)),
  },
};

function dedupe(keys: readonly string[]): readonly string[] {
  return [...new Set(keys)].sort();
}
