import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * The ONLY surface the renderer gets, exposed as `window.libriantDesktop`.
 * Tiny and audited. Read-only calls (`isDesktop`, `getInfo`, `onUpdateState`)
 * are always safe; the mutating calls return `{ ok, reason }` and are enforced
 * in main.ts by an origin/top-frame guard, so a cross-origin iframe the web app
 * might embed (e.g. a payment provider) can never drive them. Grants no
 * filesystem access and no arbitrary IPC.
 *
 * The same bridge serves the bundled offline/setup fallback page (file://),
 * which is why `setServerUrl` / `retry` are reachable from there too.
 */
type Ack = { ok: boolean; reason?: string };
type UpdateState = {
  status: 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  message?: string;
};

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
  /** Subscribe to auto-update lifecycle events; returns an unsubscribe fn so
   *  the web app can show a themed "update ready — restart" nudge. */
  onUpdateState: (cb: (state: UpdateState) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, state: UpdateState) => cb(state);
    ipcRenderer.on('libriant:update-state', listener);
    return () => ipcRenderer.removeListener('libriant:update-state', listener);
  },
  /** Quit + install a downloaded update now (e.g. from a "restart" button). */
  installUpdate: (): Promise<Ack> => ipcRenderer.invoke('libriant:install-update'),
});
