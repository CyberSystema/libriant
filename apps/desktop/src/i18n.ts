import { app } from 'electron';

/**
 * The shell's own el/en strings for the native menu.
 *
 * FE-09: these labels used to be English literals sitting next to
 * `role`-based items (File / Edit / Window / Help) that Electron localizes
 * from the OS language, so a Greek desk got a half-Greek menu bar. The main
 * process cannot borrow the web app's catalogs: `@libriant/i18n` is an ESM
 * TypeScript *source* package and `/locales/**` is read off the Next server's
 * filesystem, while this is a CommonJS `tsc` bundle whose installer ships only
 * `dist/`, `static/` and `package.json` (electron-builder `files`). So the
 * handful of strings the shell owns live here in the same flat el/en shape as
 * `/locales/<lang>/*.json` — ready to move to `locales/{el,en}/desktop.json`
 * the day the packaging can carry them. The offline page keeps its own copy
 * inline (static/fallback.html) because a `file://` page can't read either.
 *
 * Parity is enforced the way check:translations enforces it for the web
 * catalogs: EL is typed as `Record<MessageKey, string>`, so a key added to EN
 * without a Greek translation fails typecheck.
 */
export const SUPPORTED_LOCALES = ['en', 'el'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Greek first — same DEFAULT_LOCALE as @libriant/i18n. */
export const DEFAULT_LOCALE: Locale = 'el';

const EN = {
  'menu.view': 'View',
  'menu.connection': 'Connection',
  'menu.reloadFromServer': 'Reload from server',
  'menu.safeMode': 'Safe mode (ignore saved server)',
  'menu.openConfigFolder': 'Open config folder…',
  'menu.resetServer': 'Reset to default server',
  'menu.checkUpdates': 'Check for updates…',
  'menu.openLogs': 'Open logs…',
} as const;

export type MessageKey = keyof typeof EN;

const EL: Record<MessageKey, string> = {
  'menu.view': 'Προβολή',
  'menu.connection': 'Σύνδεση',
  'menu.reloadFromServer': 'Επαναφόρτωση από τον διακομιστή',
  'menu.safeMode': 'Ασφαλής λειτουργία (αγνόηση αποθηκευμένου διακομιστή)',
  'menu.openConfigFolder': 'Άνοιγμα φακέλου ρυθμίσεων…',
  'menu.resetServer': 'Επαναφορά στον προεπιλεγμένο διακομιστή',
  'menu.checkUpdates': 'Έλεγχος για ενημερώσεις…',
  'menu.openLogs': 'Άνοιγμα αρχείων καταγραφής…',
};

const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en: EN, el: EL };

/** Match on the base subtag ("el-GR" → el), like negotiateLocale() does. */
export function localeFromTag(tag: string | null | undefined): Locale | null {
  const base = tag?.trim().toLowerCase().split(/[-_]/)[0];
  if (!base) return null;
  return (SUPPORTED_LOCALES as readonly string[]).includes(base) ? (base as Locale) : null;
}

/** The locale the web app is showing, read off the URL — every Libriant route
 *  is `/<locale>/…`, so the offline page can stay in the language the
 *  librarian was actually working in rather than the machine's. */
export function localeFromUrl(url: string): Locale | null {
  try {
    return localeFromTag(new URL(url).pathname.split('/')[1]);
  } catch {
    return null;
  }
}

let cached: Locale | null = null;

/**
 * The menu has to key off the SAME source Electron uses for its role items —
 * the OS UI language — or the bar goes half-and-half again. `LIBRIANT_LOCALE`
 * overrides it for a desk whose OS language isn't the staff's. Resolved lazily
 * because app.getLocale() is only reliable once the app is ready.
 */
export function uiLocale(): Locale {
  cached ??=
    localeFromTag(process.env.LIBRIANT_LOCALE) ?? localeFromTag(app.getLocale()) ?? DEFAULT_LOCALE;
  return cached;
}

export function t(key: MessageKey): string {
  return MESSAGES[uiLocale()][key];
}
