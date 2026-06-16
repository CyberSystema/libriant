import { headers } from 'next/headers';

export type DesktopPlatform = 'mac' | 'win' | 'linux';

/**
 * Server-side detection of the Electron desktop shell. The shell tags its
 * User-Agent with `LibriantDesktop/<version>` (see apps/desktop/src/main.ts), so
 * the web app can adapt — here, to enforce the paid-plan gate when running in
 * the shell. Spoofing the UA only blocks the spoofer, so it's not a trust issue.
 */
export async function isDesktopRequest(): Promise<boolean> {
  const ua = (await headers()).get('user-agent') ?? '';
  return ua.includes('LibriantDesktop/');
}

/** Best-effort OS guess from a User-Agent, to highlight the matching installer. */
export function guessPlatform(ua: string): DesktopPlatform | null {
  const s = ua.toLowerCase();
  if (s.includes('windows')) return 'win';
  if (s.includes('mac os') || s.includes('macintosh')) return 'mac';
  if (s.includes('linux') || s.includes('cros')) return 'linux';
  return null;
}

export async function guessPlatformFromRequest(): Promise<DesktopPlatform | null> {
  return guessPlatform((await headers()).get('user-agent') ?? '');
}
