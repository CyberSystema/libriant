'use client';
import * as React from 'react';
import { Banner, Button, Modal } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';

/**
 * Camera barcode/ISBN scanner. A thin, dependency-free wrapper over the native
 * `BarcodeDetector` API (Chrome/Edge/Android, recent Safari). It is purely an
 * ENHANCEMENT layered over the manual text field it fills — if the browser
 * can't scan (Firefox today, no camera, denied permission, insecure origin) it
 * shows a clear message and the user just types instead. Nothing depends on it.
 *
 * Correctness notes (the things that bite camera code):
 *   - The MediaStream tracks are ALWAYS stopped on close/unmount (privacy +
 *     the camera LED must go off) — see the effect cleanup.
 *   - Feature detection uses `getSupportedFormats()`, not just
 *     `'BarcodeDetector' in window`, because some platforms expose the class
 *     but support zero formats.
 *   - Detection is polled (~every 250ms), not per-rAF-frame, so slow
 *     `detect()` calls can't pile up.
 *   - `getUserMedia` requires a secure context (HTTPS or localhost); a refusal
 *     is surfaced as a permission/insecure message rather than a silent hang.
 */

type DetectedBarcode = { rawValue: string; format: string };
type BarcodeDetectorInstance = { detect: (src: CanvasImageSource) => Promise<DetectedBarcode[]> };
type BarcodeDetectorCtor = {
  new (opts?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
};

/** Barcode symbologies by use-case. Module constants → stable identity for deps. */
export const SCAN_FORMATS = {
  /** ISBNs are EAN-13 (978/979) — EAN-8 included for short codes. */
  isbn: ['ean_13', 'ean_8'],
  /** Copy barcodes / membership cards: the usual library label symbologies. */
  label: ['code_128', 'code_39', 'codabar', 'itf', 'ean_13', 'ean_8', 'upc_a', 'upc_e'],
} as const;

function detectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null;
  return (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
}

/** Can this browser scan at all? Cheap check for hiding scan buttons up front. */
export function scanningSupported(): boolean {
  return detectorCtor() !== null;
}

type ScanError = 'unsupported' | 'permission' | 'generic';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Fired once with the first decoded value (trimmed). The parent typically
   *  fills a field + closes. */
  onScan: (value: string) => void;
  /** Symbologies to look for — pass a stable reference (e.g. `SCAN_FORMATS.isbn`). */
  formats: readonly string[];
  title: string;
  catalog: Catalog;
  locale: Locale;
};

export function BarcodeScanner({ open, onClose, onScan, formats, title, catalog, locale }: Props) {
  const t = createTranslator(catalog, locale);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [error, setError] = React.useState<ScanError | null>(null);
  // Keep the latest onScan without restarting the camera when its identity changes.
  const onScanRef = React.useRef(onScan);
  onScanRef.current = onScan;

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    const Ctor = detectorCtor();
    if (!Ctor) {
      setError('unsupported');
      return;
    }

    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const stop = () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    void (async () => {
      // Robust support check: the class can exist but support no formats.
      try {
        const supported = Ctor.getSupportedFormats ? await Ctor.getSupportedFormats() : null;
        if (supported && supported.length === 0) {
          if (!cancelled) setError('unsupported');
          return;
        }
      } catch {
        if (!cancelled) setError('unsupported');
        return;
      }

      let detector: BarcodeDetectorInstance;
      try {
        detector = new Ctor({ formats: [...formats] });
      } catch {
        if (!cancelled) setError('unsupported');
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch (err) {
        if (cancelled) return;
        const name = (err as DOMException | undefined)?.name;
        setError(name === 'NotAllowedError' || name === 'SecurityError' ? 'permission' : 'generic');
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) {
        stop();
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        /* autoplay can reject; the stream still renders */
      }

      const poll = async () => {
        if (cancelled || !videoRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          const hit = codes.find((c) => c.rawValue && c.rawValue.trim().length > 0);
          if (hit && !cancelled) {
            onScanRef.current(hit.rawValue.trim());
            return; // one shot — parent closes us
          }
        } catch {
          /* transient per-frame decode error — keep polling */
        }
        if (!cancelled) timer = setTimeout(poll, 250);
      };
      timer = setTimeout(poll, 300);
    })();

    return stop;
  }, [open, formats]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <Button variant="ghost" onClick={onClose}>
          {t('common.actions.cancel')}
        </Button>
      }
    >
      {error ? (
        <Banner severity={error === 'unsupported' ? 'info' : 'warning'}>
          {error === 'unsupported'
            ? t('common.scan.unsupported')
            : error === 'permission'
              ? t('common.scan.permission')
              : t('common.scan.error')}
        </Banner>
      ) : (
        <>
          <div
            style={{
              position: 'relative',
              width: '100%',
              aspectRatio: '4 / 3',
              background: '#000',
              borderRadius: 'var(--radius-md)',
              overflow: 'hidden',
            }}
          >
            {/* Live camera preview — no audio track, so no captions apply. */}
            <video
              ref={videoRef}
              playsInline
              muted
              aria-label={title}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                inset: '22% 12%',
                border: '2px solid var(--color-primary, #fff)',
                borderRadius: 'var(--radius-sm)',
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.25)',
              }}
            />
          </div>
          <p
            style={{
              marginTop: 'var(--sp-2)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--color-text-muted)',
              textAlign: 'center',
            }}
          >
            {t('common.scan.hint')}
          </p>
        </>
      )}
    </Modal>
  );
}
