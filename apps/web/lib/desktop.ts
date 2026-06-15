/**
 * Bridge to the Libriant desktop shell (Electron). When the web app runs inside
 * `@libriant/desktop`, the shell's preload exposes `window.libriantDesktop`;
 * in a normal browser it's absent. Use `isDesktopApp()` to light up
 * desktop-only affordances without breaking the browser experience.
 */
export type LibriantDesktop = {
  isDesktop: true;
  getInfo: () => Promise<{ version: string; platform: string; serverUrl: string }>;
  setServerUrl: (url: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
};

declare global {
  interface Window {
    libriantDesktop?: LibriantDesktop;
  }
}

/** True when running inside the Electron desktop shell. */
export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && window.libriantDesktop?.isDesktop === true;
}

/** The desktop bridge, or null in a browser. */
export function desktopBridge(): LibriantDesktop | null {
  return typeof window !== 'undefined' && window.libriantDesktop ? window.libriantDesktop : null;
}
