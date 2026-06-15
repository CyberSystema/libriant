# @libriant/desktop

A thin, hardened **Electron shell** around the Libriant web app. It loads the
same site librarians use in a browser and adds desktop conveniences — a real
app window, native menu, single-instance behavior, window-state persistence,
camera access for barcode scanning, "open external links in the real browser",
a bundled offline/setup screen when the server is unreachable, and renderer-
crash self-recovery so an unattended desk never strands on a blank window. All
product logic lives on the web side, so the desktop app never drifts from it.

## Resilience & recovery

- **Unreachable server / first run** — if the app can't load the server (offline,
  wrong URL, DNS), instead of a raw Chromium error it shows a bundled
  [`static/fallback.html`](static/fallback.html) setup screen: it reports the
  problem and lets the user retry, change the server URL, or open it in a
  browser (all via the audited bridge).
- **Renderer crash** — a render-process crash triggers a bounded auto-reload (up
  to 3× / 60s, then the fallback screen). Safe because circulation writes are
  idempotent + IndexedDB-queued, so a reload loses no in-flight action.
- **Safe mode** — **Connection → Safe mode** (or launch with `--safe-mode` /
  `LIBRIANT_SAFE_MODE=1`) ignores a bad _saved_ server URL without hand-editing
  the config — an IT escape hatch.

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

Targets: dmg + zip (mac), nsis (win), AppImage + deb (linux). The app icon is
[`build/icon.png`](build) (electron-builder derives `.icns`/`.ico`). Without
signing secrets this produces an **unsigned** build (electron-builder warns);
with them it signs + (optionally) notarizes — no config change needed.

### Code signing & notarization

Driven entirely by environment variables, so the same config works unsigned
locally and signed in CI:

| Platform       | Secrets                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS sign     | `CSC_LINK` (base64 `.p12`) + `CSC_KEY_PASSWORD`                                                                                               |
| macOS notarize | `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, then set `mac.notarize: true` in [`electron-builder.yml`](electron-builder.yml) |
| Windows sign   | `WIN_CSC_LINK` (base64 `.pfx`) + `WIN_CSC_KEY_PASSWORD` (or Azure Trusted Signing)                                                            |

The macOS build uses **hardened runtime** + [`build/entitlements.mac.plist`](build/entitlements.mac.plist).
The **camera entitlement + `NSCameraUsageDescription` are mandatory** — without
them the barcode scanner is silently blocked once notarized. (`mac.notarize` is
left `false` so an unsigned local `pnpm package` doesn't try to reach Apple.)

## Security

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no
  `<webview>`.
- Navigation is pinned to the configured app origin; everything else opens in
  the system browser.
- The renderer's only privileged surface is `window.libriantDesktop` (see
  [`src/preload.ts`](src/preload.ts)). Read-only calls (`isDesktop`, `getInfo`)
  are always available; **mutating calls are gated by a top-frame + origin
  check** in [`src/main.ts`](src/main.ts) (`isTrustedSender`) and return
  `{ ok, reason }`, so a cross-origin iframe the web app might embed (e.g. a
  payment provider) can never drive the bridge.
- Camera / notification permissions are granted only to the app's own origin.

## Bond with the web app

- Requests carry a `LibriantDesktop/<version>` User-Agent suffix, so the server
  can detect the shell.
- The web app can detect + adapt via `window.libriantDesktop` (typed helper:
  [`apps/web/lib/desktop.ts`](../web/lib/desktop.ts) → `isDesktopApp()`).
