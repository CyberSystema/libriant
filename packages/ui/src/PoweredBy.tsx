import * as React from 'react';
import { Asset } from './Asset';

type PoweredByProps = {
  /** Pixel size of the CyberSystema mark. Defaults to 16. */
  size?: number;
  style?: React.CSSProperties;
  className?: string;
};

/**
 * Parent-brand attribution: "Powered by CyberSystema", linking to
 * cybersystema.com. Libriant is a CyberSystema product, so this appears across
 * the app (auth pages, app shells, public footer, …). The logo resolves from
 * the `brand/cybersystema` asset slot, so it's drop-in replaceable with the
 * official file (no rebuild).
 */
export function PoweredBy({ size = 16, style, className }: PoweredByProps) {
  return (
    <a
      href="https://cybersystema.com"
      target="_blank"
      rel="noreferrer"
      className={['lbr-powered-by', className].filter(Boolean).join(' ')}
      aria-label="Powered by CyberSystema — opens cybersystema.com in a new tab"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-2, 0.5rem)',
        fontSize: 'var(--fs-xs, 0.75rem)',
        color: 'var(--color-text-muted, #6b7280)',
        textDecoration: 'none',
        ...style,
      }}
    >
      <span>Powered by</span>
      <Asset name="brand/cybersystema" width={size} height={size} style={{ display: 'block' }} />
      <strong style={{ fontWeight: 600, color: 'var(--color-text, inherit)' }}>CyberSystema</strong>
    </a>
  );
}
