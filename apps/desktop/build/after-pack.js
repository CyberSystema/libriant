'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

/**
 * electron-builder `afterPack` hook — ad-hoc code-sign the macOS bundle when we
 * are building UNSIGNED (no Developer ID cert supplied via CSC_LINK).
 *
 * Why this exists: Apple Silicon refuses to launch a *completely* unsigned
 * arm64 `.app`. Gatekeeper reports it as "'Libriant' is damaged and can't be
 * opened. You should move it to the Trash." — a hard wall with no
 * right-click → Open escape hatch. An ad-hoc signature (`codesign --sign -`,
 * an identity-less signature) is the minimum that makes the binary launchable.
 * The build is still un-notarized, so a downloaded copy shows the ordinary
 * "unidentified developer" prompt the user CAN bypass (right-click → Open, or
 * System Settings → Privacy & Security → Open Anyway). Net effect: "damaged /
 * Move to Trash" (impossible) → "unidentified developer" (one-click bypass).
 *
 * Why `afterPack` and why the CSC_LINK guard: this hook runs after the app is
 * packed but BEFORE electron-builder's own signing step. When a real Developer
 * ID cert IS present (CSC_LINK set), we skip — electron-builder then signs with
 * the proper identity + hardened runtime + entitlements and notarizes, fully
 * overwriting anything we'd do here. So this only ever takes effect on the
 * unsigned path (CI without MAC_CSC_LINK, or a plain local `pnpm package`).
 *
 * Non-darwin packs (the Windows/Linux matrix legs) return immediately — there
 * is no `codesign` there and nothing to do.
 *
 * @param {{ electronPlatformName: string, appOutDir: string,
 *           packager: { appInfo: { productFilename: string } } }} context
 */
exports.default = async function adhocSignUnsignedMac(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // Real signing identity configured → let electron-builder sign it properly.
  if (process.env.CSC_LINK) return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  // `--sign -` = ad-hoc (no identity); `--deep` covers the bundled Electron
  // helper apps + frameworks; `--force` replaces the signature inherited from
  // the prebuilt Electron binary, which our repackaging has invalidated.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`afterPack: ad-hoc signed unsigned macOS build → ${appPath}`);
};
