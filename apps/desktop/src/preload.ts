import { contextBridge, ipcRenderer } from 'electron';

/**
 * The ONLY surface the renderer (the Libriant web app) gets from the desktop
 * shell, exposed as `window.libriantDesktop`. Intentionally tiny and audited:
 * it lets the web side detect that it's running inside the desktop app and use
 * a few native niceties. It grants no filesystem access and no arbitrary IPC —
 * every channel below maps to a specific, validated handler in main.ts.
 */
contextBridge.exposeInMainWorld('libriantDesktop', {
  isDesktop: true,
  /** App version + platform + the URL currently loaded. */
  getInfo: (): Promise<{ version: string; platform: string; serverUrl: string }> =>
    ipcRenderer.invoke('libriant:get-info'),
  /** Point the shell at a different Libriant instance (persisted). Returns
   *  false if the URL isn't a valid http(s) URL. */
  setServerUrl: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('libriant:set-server-url', url),
  /** Open a URL in the user's default browser. */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('libriant:open-external', url),
});
