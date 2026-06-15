# Signing & releasing the Libriant desktop app

The desktop app builds fine **unsigned** (handy for local testing) — macOS
Gatekeeper and Windows SmartScreen will simply warn users. For a real release
you sign + notarize so installs are clean. macOS and Windows are independent;
set up either, both, or neither. Linux (`AppImage`/`.deb`) needs no signing.

Everything is driven by **GitHub Actions repo secrets** consumed by
[`.github/workflows/desktop-release.yml`](../../.github/workflows/desktop-release.yml).
We use the **modern, hardware-token-free paths**: App Store Connect **API key**
for macOS notarization and **Azure Trusted Signing** for Windows.

## Ship now, sign later

You don't need any of these secrets to release. With a platform's secrets
**absent**, [`desktop-release.yml`](../../.github/workflows/desktop-release.yml)
still builds and publishes a working **unsigned** installer for that OS; add the
secrets later and the next tagged release signs automatically — **no code or
config change**. What unsigned costs you until then:

- **macOS** — Gatekeeper shows "unidentified developer" (users right-click →
  **Open**, or `xattr -dr com.apple.quarantine Libriant.app`). **Auto-update is
  off**: Apple's updater requires a valid signature, so Macs update by
  re-downloading the installer until you sign.
- **Windows** — SmartScreen shows "unknown publisher" (users click **More info →
  Run anyway**). Auto-update **still works** — the workflow disables the update
  signature check for unsigned builds.
- **Linux** — no signing expected; installers and auto-update work as-is.

The app is otherwise fully functional unsigned, including the camera barcode
scanner (the hardened-runtime camera entitlement only takes effect once
notarized). Signing buys install trust + macOS auto-update, not features.

## Secrets at a glance

| Secret                  | Platform | What it is                                                       |
| ----------------------- | -------- | ---------------------------------------------------------------- |
| `MAC_CSC_LINK`          | macOS    | Developer ID Application cert (`.p12`), base64-encoded           |
| `MAC_CSC_KEY_PASSWORD`  | macOS    | Password you set when exporting the `.p12`                       |
| `APPLE_API_KEY_P8`      | macOS    | App Store Connect API key (`.p8`), base64-encoded (notarization) |
| `APPLE_API_KEY_ID`      | macOS    | The API key's Key ID                                             |
| `APPLE_API_ISSUER`      | macOS    | The API key's Issuer ID (a UUID)                                 |
| `AZURE_TENANT_ID`       | Windows  | Entra ID tenant of the signing service principal                 |
| `AZURE_CLIENT_ID`       | Windows  | Service-principal (app registration) client ID                   |
| `AZURE_CLIENT_SECRET`   | Windows  | Service-principal client secret                                  |
| `AZURE_TS_ENDPOINT`     | Windows  | Trusted Signing account endpoint URI (region-specific)           |
| `AZURE_TS_ACCOUNT`      | Windows  | Trusted Signing **account** name                                 |
| `AZURE_TS_CERT_PROFILE` | Windows  | Trusted Signing **certificate profile** name                     |
| `WIN_PUBLISHER_NAME`    | Windows  | Exact subject/publisher name on that certificate profile         |

`GITHUB_TOKEN` is provided automatically and publishes the release.

---

## macOS

**Prerequisite:** Apple Developer Program — **$99/year**. Enroll as an
_Organization_ (needs a free D-U-N-S number) so the certificate carries
"CyberSystema".

### 1. Developer ID Application certificate → `MAC_CSC_LINK`

1. [developer.apple.com](https://developer.apple.com) → Certificates → ＋ →
   **Developer ID Application** (distribution _outside_ the App Store).
2. It needs a CSR: **Keychain Access → Certificate Assistant → Request a
   Certificate From a Certificate Authority** → save to disk → upload it →
   download the resulting `.cer` → double-click to import into your login
   keychain.
3. In Keychain Access, expand the cert to confirm its **private key** is under
   it, right-click the cert → **Export…** → `.p12`, set a password
   (→ `MAC_CSC_KEY_PASSWORD`).
4. Base64-encode for the secret:
   ```bash
   base64 -i DeveloperID.p12 | pbcopy   # paste as MAC_CSC_LINK
   ```

### 2. App Store Connect API key (notarization) → `APPLE_API_KEY_*`

Cleaner + longer-lived than an Apple-ID + app-specific password.

1. [App Store Connect](https://appstoreconnect.apple.com) → **Users and Access →
   Integrations → App Store Connect API** → generate a **Team key** with the
   **Developer** role (enough for notarytool).
2. Download the `.p8` (**one time only**). Note the **Key ID** and the **Issuer
   ID** shown on that page.
3. Set the secrets:
   ```bash
   base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy   # APPLE_API_KEY_P8
   ```
   `APPLE_API_KEY_ID` = the Key ID, `APPLE_API_ISSUER` = the Issuer ID (UUID).

The workflow decodes the `.p8` to a file, points `APPLE_API_KEY` at it, and runs
electron-builder with `--config.mac.notarize=true`.

---

## Windows — Azure Trusted Signing (recommended)

Since mid-2023, publicly-trusted Authenticode private keys must live on hardware
(HSM/USB token), so a plain `.pfx` is no longer issued for new public certs.
**Azure Trusted Signing** is the cloud alternative — **~$9.99/month**, no token,
and supported natively by electron-builder.

1. **Azure subscription** → create a **Trusted Signing account** (in a supported
   region; note its **endpoint URI**, e.g. `https://eus.codesigning.azure.net/`
   → `AZURE_TS_ENDPOINT`; the account name → `AZURE_TS_ACCOUNT`).
2. Create a **Certificate Profile** of type **Public Trust**. Microsoft runs a
   one-time **identity validation** of your organization (a few days). The
   profile name → `AZURE_TS_CERT_PROFILE`; the validated subject name (e.g.
   "CyberSystema") → `WIN_PUBLISHER_NAME`.
3. **Service principal:** Entra ID → App registrations → new registration →
   note the **Application (client) ID** (`AZURE_CLIENT_ID`) and **Directory
   (tenant) ID** (`AZURE_TENANT_ID`); under **Certificates & secrets** create a
   **client secret** (`AZURE_CLIENT_SECRET`).
4. Grant that principal the **Trusted Signing Certificate Profile Signer** role
   on the Trusted Signing account (Access control → Add role assignment).

electron-builder installs the `TrustedSigning` module on the runner and signs
via the service-principal env vars; the workflow passes the account/profile/
endpoint/publisher through `--config.win.azureSignOptions.*`.

### Legacy fallback (`.pfx`)

If you already hold an exportable (pre-2023) cert, you can instead sign with a
`.pfx`: set `WIN_CSC_LINK` (base64) + `WIN_CSC_KEY_PASSWORD`, drop the Azure
secrets, and switch the Windows branch of the workflow back to a plain
`electron-builder --publish always` (electron-builder auto-detects `WIN_CSC_LINK`).

---

## Adding the secrets to GitHub

Repo → **Settings → Secrets and variables → Actions → New repository secret**,
one per row above. Or via the CLI:

```bash
gh secret set MAC_CSC_LINK < mac_csc_link.b64
gh secret set APPLE_API_KEY_P8 < apple_key.b64
gh secret set AZURE_CLIENT_SECRET --body '…'
# …etc
```

(The non-secret Windows values — `WIN_PUBLISHER_NAME`, `AZURE_TS_ENDPOINT`,
`AZURE_TS_ACCOUNT`, `AZURE_TS_CERT_PROFILE` — can be repo _variables_ instead of
secrets; if you do that, change `secrets.X` to `vars.X` in the workflow.)

## Cutting a release

```bash
# bump apps/desktop/package.json "version", then:
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

The `desktop-release` workflow builds on macOS/Windows/Linux, signs (+ notarizes
on macOS), and publishes the installers + `latest.yml` to a GitHub Release. The
running app's electron-updater then picks it up automatically (background
download, install on quit).

## Verifying

- **macOS:** `spctl -a -vvv "Libriant.app"` → "accepted, source=Notarized
  Developer ID"; `codesign -dv --verbose=4 "Libriant.app"`.
- **Windows:** right-click the `.exe` → Properties → Digital Signatures, or
  `signtool verify /pa /v Libriant-Setup.exe`.

## Costs

|                         |                                               |
| ----------------------- | --------------------------------------------- |
| Apple Developer Program | $99 / year                                    |
| Azure Trusted Signing   | ~$9.99 / month + one-time identity validation |
| Linux                   | free (unsigned AppImage/.deb; optional GPG)   |
