import { contextBridge, ipcRenderer } from 'electron';

/**
 * The ONLY surface the renderer gets, exposed as `window.libriantDesktop`.
 * Tiny and audited. Read-only calls (`isDesktop`, `getInfo`) are always safe;
 * the mutating calls return `{ ok, reason }` and are enforced in main.ts by an
 * origin/top-frame guard, so a cross-origin iframe the web app might embed
 * (e.g. a payment provider) can never drive them. Grants no filesystem access
 * and no arbitrary IPC — every channel maps to a specific validated handler.
 *
 * The same bridge serves the bundled offline/setup fallback page (file://),
 * which is why `setServerUrl` / `retry` are reachable from there too.
 */
type Ack = { ok: boolean; reason?: string };

contextBridge.exposeInMainWorld('libriantDesktop', {
  isDesktop: true,
  /** App version, platform, the URL currently targeted + where it came from. */
  getInfo: (): Promise<{
    version: string;
    platform: string;
    serverUrl: string;
    serverUrlSource: 'env' | 'config' | 'default';
    safeMode: boolean;
  }> => ipcRenderer.invoke('libriant:get-info'),
  /** Point the shell at a different Libriant instance (persisted + reloaded). */
  setServerUrl: (url: string): Promise<Ack> => ipcRenderer.invoke('libriant:set-server-url', url),
  /** Re-attempt loading the configured server URL (used by the fallback). */
  retry: (): Promise<Ack> => ipcRenderer.invoke('libriant:retry'),
  /** Open a URL in the user's default browser. */
  openExternal: (url: string): Promise<Ack> => ipcRenderer.invoke('libriant:open-external', url),
});
