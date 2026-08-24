'use client';
import * as React from 'react';
import { defaultUiStrings, type UiStrings } from './ui-strings';

/**
 * Context side of the UI strings. Split from the data so a server component can
 * resolve the strings (see ui-strings.ts) and pass them in as a plain prop.
 */
const Ctx = React.createContext<Partial<UiStrings> | null>(null);

/**
 * Mount once per rendering root, alongside `ToastProvider`. A partial object
 * is accepted so a caller can localize what it has and inherit the rest.
 */
export function UiStringsProvider({
  strings,
  children,
}: {
  strings: Partial<UiStrings>;
  children: React.ReactNode;
}) {
  const value = React.useMemo(() => strings, [strings]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

let warnedAboutMissingProvider = false;

export function useUiStrings(): UiStrings {
  const provided = React.useContext(Ctx);
  if (!provided && !warnedAboutMissingProvider) {
    warnedAboutMissingProvider = true;
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc && proc.env?.NODE_ENV !== 'production') {
      console.warn(
        '[@libriant/ui] No <UiStringsProvider>: dialog and toast controls will announce their ' +
          'English fallback labels. Wrap the tree in <UiStringsProvider strings={uiStringsFromCatalog(t)}>.',
      );
    }
  }
  return React.useMemo(
    () => (provided ? { ...defaultUiStrings, ...provided } : defaultUiStrings),
    [provided],
  );
}
