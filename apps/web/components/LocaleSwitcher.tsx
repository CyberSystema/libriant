'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isLocale, LOCALE_DISPLAY, SUPPORTED_LOCALES, type Locale } from '@libriant/i18n';
import { rememberLocale } from '@/lib/locale-preference';

/**
 * In-app language switch.
 *
 * The only one in the product used to be on the public landing page, so a
 * librarian whose browser advertised en-US was served the whole application in
 * English with nothing in the UI to change it — they had to hand-edit the URL.
 * This keeps the reader on the page they are already looking at (same path,
 * different locale prefix) and writes the choice to a cookie so the next visit,
 * the redirect at `/`, and the offline page all honour it.
 *
 * The class names are overridable because the landing page styles its switch
 * against the hero rather than against the app chrome.
 */
export function LocaleSwitcher({
  locale,
  label,
  className = 'lbr-locale-switch',
  optionClassName = 'lbr-locale-switch__option',
  activeOptionClassName = 'lbr-locale-switch__option--active',
}: {
  locale: Locale;
  /** Accessible name for the group, e.g. t('shell.locale.label'). */
  label: string;
  className?: string;
  optionClassName?: string;
  activeOptionClassName?: string;
}) {
  const pathname = usePathname() ?? `/${locale}`;

  function hrefFor(target: Locale): string {
    const segments = pathname.split('/');
    // Inside the app every path is `/<locale>/…`. The admin plane is the one
    // exception (served locale-free, English-only), so if the first segment
    // isn't a locale we send the reader to that language's home rather than
    // corrupting the path.
    if (!isLocale(segments[1] ?? '')) return `/${target}`;
    segments[1] = target;
    return segments.join('/');
  }

  return (
    <div className={className} role="group" aria-label={label}>
      {SUPPORTED_LOCALES.map((loc) => {
        const active = loc === locale;
        return (
          <Link
            key={loc}
            href={hrefFor(loc)}
            hrefLang={loc}
            lang={loc}
            prefetch={false}
            aria-current={active ? 'true' : undefined}
            className={active ? `${optionClassName} ${activeOptionClassName}` : optionClassName}
            onClick={() => rememberLocale(loc)}
          >
            {LOCALE_DISPLAY[loc].native}
          </Link>
        );
      })}
    </div>
  );
}
