import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { loadEnv } from '../config/env.js';

export type DesktopPlatform = 'mac' | 'win' | 'linux';

type ReleaseAsset = {
  name: string;
  /** Public per-asset URL (works for public repos without a token). */
  downloadUrl: string;
  /** GitHub API asset URL — with a token + `Accept: octet-stream` this streams
   *  the binary even for PRIVATE repos. */
  apiUrl: string;
  size: number;
  contentType: string;
};
type ResolvedRelease = { version: string; assets: Partial<Record<DesktopPlatform, ReleaseAsset>> };

/** First asset whose name matches wins per platform (electron-builder targets). */
const ASSET_MATCHERS: Record<DesktopPlatform, RegExp> = {
  mac: /\.dmg$/i,
  win: /\.exe$/i,
  linux: /\.AppImage$/i,
};

type GhRelease = {
  tag_name: string;
  draft: boolean;
  created_at?: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    url: string;
    size: number;
    content_type: string;
  }>;
};

/**
 * Resolves + proxies the latest Libriant desktop release from GitHub Releases
 * (the same feed electron-updater reads). Release METADATA is cached briefly so
 * we don't hit the GitHub API on every page view; the installer itself is
 * streamed through (never buffered or cached — it's ~100 MB). A token is only
 * needed for a private repo (and lifts the unauthenticated rate limit).
 */
@Injectable()
export class DesktopReleaseService {
  private readonly logger = new Logger(DesktopReleaseService.name);
  private readonly repo: string;
  private readonly token: string | null;
  private cache: { at: number; release: ResolvedRelease | null } | null = null;
  private static readonly CACHE_MS = 10 * 60 * 1000;

  constructor() {
    const env = loadEnv();
    this.repo = env.desktopReleaseRepo;
    this.token = env.desktopReleaseToken;
  }

  private ghHeaders(accept: string): Record<string, string> {
    const h: Record<string, string> = { Accept: accept, 'User-Agent': 'libriant-api' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /** Latest non-draft desktop installer release, or null if none / unreachable. */
  async getLatest(): Promise<ResolvedRelease | null> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < DesktopReleaseService.CACHE_MS) {
      return this.cache.release;
    }
    let release: ResolvedRelease | null = null;
    try {
      const res = await fetch(`https://api.github.com/repos/${this.repo}/releases?per_page=30`, {
        headers: this.ghHeaders('application/vnd.github+json'),
      });
      if (!res.ok) {
        this.logger.warn(`GitHub releases fetch failed (${res.status}) for ${this.repo}`);
      } else {
        const list = (await res.json()) as GhRelease[];
        // Identify the desktop release by its installer ASSETS, not a tag
        // prefix: electron-builder publishes releases tagged `v<version>` (the
        // desktop-release workflow auto-increments that). Sort newest-first by
        // `created_at` explicitly rather than trusting the list endpoint's order,
        // then take the first non-draft release that carries a per-OS installer.
        const rel = Array.isArray(list)
          ? [...list]
              .sort(
                (a, b) =>
                  (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0),
              )
              .find(
                (r) =>
                  !r.draft &&
                  Array.isArray(r.assets) &&
                  r.assets.some((a) => Object.values(ASSET_MATCHERS).some((re) => re.test(a.name))),
              )
          : undefined;
        if (rel) {
          const assets: ResolvedRelease['assets'] = {};
          for (const platform of Object.keys(ASSET_MATCHERS) as DesktopPlatform[]) {
            const a = rel.assets.find((x) => ASSET_MATCHERS[platform].test(x.name));
            if (a) {
              assets[platform] = {
                name: a.name,
                downloadUrl: a.browser_download_url,
                apiUrl: a.url,
                size: a.size,
                contentType: a.content_type,
              };
            }
          }
          // Strip a leading `v` (or legacy `desktop-v`) for the display version.
          release = { version: rel.tag_name.replace(/^(?:desktop-)?v/, ''), assets };
        }
      }
    } catch (err) {
      this.logger.warn(`GitHub releases unreachable: ${String((err as Error)?.message ?? err)}`);
    }
    this.cache = { at: now, release };
    return release;
  }

  /** Stream the installer for a platform to the Express response (proxy). */
  async streamAsset(platform: DesktopPlatform, res: Response): Promise<void> {
    const asset = (await this.getLatest())?.assets[platform];
    if (!asset) {
      res.status(404).json({ message: 'No installer is available for this platform yet.' });
      return;
    }
    // With a token, the API asset URL streams the binary even for a private
    // repo; otherwise the public download URL. fetch follows the redirect to
    // the actual blob storage in both cases.
    const url = this.token ? asset.apiUrl : asset.downloadUrl;
    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(url, {
        headers: this.ghHeaders('application/octet-stream'),
        redirect: 'follow',
      });
    } catch (err) {
      this.logger.warn(`asset fetch error: ${String((err as Error)?.message ?? err)}`);
      res.status(502).json({ message: 'Could not retrieve the installer right now.' });
      return;
    }
    if (!upstream.ok || !upstream.body) {
      this.logger.warn(`asset fetch failed (${upstream.status}) for ${asset.name}`);
      res.status(502).json({ message: 'Could not retrieve the installer right now.' });
      return;
    }
    res.setHeader('Content-Type', asset.contentType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asset.name.replace(/[^\w.-]/g, '_')}"`,
    );
    if (asset.size > 0) res.setHeader('Content-Length', String(asset.size));
    res.setHeader('Cache-Control', 'no-store');

    const body = upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0];
    const nodeStream = Readable.fromWeb(body);
    nodeStream.on('error', (err) => {
      this.logger.warn(`installer stream error for ${asset.name}: ${String(err?.message ?? err)}`);
      if (res.headersSent) res.destroy();
      else res.status(502).end();
    });
    nodeStream.pipe(res);
  }
}
