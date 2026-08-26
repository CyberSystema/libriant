/**
 * The locales the legal corpus is actually PUBLISHED in.
 *
 * privacy-legal-09: this list is deliberately separate from
 * `@libriant/i18n`'s SUPPORTED_LOCALES. They happen to be the same two today,
 * but they answer different questions — "what can the UI be shown in" versus
 * "for which languages does a signed, frozen copy of the Terms exist". If a
 * third UI locale ships before its legal corpus is translated and frozen, the
 * signup DTO must reject an acceptance claimed in it rather than silently
 * record the Greek text as the text the owner read.
 *
 * It lives in its own file, with no NestJS or Prisma imports, so the signup DTO
 * can validate against it without dragging the consent service into
 * class-validator's module graph.
 */
export const LEGAL_LOCALES = ['el', 'en'] as const;

export type LegalLocale = (typeof LEGAL_LOCALES)[number];

export function isLegalLocale(value: unknown): value is LegalLocale {
  return typeof value === 'string' && (LEGAL_LOCALES as readonly string[]).includes(value);
}
