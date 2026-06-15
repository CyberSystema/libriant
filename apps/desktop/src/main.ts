import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import * as path from 'node:path';
import log from 'electron-log/main';
import * as electronUpdater from 'electron-updater';
import {
  isValidHttpUrl,
  loadConfig,
  resolveStartUrl,
  saveConfig,
  type DesktopConfig,
} from './config.js';

const { autoUpdater } = electronUpdater;

/**
 * Libriant desktop shell. A deliberately thin, hardened Electron window around
 * the Libriant WEB app (the same site librarians use in a browser), plus the
 * desktop conveniences a browser can't offer: single instance, window-state
 * persistence, native menu, camera permission for barcode scanning, external
 * links in the real browser, a bundled offline/setup fallback when the server
 * is unreachable, and renderer-crash self-recovery so an unattended desk never
 * strands on a blank window. All product logic stays on the web side.
 *
 * Security posture: contextIsolation on, nodeIntegration off, sandboxed
 * renderer, no <webview>; navigation pinned to the app origin; every privileged
 * IPC call is gated by a top-frame + origin check (so a cross-origin iframe the
 * web app might embed can't drive the bridge); the preload exposes a minimal,
 * audited surface.
 */

type Ack = { ok: boolean; reason?: string };
const DENIED: Ack = { ok: false, reason: 'untrusted-sender' };

/** Auto-update lifecycle pushed to the web app so it can show a themed,
 *  i18n "update ready — restart" nudge at a safe moment (not mid-checkout). */
type UpdateState = {
  status: 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  message?: string;
};

const FALLBACK_FILE = path.join(__dirname, '..', 'static', 'fallback.html');
// Renderer-crash auto-reload budget: at most this many reloads within the
// window before we stop hammering and show the fallback instead.
const CRASH_RELOADS_MAX = 3;
const CRASH_WINDOW_MS = 60_000;

const safeMode = process.argv.includes('--safe-mode') || process.env.LIBRIANT_SAFE_MODE === '1';

let mainWindow: BrowserWindow | null = null;
let config: DesktopConfig = {};
let appOrigin: string | null = null;
let crashReloads: number[] = [];
let updateReady = false;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Resolve the target URL + where it came from (for diagnostics). */
function resolvedWithSource(): { url: string; source: 'env' | 'config' | 'default' } {
  if (isValidHttpUrl(process.env.LIBRIANT_APP_URL)) {
    return { url: process.env.LIBRIANT_APP_URL as string, source: 'env' };
  }
  if (!safeMode && isValidHttpUrl(config.serverUrl)) {
    return { url: config.serverUrl as string, source: 'config' };
  }
  return { url: resolveStartUrl(config, { ignoreSaved: true }), source: 'default' };
}

/** Only the app's own top frame (or the bundled file:// fallback) may drive
 *  privileged IPC — never a cross-origin sub-frame. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || frame.parent) return false; // must be a top-level frame
  if (frame.url.startsWith('file://')) return true; // the bundled fallback page
  return originOf(frame.url) === appOrigin;
}

async function openExternal(url: string): Promise<Ack> {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') {
      await shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false, reason: 'unsupported-protocol' };
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
}

function persistBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  config.windowBounds = mainWindow.getBounds();
  saveConfig(config);
}

function loadAppUrl(url: string): void {
  appOrigin = originOf(url);
  if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(url);
}

/** Show the bundled offline/setup page when the server can't be reached. */
function loadFallback(failedUrl: string, errorDesc: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void mainWindow.loadFile(FALLBACK_FILE, { query: { url: failedUrl, error: errorDesc } });
}

function createWindow(): void {
  const { url: startUrl } = resolvedWithSource();
  appOrigin = originOf(startUrl);
  const b = config.windowBounds;

  mainWindow = new BrowserWindow({
    width: b?.width ?? 1280,
    height: b?.height ?? 832,
    x: b?.x,
    y: b?.y,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: '#f6f8fa',
    title: 'Libriant',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
    },
  });

  // Mark requests as the desktop shell so the server/web side can adapt.
  const wc = mainWindow.webContents;
  wc.setUserAgent(`${wc.getUserAgent()} LibriantDesktop/${app.getVersion()}`);

  // Show only once something has painted — no half-loaded flash.
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  void mainWindow.loadURL(startUrl);

  mainWindow.on('moved', persistBounds);
  mainWindow.on('resize', persistBounds);
  mainWindow.on('close', persistBounds);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // window.open / target=_blank → system browser; never a second in-app window.
  wc.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: 'deny' };
  });

  // Top-level navigation stays on the app origin; external → browser.
  wc.on('will-navigate', (event, url) => {
    if (appOrigin && originOf(url) === appOrigin) return;
    if (url.startsWith('file://')) return; // the fallback page
    event.preventDefault();
    void openExternal(url);
  });

  wc.on('will-attach-webview', (event) => event.preventDefault());

  // Server unreachable (offline / bad URL / DNS) → show the bundled fallback
  // instead of a raw Chromium error page. Ignore sub-frames and user-aborted
  // navigations, and never recurse on the fallback's own file:// load.
  wc.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = ERR_ABORTED
    if (!validatedURL.startsWith('http')) return;
    loadFallback(validatedURL, errorDesc || `error ${errorCode}`);
  });

  // Renderer crash → bounded auto-reload so an unattended desk/kiosk recovers
  // on its own. Safe because circulation writes are idempotent + IndexedDB-
  // queued, so a reload loses no in-flight action.
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || details.reason === 'killed') return;
    const now = Date.now();
    crashReloads = crashReloads.filter((t) => now - t < CRASH_WINDOW_MS);
    crashReloads.push(now);
    if (crashReloads.length <= CRASH_RELOADS_MAX) {
      loadAppUrl(resolvedWithSource().url);
    } else {
      loadFallback(appOrigin ?? '', 'The app crashed repeatedly.');
    }
  });
}

function configurePermissions(): void {
  // Camera (barcode scanning), notifications and sanitized clipboard writes are
  // granted ONLY to the app's own origin; everything else is denied.
  const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write']);
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(originOf(wc?.getURL() ?? '') === appOrigin && allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return requestingOrigin === appOrigin && allowed.has(permission);
  });
}

function setServerUrl(url: unknown): Ack {
  if (!isValidHttpUrl(url)) return { ok: false, reason: 'invalid-url' };
  config.serverUrl = url;
  saveConfig(config);
  loadAppUrl(url);
  return { ok: true };
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
      ],
    },
    {
      label: 'Connection',
      submenu: [
        { label: 'Reload from server', click: () => loadAppUrl(resolvedWithSource().url) },
        {
          label: 'Safe mode (ignore saved server)',
          click: () => loadAppUrl(resolveStartUrl(config, { ignoreSaved: true })),
        },
        { type: 'separator' },
        { label: 'Open config folder…', click: () => void shell.openPath(app.getPath('userData')) },
        {
          label: 'Reset to default server',
          click: () => {
            delete config.serverUrl;
            saveConfig(config);
            loadAppUrl(resolvedWithSource().url);
          },
        },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Check for updates…',
          enabled: app.isPackaged,
          click: () => void autoUpdater.checkForUpdates().catch(() => undefined),
        },
        {
          label: 'Open logs…',
          click: () => shell.showItemInFolder(log.transports.file.getFile().path),
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function initLogging(): void {
  log.initialize();
  log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB, rotated — bounded on disk
  log.info(`Libriant desktop ${app.getVersion()} starting on ${process.platform}`);
}

function sendUpdateState(state: UpdateState): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('libriant:update-state', state);
  }
}

/**
 * Auto-update via the signed release feed (packaged builds only — a dev build
 * has no feed). Downloads in the background and installs on quit by default, so
 * a fleet patches itself on the next restart even with no UI. The lifecycle is
 * pushed to the web app (sendUpdateState) so it can offer a "restart now" nudge
 * at a safe moment; `installUpdate()` performs the restart on demand.
 */
function initAutoUpdate(): void {
  if (!app.isPackaged) return;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdateState({ status: 'checking' }));
  autoUpdater.on('update-available', (i) =>
    sendUpdateState({ status: 'available', version: i.version }),
  );
  autoUpdater.on('update-not-available', () => sendUpdateState({ status: 'none' }));
  autoUpdater.on('download-progress', (p) =>
    sendUpdateState({ status: 'downloading', percent: Math.round(p.percent) }),
  );
  autoUpdater.on('update-downloaded', (i) => {
    updateReady = true;
    sendUpdateState({ status: 'downloaded', version: i.version });
  });
  autoUpdater.on('error', (e) =>
    sendUpdateState({ status: 'error', message: String((e as Error)?.message ?? e) }),
  );
  void autoUpdater.checkForUpdates().catch(() => undefined);
  // Re-check periodically for long-running desk machines.
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => undefined), 6 * 60 * 60 * 1000);
}

// --- Audited IPC bridge (see preload.ts) -----------------------------------
ipcMain.handle('libriant:get-info', () => {
  const { url, source } = resolvedWithSource();
  return {
    version: app.getVersion(),
    platform: process.platform,
    serverUrl: url,
    serverUrlSource: source,
    safeMode,
  };
});
ipcMain.handle('libriant:set-server-url', (e, url: unknown) =>
  isTrustedSender(e) ? setServerUrl(url) : DENIED,
);
ipcMain.handle('libriant:retry', (e): Ack => {
  if (!isTrustedSender(e)) return DENIED;
  loadAppUrl(resolvedWithSource().url);
  return { ok: true };
});
ipcMain.handle('libriant:open-external', (e, url: unknown) => {
  if (!isTrustedSender(e)) return Promise.resolve(DENIED);
  return typeof url === 'string'
    ? openExternal(url)
    : Promise.resolve({ ok: false, reason: 'invalid-url' });
});
ipcMain.handle('libriant:install-update', (e): Ack => {
  if (!isTrustedSender(e)) return DENIED;
  if (!updateReady) return { ok: false, reason: 'no-update-ready' };
  // Reply first, then restart into the update.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
});

// --- Lifecycle --------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    initLogging();
    config = loadConfig();
    configurePermissions();
    buildMenu();
    createWindow();
    initAutoUpdate();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // App-wide guard: any web contents that tries to open a window sends the URL
  // to the browser instead.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      void openExternal(url);
      return { action: 'deny' };
    });
  });
}
