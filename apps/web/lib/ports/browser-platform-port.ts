import type { PlatformKind, PlatformPort, PortAck } from '@libriant/shared/ports';
import { desktopBridge } from '@/lib/desktop';

/**
 * The web's `PlatformPort` — the browser, plus the Electron bridge where it is
 * present.
 *
 * One class rather than two because only ONE of the four capabilities differs
 * between the two hosts (`openExternal`, which the shell routes to the user's
 * real browser instead of a tab). A second class would duplicate three
 * identical methods to vary one.
 */
export class BrowserPlatformPort implements PlatformPort {
  get kind(): PlatformKind {
    return desktopBridge() ? 'desktop' : 'browser';
  }

  /**
   * `navigator.onLine` is the browser's opinion, and it is an optimistic one —
   * a captive portal reads as online. Callers treat `true` as "worth trying"
   * and let the request's own failure be the authority, which is what
   * `OfflineQueueProvider` already does.
   *
   * Returns `true` during a server render: there is no navigator, and a server
   * that is executing this code demonstrably has a network.
   */
  isOnline(): boolean {
    if (typeof navigator === 'undefined') return true;
    return navigator.onLine !== false;
  }

  onOnlineChange(listener: (online: boolean) => void): () => void {
    if (typeof window === 'undefined') return () => undefined;
    const online = () => listener(true);
    const offline = () => listener(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }

  /**
   * Clipboard writes are permission-gated and are refused outright on an
   * insecure origin, so the failure is expected rather than exceptional — hence
   * an ack instead of a throw. Every current caller (support-access codes,
   * recovery codes, outbox ids) shows a toast either way.
   */
  async copyText(text: string): Promise<PortAck> {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      return { ok: false, reason: 'unsupported' };
    }
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'denied' };
    }
  }

  /**
   * Refuses anything but http/https BEFORE handing the URL to a host.
   *
   * The check is here rather than only in the Electron main process because
   * this method is reachable from any screen with any string — including one
   * that arrived in an API response — and on a native host "open this URL"
   * with a `file:` scheme is a local file read. The shell applies the same rule
   * independently; neither guard trusts the other.
   */
  async openExternal(url: string): Promise<PortAck> {
    let parsed: URL;
    try {
      parsed = new URL(url, typeof window === 'undefined' ? 'https://libriant.com' : location.href);
    } catch {
      return { ok: false, reason: 'invalid-url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'forbidden-scheme' };
    }
    const bridge = desktopBridge();
    if (bridge) {
      try {
        return await bridge.openExternal(parsed.href);
      } catch {
        return { ok: false, reason: 'bridge-error' };
      }
    }
    if (typeof window === 'undefined') return { ok: false, reason: 'unsupported' };
    const opened = window.open(parsed.href, '_blank', 'noopener,noreferrer');
    return opened ? { ok: true } : { ok: false, reason: 'popup-blocked' };
  }
}
