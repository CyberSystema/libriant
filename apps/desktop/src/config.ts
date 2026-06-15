import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Where the desktop shell points when nothing else is configured. Override
 * per-deployment with the LIBRIANT_APP_URL env var, or per-user via the
 * persisted config file (Connection → Open config folder). Set this to your
 * Libriant deployment's public URL before packaging installers.
 */
export const DEFAULT_APP_URL = 'https://app.libriant.com';
const DEV_APP_URL = 'http://localhost:3000';

export type WindowBounds = { x?: number; y?: number; width: number; height: number };
export type DesktopConfig = { serverUrl?: string; windowBounds?: WindowBounds };

function configPath(): string {
  return path.join(app.getPath('userData'), 'libriant-desktop.json');
}

export function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function loadConfig(): DesktopConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as DesktopConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveConfig(config: DesktopConfig): void {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
  } catch {
    /* best-effort — a read-only home shouldn't crash the app */
  }
}

/**
 * Resolve the URL to load, in priority order:
 *   1. LIBRIANT_APP_URL env (ops / dev override)
 *   2. persisted serverUrl (the user pointed the app at their own instance)
 *   3. localhost in dev, the packaged default in production
 *
 * In safe mode (`ignoreSaved`) the persisted serverUrl is skipped — the IT
 * escape hatch for a machine wedged on a bad saved URL, without hand-editing
 * the config JSON.
 */
export function resolveStartUrl(
  config: DesktopConfig,
  opts: { ignoreSaved?: boolean } = {},
): string {
  const fromEnv = process.env.LIBRIANT_APP_URL;
  if (isValidHttpUrl(fromEnv)) return fromEnv;
  if (!opts.ignoreSaved && isValidHttpUrl(config.serverUrl)) return config.serverUrl;
  return app.isPackaged ? DEFAULT_APP_URL : DEV_APP_URL;
}
