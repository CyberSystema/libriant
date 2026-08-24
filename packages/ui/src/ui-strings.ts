/**
 * The design system's own accessible names, as DATA.
 *
 * Deliberately NOT a client module. `uiStringsFromCatalog()` is called from
 * Next server layouts, which hand the resulting plain object down to
 * `UiStringsProvider`; a `'use client'` directive here makes the whole module
 * client-only and the build fails with "Attempted to call
 * uiStringsFromCatalog() from the server". The React context that consumes this
 * lives in ui-strings-context.tsx, which is where the directive belongs.
 *
 * Everything exported here is a pure function or plain data for exactly that
 * reason — a translator function cannot cross the server/client boundary, so
 * the server resolves the strings and passes values, not callbacks.
 */
/**
 * The handful of strings the design system speaks on its own behalf.
 *
 * frontend-13: every dismiss/close control in the package announced an
 * English label inside a Greek interface, and one of them — the toast's
 * `aria-label="Dismiss"` — could not be localized at all because there was no
 * prop for it. The props that did exist were never passed: zero call sites for
 * `closeLabel` across twelve `<Modal>`s, zero for `dismissLabel`, zero for
 * `HelpButton`'s `ariaLabel`. An optional prop with an English default is a
 * string that will be English forever.
 *
 * Threading a label through every call site would have repeated that mistake
 * twelve more times, so the strings come from one context instead. The values
 * still live in `/locales/<lang>/common.json` — the catalogue the loader
 * describes as "the design-system catalogue that every package shares" — and
 * `uiStringsFromCatalog` maps them, so a caller cannot get a key name wrong.
 *
 * The English values below are the last resort for a tree with no provider,
 * not a translation strategy. `useUiStrings` says so out loud in development.
 *
 * Every member is a plain string, deliberately: a Next.js server layout is the
 * natural place to mount the provider, and functions cannot cross the
 * server/client boundary. The two strings that need a runtime value carry
 * `VALUE_MARKER` where it goes and are finished with `fillMarker` /
 * `splitAroundMarker` at the point of render.
 */
/**
 * Split a rendered string around a value that has to be wrapped in markup.
 *
 * `confirmTypePrompt` puts the resource's name inside a `<code>` so the
 * librarian can see the exact characters (including trailing spaces) they
 * have to type — but the sentence order around it differs by language, so the
 * markup cannot be hardcoded on either side. We render with an invisible
 * marker and split on it. Falls back to putting the value at the end when a
 * translation dropped the placeholder.
 */
export const VALUE_MARKER = '\u2063'; // INVISIBLE SEPARATOR — never appears in copy

export function splitAroundMarker(
  rendered: string,
  marker: string = VALUE_MARKER,
): [string, string] {
  const at = rendered.indexOf(marker);
  if (at === -1) return [rendered.endsWith(' ') ? rendered : `${rendered} `, ''];
  return [rendered.slice(0, at), rendered.slice(at + marker.length)];
}

/** Same idea when the value needs no markup around it — just substitute it. */
export function fillMarker(
  rendered: string,
  value: string | number,
  marker: string = VALUE_MARKER,
): string {
  return rendered.includes(marker)
    ? rendered.replace(marker, String(value))
    : `${value} ${rendered}`;
}

export type UiStrings = {
  /** Accessible name of a dialog's × button. */
  close: string;
  cancel: string;
  /** Accessible name of a toast's or banner's × button. */
  dismiss: string;
  /** Accessible name of the toast stack's live region. */
  notifications: string;
  /** Accessible name of the `?` help trigger. */
  helpShow: string;
  /** Accessible name of the help drawer's × button. */
  helpClose: string;
  /** Standing warning inside a typed-confirmation dialog. */
  confirmIrreversible: string;
  /** "Type <the name> to confirm", with `VALUE_MARKER` standing in for the name. */
  confirmTypePrompt: string;
  confirmTypeHint: string;
  confirmDeleteForever: string;
  comboboxClear: string;
  comboboxSearching: string;
  comboboxNoMatches: string;
  comboboxSearchFailed: string;
  /** Announced to screen readers as the list updates: exactly one match. */
  comboboxResultsOne: string;
  /** …and more than one, with `VALUE_MARKER` standing in for the count. */
  comboboxResultsOther: string;
};

/** Catalogue ids backing each string, for `uiStringsFromCatalog` and for CI. */
export const UI_STRING_KEYS: Readonly<Record<keyof UiStrings, string>> = {
  close: 'common.actions.close',
  cancel: 'common.actions.cancel',
  dismiss: 'common.actions.dismiss',
  notifications: 'common.ui.notifications',
  helpShow: 'common.help.show',
  helpClose: 'common.help.close',
  confirmIrreversible: 'common.confirm.irreversible',
  confirmTypePrompt: 'common.confirm.typePrompt',
  confirmTypeHint: 'common.confirm.typeHint',
  confirmDeleteForever: 'common.confirm.deleteForever',
  comboboxClear: 'common.combobox.clear',
  comboboxSearching: 'common.combobox.searching',
  comboboxNoMatches: 'common.combobox.noMatches',
  comboboxSearchFailed: 'common.combobox.searchFailed',
  comboboxResultsOne: 'common.combobox.results.one',
  comboboxResultsOther: 'common.combobox.results.other',
};

export const defaultUiStrings: UiStrings = {
  close: 'Close',
  cancel: 'Cancel',
  dismiss: 'Dismiss',
  notifications: 'Notifications',
  helpShow: 'Show help for this page',
  helpClose: 'Close help',
  confirmIrreversible: 'This cannot be undone.',
  confirmTypePrompt: `Type ${VALUE_MARKER} to confirm`,
  confirmTypeHint:
    'Match is case-insensitive. The confirm button stays disabled until the text matches.',
  confirmDeleteForever: 'Delete forever',
  comboboxClear: 'Clear selection',
  comboboxSearching: 'Searching…',
  comboboxNoMatches: 'No matches.',
  comboboxSearchFailed: "Couldn't search.",
  comboboxResultsOne: '1 result',
  comboboxResultsOther: `${VALUE_MARKER} results`,
};

/**
 * Build the set from a translator, e.g. `createTranslator(catalog, locale)`
 * from `@libriant/i18n`. Typed structurally so this package keeps no
 * dependency on the i18n package.
 */
export function uiStringsFromCatalog(
  t: (id: string, values?: Record<string, string | number>) => string,
): UiStrings {
  return {
    close: t(UI_STRING_KEYS.close),
    cancel: t(UI_STRING_KEYS.cancel),
    dismiss: t(UI_STRING_KEYS.dismiss),
    notifications: t(UI_STRING_KEYS.notifications),
    helpShow: t(UI_STRING_KEYS.helpShow),
    helpClose: t(UI_STRING_KEYS.helpClose),
    confirmIrreversible: t(UI_STRING_KEYS.confirmIrreversible),
    // Rendered with the marker in place of the value; the component splices the
    // real one in, so this stays a plain serializable string.
    confirmTypePrompt: t(UI_STRING_KEYS.confirmTypePrompt, { text: VALUE_MARKER }),
    confirmTypeHint: t(UI_STRING_KEYS.confirmTypeHint),
    confirmDeleteForever: t(UI_STRING_KEYS.confirmDeleteForever),
    comboboxClear: t(UI_STRING_KEYS.comboboxClear),
    comboboxSearching: t(UI_STRING_KEYS.comboboxSearching),
    comboboxNoMatches: t(UI_STRING_KEYS.comboboxNoMatches),
    comboboxSearchFailed: t(UI_STRING_KEYS.comboboxSearchFailed),
    comboboxResultsOne: t(UI_STRING_KEYS.comboboxResultsOne),
    comboboxResultsOther: t(UI_STRING_KEYS.comboboxResultsOther, { count: VALUE_MARKER }),
  };
}
