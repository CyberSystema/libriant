# Libriant graphic assets

Every visual element used by the Libriant UI lives in this folder. Replacing a file
here changes the look across the platform with **no code changes, no rebuild, no deploy**.

## How it works

- The web app references assets through a typed helper (`<Asset name="icons/book" />`)
  which resolves to a URL served from this folder via Caddy (or Next's dev server).
- Theme values (colours, fonts, spacing, radii) live in `theme/tokens.json`. The web
  app reads them at boot and emits them as CSS custom properties on `:root`.
- `manifest.json` is the source of truth for what slots the app knows about. CI fails
  if a slot points to a missing file or if code references a slot not listed here.

## How to change the look

1. Edit or replace a file in this folder (e.g. `brand/logo.svg`).
2. Reload a page in the app — within seconds, every screen picks up the new asset.
3. To change colours or fonts, edit `theme/tokens.json` and either reload or call
   `POST /admin/assets/reload` to clear the server cache without a restart.

## Folder layout

- `brand/` — logos, wordmark, favicon
- `icons/` — UI icons (semantic names: `book`, `member`, not `circle-grey`)
- `illustrations/` — hero art, empty states, system pages
- `covers/` — book cover placeholder(s)
- `photos/` — member photo placeholder(s)
- `theme/tokens.json` — colours, fonts, spacing, radii
- `theme/fonts/` — optional self-hosted font files
- `manifest.json` — declared slots + file paths
