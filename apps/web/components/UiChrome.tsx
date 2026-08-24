'use client';
import * as React from 'react';
import { ToastProvider, UiStringsProvider } from '@libriant/ui';
import type { UiStrings } from '@libriant/ui';

/**
 * The two providers the design system needs, mounted together so they cannot
 * drift apart.
 *
 * `packages/ui` owns the accessible names for its own controls — the toast
 * dismiss button, the modal and drawer close buttons, the destructive-confirm
 * prompts — and reads them from `UiStringsProvider`. Without that provider it
 * falls back to English defaults, which is how a Greek circulation desk ended
 * up announcing "Close", "Dismiss" and "Delete forever" to screen-reader users
 * (finding frontend-13).
 *
 * The provider was written and then mounted nowhere: `ToastProvider` appears at
 * five separate points across two layouts, and adding a sixth without also
 * adding the strings would silently revert the fix. Pairing them in one
 * component means the only way to get a toast stack is to get the labels with
 * it.
 *
 * `strings` must be a plain object of plain strings: it crosses the server →
 * client boundary, so a translator function could not be passed instead. The
 * server layout calls `uiStringsFromCatalog(t)` and hands the result down.
 */
export function UiChrome({
  strings,
  children,
}: {
  strings: Partial<UiStrings>;
  children: React.ReactNode;
}) {
  return (
    <UiStringsProvider strings={strings}>
      <ToastProvider>{children}</ToastProvider>
    </UiStringsProvider>
  );
}
