'use client';
import * as React from 'react';
import type { AssetManifest, AssetName } from './asset-manifest';

type AssetContextValue = {
  manifest: AssetManifest;
  /** URL prefix that serves files from /assets, e.g. "/_assets". */
  baseUrl: string;
};

const AssetContext = React.createContext<AssetContextValue | null>(null);

export function AssetProvider({
  manifest,
  baseUrl,
  children,
}: {
  manifest: AssetManifest;
  baseUrl: string;
  children: React.ReactNode;
}) {
  return <AssetContext.Provider value={{ manifest, baseUrl }}>{children}</AssetContext.Provider>;
}

function useAssetContext(): AssetContextValue {
  const ctx = React.useContext(AssetContext);
  if (!ctx) throw new Error('Asset components must be used inside <AssetProvider>.');
  return ctx;
}

export function useAssetUrl(name: AssetName): { url: string; alt: string } | null {
  const { manifest, baseUrl } = useAssetContext();
  const slot = manifest.slots[name];
  if (!slot) return null;
  return { url: `${baseUrl}/${slot.file}`, alt: slot.alt };
}

type AssetProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  name: AssetName;
  /** Override the manifest alt text; otherwise the slot's alt is used. */
  alt?: string;
};

/**
 * Render an asset by its manifest slot name. The actual file is resolved at
 * render time, so swapping the file in /assets/ takes effect on next reload
 * without a rebuild.
 */
export function Asset({ name, alt, ...rest }: AssetProps) {
  const resolved = useAssetUrl(name);
  if (!resolved) {
    // Browser-oriented package (no `@types/node`): read `process.env`
    // through `globalThis` with a narrow inline type. Bundlers still
    // inline `NODE_ENV` at build time.
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.NODE_ENV !== 'production') {
      console.warn(`[Asset] Unknown slot "${name}". Add it to assets/manifest.json.`);
    }
    return null;
  }
  return <img src={resolved.url} alt={alt ?? resolved.alt} {...rest} />;
}
