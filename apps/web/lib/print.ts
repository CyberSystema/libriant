/**
 * Print a Libriant document (a circulation receipt or a barcode label).
 *
 * This module is now a thin front for `PrintPort` (`lib/ports/print-port.ts`).
 * It used to hold both implementations as an `if (bridge)` inside one function
 * — which worked, and was exactly the shape phase 6 exists to name: phase 34
 * adds hand-rolled ESC/POS and ZPL, and M8 adds a Tauri host with no Next.js
 * print route at all, so that if/else was on its way to four branches in a file
 * every circulation screen imports.
 *
 * Kept as a named function because `printDocument(target)` reads better at a
 * click handler than `printPort().print(target)`, and because the three current
 * callers (LoanActions, BookDetail, PrintTrigger) predate the port.
 */
import type { PortAck } from '@libriant/shared/ports';
import { printPort } from './ports';

export type { PrintKind, PrintTarget } from '@libriant/shared/ports';
export { buildPrintPath } from './ports';

export async function printDocument(
  target: import('@libriant/shared/ports').PrintTarget,
): Promise<PortAck> {
  return printPort().print(target);
}
