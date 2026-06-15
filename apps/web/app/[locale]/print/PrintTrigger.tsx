'use client';
import * as React from 'react';
import { isDesktopApp } from '@/lib/desktop';

/**
 * Browser-only: raise the print dialog once the print page has painted.
 *
 * No-op in two cases, both of which would otherwise cause a duplicate dialog:
 *   - the desktop shell drives a SILENT job via the bridge (isDesktopApp), and
 *   - the shell's hidden print window loads us with the `#shellprint` marker.
 */
export function PrintTrigger() {
  React.useEffect(() => {
    if (isDesktopApp()) return;
    if (window.location.hash === '#shellprint') return;
    // Defer a beat so the barcode SVG + fonts are laid out before printing.
    const id = window.setTimeout(() => window.print(), 250);
    return () => window.clearTimeout(id);
  }, []);
  return null;
}
