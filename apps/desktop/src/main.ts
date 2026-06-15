import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  session,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import * as path from 'node:path';
import {
  isValidHttpUrl,
  loadConfig,
  resolveStartUrl,
  saveConfig,
  type DesktopConfig,
} from './config.js';

/**
 * Libriant desktop shell. It is deliberately thin: it loads the Libriant WEB
 * app (the same site librarians use in a browser) inside a hardened Electron
 * window and adds a few desktop conveniences — single instance, window-state
 * persistence, native menu, camera permission for barcode scanning, and
 * "open external links in the real browser". All product logic stays on the
 * web side, so the desktop app never drifts from it.
 *
 * Security posture: contextIsolation on, nodeIntegration off, sandboxed
 * renderer, no <webview>, navigation pinned to the app's own origin, and a
 * minimal audited preload bridge. The renderer can do nothing the web app
 * couldn't already do in a browser, plus the handful of things the bridge
 * explicitly exposes.
 */

let mainWindow: BrowserWindow | null = null;
let config: DesktopConfig = {};
let appOrigin: string | null = null;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function openExternal(url: string): Promise<void> {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') {
      await shell.openExternal(url);
    }
  } catch {
    /* ignore malformed URLs */
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

function createWindow(): void {
  const startUrl = resolveStartUrl(config);
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

  // Mark requests as coming from the desktop shell so the server/web side can
  // adapt (the bond between the two).
  const ua = mainWindow.webContents.getUserAgent();
  mainWindow.webContents.setUserAgent(`${ua} LibriantDesktop/${app.getVersion()}`);

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  void mainWindow.loadURL(startUrl);

  mainWindow.on('moved', persistBounds);
  mainWindow.on('resize', persistBounds);
  mainWindow.on('close', persistBounds);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // window.open / target=_blank → the system browser; never a second in-app
  // window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: 'deny' };
  });

  // Top-level navigation stays on the app's own origin; anything else (external
  // help links, payment-provider pages, etc.) opens in the user's browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (appOrigin && originOf(url) === appOrigin) return;
    event.preventDefault();
    void openExternal(url);
  });

  // Defence in depth: refuse to attach <webview>s.
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function configurePermissions(): void {
  // Camera (barcode scanning), notifications and sanitized clipboard writes are
  // granted ONLY to the app's own origin; every other permission/origin is
  // denied.
  const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write']);
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const url = wc?.getURL() ?? '';
    callback(originOf(url) === appOrigin && allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return requestingOrigin === appOrigin && allowed.has(permission);
  });
}

function setServerUrl(url: unknown): boolean {
  if (!isValidHttpUrl(url)) return false;
  config.serverUrl = url;
  saveConfig(config);
  loadAppUrl(url);
  return true;
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
        { label: 'Reload from server', click: () => mainWindow?.webContents.reload() },
        {
          label: 'Open config folder…',
          click: () => void shell.openPath(app.getPath('userData')),
        },
        {
          label: 'Reset to default server',
          click: () => {
            delete config.serverUrl;
            saveConfig(config);
            loadAppUrl(resolveStartUrl(config));
          },
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Audited IPC bridge (see preload.ts) -----------------------------------
ipcMain.handle('libriant:get-info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  serverUrl: resolveStartUrl(config),
}));
ipcMain.handle('libriant:set-server-url', (_e, url: unknown) => setServerUrl(url));
ipcMain.handle('libriant:open-external', (_e, url: unknown) => {
  if (typeof url === 'string') void openExternal(url);
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
    config = loadConfig();
    configurePermissions();
    buildMenu();
    createWindow();

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
