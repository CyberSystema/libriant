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
  [`static/fallback.html`](static/fallback.html) setup screen: it says in plain
  Greek/English what went wrong (the `ERR_…` code is kept as a support detail,
  not as the message) and lets the user retry, change the server URL, or open it
  in a browser (all via the audited bridge).
- **Renderer crash** — a render-process crash triggers a bounded auto-reload (up
  to 3× / 60s, then the fallback screen). Safe because circulation writes are
  idempotent + IndexedDB-queued, so a reload loses no in-flight action.
- **Safe mode** — **Connection → Safe mode** (or launch with `--safe-mode` /
  `LIBRIANT_SAFE_MODE=1`) ignores a bad _saved_ server URL without hand-editing
  the config — an IT escape hatch.

## Language

Everything the shell itself draws is bilingual **el/en**, Greek by default:

- The **native menu** follows the OS UI language (`app.getLocale()`), because
  that is the same source Electron localizes its own `role` items from —
  keying our labels off anything else gives a half-Greek menu bar. Set
  `LIBRIANT_LOCALE=el|en` to override it on a desk whose OS language isn't the
  staff's.
- The **offline/setup screen** follows the language the librarian was working
  in — every Libriant route is `/<locale>/…`, so the shell reads the locale off
  the URL that failed and falls back to the OS one.

The strings live in [`src/i18n.ts`](src/i18n.ts) (menu) and inline in
[`static/fallback.html`](static/fallback.html) (offline screen) rather than in
`/locales`: the main process is a packaged CommonJS bundle that ships only
`dist/` + `static/`, and the offline page is a `file://` page with no network,
so neither can read the web app's catalogs. Both keep the same flat el/en shape
so they can move to `locales/{el,en}/desktop.json` if the packaging ever carries
them. Adding a key to the English menu catalog without a Greek one fails
`pnpm --filter @libriant/desktop typecheck`.

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

Signing is wired into the release workflow via repo secrets, using the modern
token-free paths: **App Store Connect API key** for macOS notarization and
**Azure Trusted Signing** for Windows. **[SIGNING.md](SIGNING.md)** is the full
runbook — what each secret is, how to obtain it, and how to add it.

The macOS build uses **hardened runtime** + [`build/entitlements.mac.plist`](build/entitlements.mac.plist);
the **camera entitlement + `NSCameraUsageDescription` are mandatory** or the
barcode scanner is silently blocked once notarized. The base config is
signing-agnostic so a local `pnpm package` is unsigned; the workflow supplies
signing at run time.

## Auto-update & diagnostics

- **Auto-update** (packaged builds only) — on launch and every 6h the app checks
  the GitHub Releases feed (`publish` in [`electron-builder.yml`](electron-builder.yml)),
  downloads in the background, and **installs on quit** by default, so a fleet
  patches itself on the next restart with no UI. The web app can opt into a
  nicer flow via the bridge: `window.libriantDesktop.onUpdateState(cb)` to show a
  themed "update ready — restart" nudge, and `installUpdate()` to restart now.
  (The PWA service worker can update web assets but never the Electron/Chromium
  runtime — this is the only way to patch that.) Unsigned **macOS** builds can't
  auto-update — Apple's updater requires a signature — so Macs update by
  re-downloading until the build is signed; unsigned **Windows/Linux** builds
  auto-update fine. See [SIGNING.md](SIGNING.md) → "Ship now, sign later".
- **Diagnostics** — `getInfo()` reports app version, platform, the resolved
  server URL + its source, and safe-mode. A rotating, size-capped log
  (electron-log, 5 MB) lives under the app's user-data dir; open it via
  **Help → Open logs…**.

## Releasing

Push a `desktop-v*` tag (separate from the web/api `main` deploy). The
[`desktop-release`](../../.github/workflows/desktop-release.yml) workflow builds
on macOS/Windows/Linux, signs with the repo secrets, and publishes the
installers + `latest.yml` to GitHub Releases (the update feed). See the workflow
header for the exact secret names.

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
