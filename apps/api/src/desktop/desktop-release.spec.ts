import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit test for DesktopReleaseService.getLatest — the GitHub Releases
 * resolution: picks the newest non-draft `desktop-v*` release, matches one
 * installer per OS, strips the tag prefix to a version, and degrades to null
 * (never throws) on any GitHub failure or unexpected shape.
 *
 * The constructor calls loadEnv(); vitest sets NODE_ENV=test, which would force
 * real secrets — pretend 'development' so loadEnv uses its dev fallbacks.
 */
vi.stubEnv('NODE_ENV', 'development');

import { DesktopReleaseService } from './desktop-release.service.js';

afterAll(() => vi.unstubAllEnvs());

function ghResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

const RELEASES = [
  // Newest first, as GitHub returns them. A non-desktop release and a draft
  // desktop release both precede the real one — both must be skipped.
  { tag_name: 'v1.4.0', draft: false, assets: [] },
  { tag_name: 'desktop-v0.4.0', draft: true, assets: [] },
  {
    tag_name: 'desktop-v0.3.1',
    draft: false,
    assets: [
      {
        name: 'latest.yml',
        browser_download_url: 'https://x/yml',
        url: 'https://api/yml',
        size: 1,
        content_type: 'text/yaml',
      },
      {
        name: 'Libriant-0.3.1-arm64.dmg',
        browser_download_url: 'https://x/dmg',
        url: 'https://api/dmg',
        size: 100,
        content_type: 'application/x-apple-diskimage',
      },
      {
        name: 'Libriant-Setup-0.3.1.exe',
        browser_download_url: 'https://x/exe',
        url: 'https://api/exe',
        size: 200,
        content_type: 'application/x-msdownload',
      },
      {
        name: 'Libriant-0.3.1.AppImage',
        browser_download_url: 'https://x/appimage',
        url: 'https://api/appimage',
        size: 300,
        content_type: 'application/octet-stream',
      },
    ],
  },
];

describe('DesktopReleaseService.getLatest', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('resolves the newest non-draft desktop release and matches per-OS assets', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ghResponse(RELEASES));
    vi.stubGlobal('fetch', fetchMock);

    const rel = await new DesktopReleaseService().getLatest();

    expect(rel).not.toBeNull();
    expect(rel!.version).toBe('0.3.1'); // 'desktop-v' stripped; draft + non-desktop skipped
    expect(rel!.assets.mac?.name).toBe('Libriant-0.3.1-arm64.dmg');
    expect(rel!.assets.win?.name).toBe('Libriant-Setup-0.3.1.exe');
    expect(rel!.assets.linux?.name).toBe('Libriant-0.3.1.AppImage');
    // .yml / .blockmap etc. must not be mistaken for an installer.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches release metadata — a second call within the TTL does not re-fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ghResponse(RELEASES));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new DesktopReleaseService();
    await svc.getLatest();
    await svc.getLatest();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when there is no desktop release', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ghResponse([{ tag_name: 'v9', draft: false, assets: [] }])),
    );
    expect(await new DesktopReleaseService().getLatest()).toBeNull();
  });

  it('returns null (not throw) when GitHub is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await new DesktopReleaseService().getLatest()).toBeNull();
  });

  it('returns null on a non-OK GitHub response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ghResponse({}, false)));
    expect(await new DesktopReleaseService().getLatest()).toBeNull();
  });

  it('returns null on a non-array body (e.g. a rate-limit envelope with a 200)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ghResponse({ message: 'API rate limit exceeded' })),
    );
    expect(await new DesktopReleaseService().getLatest()).toBeNull();
  });

  it('omits a platform whose installer is absent from the release', async () => {
    const macOnly = [
      {
        tag_name: 'desktop-v0.5.0',
        draft: false,
        assets: [
          {
            name: 'Libriant-0.5.0.dmg',
            browser_download_url: 'https://x/dmg',
            url: 'https://api/dmg',
            size: 1,
            content_type: 'application/x-apple-diskimage',
          },
        ],
      },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ghResponse(macOnly)));
    const rel = await new DesktopReleaseService().getLatest();
    expect(rel!.assets.mac).toBeDefined();
    expect(rel!.assets.win).toBeUndefined();
    expect(rel!.assets.linux).toBeUndefined();
  });
});
