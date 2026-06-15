# @libriant/desktop

A thin, hardened **Electron shell** around the Libriant web app. It loads the
same site librarians use in a browser and adds desktop conveniences — a real
app window, native menu, single-instance behavior, window-state persistence,
camera access for barcode scanning, and "open external links in the real
browser". All product logic lives on the web side, so the desktop app never
drifts from the web app.

## Run in development

```bash
# 0. one-time: fetch the Electron binary. pnpm blocks large binary postinstalls
#    by default, so approve it once (it is NOT downloaded by a plain install):
pnpm rebuild electron        # or: pnpm approve-builds  (then select "electron")

# 1. start the web app (separate terminal)
pnpm --filter @libriant/web dev          # serves http://localhost:3000

# 2. start the desktop shell (loads localhost:3000 automatically in dev)
pnpm --filter @libriant/desktop dev
```

## Point it at a deployment

The URL is resolved in this order:

1. `LIBRIANT_APP_URL` env var — e.g. `LIBRIANT_APP_URL=https://library.example.org pnpm --filter @libriant/desktop start`
2. a persisted per-user setting (the `libriant-desktop.json` config file; open
   its folder via **Connection → Open config folder…**, or set it from the web
   side via `window.libriantDesktop.setServerUrl(url)`)
3. the default in [`src/config.ts`](src/config.ts) (`DEFAULT_APP_URL`) — set
   this to your production URL before packaging.

This makes the same build usable against the hosted service **or** a
self-hosted / on-prem Libriant instance.

## Package installers

```bash
pnpm --filter @libriant/desktop package   # → apps/desktop/release/
```

Targets: dmg + zip (mac), nsis (win), AppImage + deb (linux). Add an app icon
and code-signing in [`electron-builder.yml`](electron-builder.yml) before a
public release.

## Security

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no
  `<webview>`.
- Navigation is pinned to the configured app origin; everything else opens in
  the system browser.
- The renderer's only privileged surface is `window.libriantDesktop` (see
  [`src/preload.ts`](src/preload.ts)) — a small, audited bridge; each channel
  maps to a validated handler in [`src/main.ts`](src/main.ts).
- Camera / notification permissions are granted only to the app's own origin.

## Bond with the web app

- Requests carry a `LibriantDesktop/<version>` User-Agent suffix, so the server
  can detect the shell.
- The web app can detect + adapt via `window.libriantDesktop` (typed helper:
  [`apps/web/lib/desktop.ts`](../web/lib/desktop.ts) → `isDesktopApp()`).
