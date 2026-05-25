import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AssetManifest, DesignTokens } from '@libriant/ui';
import { ASSETS_ROOT } from './asset-root';

type Cache<T> = { value: T; loadedAt: number } | null;

let manifestCache: Cache<AssetManifest> = null;
let tokensCache: Cache<DesignTokens> = null;
const TTL_MS = 60_000; // brief cache so swaps are visible quickly

function isFresh<T>(c: Cache<T>): c is { value: T; loadedAt: number } {
  return c !== null && Date.now() - c.loadedAt < TTL_MS;
}

export async function loadManifest(): Promise<AssetManifest> {
  if (isFresh(manifestCache)) return manifestCache.value;
  const file = path.join(ASSETS_ROOT, 'manifest.json');
  const raw = await fs.readFile(file, 'utf8');
  const value = JSON.parse(raw) as AssetManifest;
  manifestCache = { value, loadedAt: Date.now() };
  return value;
}

export async function loadTokens(): Promise<DesignTokens> {
  if (isFresh(tokensCache)) return tokensCache.value;
  const file = path.join(ASSETS_ROOT, 'theme', 'tokens.json');
  const raw = await fs.readFile(file, 'utf8');
  const value = JSON.parse(raw) as DesignTokens;
  tokensCache = { value, loadedAt: Date.now() };
  return value;
}

export function invalidateAssetCaches() {
  manifestCache = null;
  tokensCache = null;
}

/**
 * Safely resolve a path under ASSETS_ROOT, refusing any traversal attempts.
 */
export function resolveAssetPath(relative: string): string | null {
  const normalized = path.normalize(relative).replace(/^[/\\]+/, '');
  const full = path.resolve(ASSETS_ROOT, normalized);
  if (!full.startsWith(ASSETS_ROOT + path.sep) && full !== ASSETS_ROOT) {
    return null;
  }
  return full;
}
