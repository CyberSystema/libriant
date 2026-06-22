/**
 * Library-profile field taxonomy, shared by the API (validation + apply) and the
 * web (forms + display). Kept here so "which fields exist" and "which need
 * owner approval" have a single source of truth.
 */

export const LIBRARY_TYPES = [
  'public',
  'academic',
  'school',
  'special',
  'community',
  'other',
] as const;
export type LibraryType = (typeof LIBRARY_TYPES)[number];

export function isLibraryType(v: unknown): v is LibraryType {
  return typeof v === 'string' && (LIBRARY_TYPES as readonly string[]).includes(v);
}

/**
 * "Core" fields — identity + address. Changing any of these on an existing
 * library requires a platform-owner-approved {@link LibraryEditRequest}. `name`
 * lives on the Tenant already; the rest were added with the profile.
 */
export const CORE_PROFILE_FIELDS = [
  'name',
  'libraryType',
  'addressStreet',
  'addressCity',
  'addressPostalCode',
  'addressRegion',
  'addressCountry',
] as const;
export type CoreProfileField = (typeof CORE_PROFILE_FIELDS)[number];

/**
 * "Free" fields — public contact + description. A tenant owner/admin edits these
 * directly, no approval needed.
 */
export const FREE_PROFILE_FIELDS = [
  'publicPhone',
  'publicEmail',
  'website',
  'description',
  'foundedYear',
] as const;
export type FreeProfileField = (typeof FREE_PROFILE_FIELDS)[number];

export function isCoreProfileField(k: string): k is CoreProfileField {
  return (CORE_PROFILE_FIELDS as readonly string[]).includes(k);
}
export function isFreeProfileField(k: string): k is FreeProfileField {
  return (FREE_PROFILE_FIELDS as readonly string[]).includes(k);
}
