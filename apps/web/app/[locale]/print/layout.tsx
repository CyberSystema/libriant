import * as React from 'react';
import { PrintTrigger } from './PrintTrigger';

/**
 * Chrome-free wrapper for printable documents (receipts, labels).
 *
 * It sits OUTSIDE the tenant shell (no sidebar/topbar) but inside the `[locale]`
 * document, so it still inherits the theme tokens + `AssetProvider`. Auth is
 * enforced per-page: each print page resolves the session from the request
 * cookie and fetches via that cookie — and the API is the authority — so an
 * unauthenticated request renders nothing useful.
 *
 * `@media print` hides any non-print siblings (e.g. the offline status bar) so
 * only the document prints. Injected as a `<style>` (same pattern the document
 * layout uses for theme tokens) to avoid any CSS-import scoping surprises.
 */
const PRINT_CSS = `
.lbr-print { background:#fff; color:#000; }
.lbr-print, .lbr-print * { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
@media screen {
  .lbr-print {
    max-width: 26rem; margin: 1.5rem auto; padding: 1.25rem;
    border:1px solid #e5e7eb; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,.08);
  }
}
@media print {
  body > *:not(.lbr-print) { display:none !important; }
  .lbr-print { max-width:none; margin:0; padding:0; border:0; box-shadow:none; }
}
@page { margin: 8mm; }
.lbr-receipt {
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
  font-size:12px; line-height:1.45;
}
.lbr-receipt__brand { display:flex; align-items:center; justify-content:center; margin-bottom:4px; }
.lbr-receipt__brand img { max-height:32px; max-width:160px; }
.lbr-receipt__lib { text-align:center; font-weight:700; font-size:15px; }
.lbr-receipt__kind {
  text-align:center; text-transform:uppercase; letter-spacing:.08em;
  font-size:11px; color:#444; margin-bottom:10px;
}
.lbr-receipt hr { border:0; border-top:1px dashed #999; margin:10px 0; }
.lbr-receipt__row { display:flex; justify-content:space-between; gap:12px; margin:3px 0; }
.lbr-receipt__row span:first-child { color:#444; }
.lbr-receipt__item { margin:6px 0; }
.lbr-receipt__item strong { display:block; margin-bottom:2px; }
.lbr-receipt__barcode { text-align:center; margin:10px 0 4px; }
.lbr-receipt__foot { text-align:center; color:#555; font-size:10px; margin-top:12px; }
.lbr-label {
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
  text-align:center;
}
.lbr-label__lib { font-size:10px; color:#444; text-transform:uppercase; letter-spacing:.06em; }
.lbr-label__title {
  font-size:12px; font-weight:600; margin:2px auto 6px; max-width:48mm;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.lbr-label__barcode { margin:4px 0; }
.lbr-label__shelf { font-size:11px; margin-top:4px; font-family:monospace; }
`;

export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="lbr-print">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      {children}
      <PrintTrigger />
    </div>
  );
}
