/**
 * The web's implementations of the three ports, and the one place that chooses
 * between them.
 *
 * A screen imports `dataPort()` / `platformPort()` / `printPort()` and never
 * names a class. That is the whole mechanism: when M8 renders these screens in
 * the Tauri client, it supplies its own three implementations here and the
 * screens do not change. See `@libriant/shared/ports` for why.
 *
 * Selection is per call rather than cached in a module constant because the
 * desktop bridge is a `window` global that does not exist during a server
 * render and appears only after the preload script has run. A cached
 * `printPort` evaluated at import time in a server component would pin every
 * subsequent print in that process to the browser implementation.
 */
import type { DataPort, PlatformPort, PrintPort } from '@libriant/shared/ports';
import { desktopBridge } from '@/lib/desktop';
import { HttpDataPort } from './http-data-port';
import { BrowserPlatformPort } from './browser-platform-port';
import { BrowserPrintPort, DesktopPrintPort } from './print-port';

export { BROWSER_API_PREFIX, HttpDataPort } from './http-data-port';
export { BrowserPlatformPort } from './browser-platform-port';
export { BrowserPrintPort, DesktopPrintPort, buildPrintPath } from './print-port';

// The data and platform ports are host-independent on the web (both branch
// internally where they must), so one instance each is correct and cheap.
const http = new HttpDataPort();
const platform = new BrowserPlatformPort();
const browserPrint = new BrowserPrintPort();
const desktopPrint = new DesktopPrintPort();

/** The library's data. Paths are API paths — `/t/acme/loans`, never `/lbr-api/…`. */
export function dataPort(): DataPort {
  return http;
}

/** Host capabilities that are not data: clipboard, connectivity, external links. */
export function platformPort(): PlatformPort {
  return platform;
}

/** Paper. Silent through the desktop bridge when it is there, a print tab otherwise. */
export function printPort(): PrintPort {
  return desktopBridge() ? desktopPrint : browserPrint;
}
