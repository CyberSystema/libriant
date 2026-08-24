'use client';
import * as React from 'react';
import { registerOpenModal } from './layers';
import { useUiStrings } from './ui-strings';

type HelpDrawerProps = {
  open: boolean;
  onClose: () => void;
  /** Title shown in the drawer header (h2). */
  title: React.ReactNode;
  /** Body — markdown-rendered or arbitrary React. Caller decides the format. */
  children: React.ReactNode;
  /** Overrides the shared "Close help" label for this drawer's × button. */
  closeLabel?: string;
};

/**
 * Right-edge slide-in panel for contextual page help. Built on the
 * native `<dialog>` element so the platform handles:
 *
 *   • Focus trap inside the panel while open
 *   • Esc to dismiss (we route through `onClose` so parents can reset)
 *   • Click on the backdrop (the dialog element itself) to dismiss
 *   • Return focus to the trigger when closed
 *
 * Body content is intentionally untyped (React node) — callers can pass
 * either plain markdown rendered to HTML, or fully composed JSX. The
 * primitive doesn't know about page copy; bind translated content at the
 * caller. Its own chrome (the close button's accessible name) comes from
 * `UiStringsProvider`, because the English default it used to carry was never
 * once overridden (frontend-13).
 *
 * Title id is per-instance and the header is a `<div>`, for the same reasons
 * as `Modal` — see frontend-12 and frontend-24 there.
 */
export function HelpDrawer({ open, onClose, title, children, closeLabel }: HelpDrawerProps) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const ui = useUiStrings();
  const titleId = `${React.useId()}-title`;

  React.useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return undefined;
    return registerOpenModal();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="lbr-help-drawer"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="lbr-help-drawer__inner">
        <div className="lbr-help-drawer__header">
          <h2 id={titleId} className="lbr-help-drawer__title">
            {title}
          </h2>
          <button
            type="button"
            className="lbr-help-drawer__close"
            aria-label={closeLabel ?? ui.helpClose}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="lbr-help-drawer__body">{children}</div>
      </div>
    </dialog>
  );
}

type HelpButtonProps = {
  /**
   * Inline-bound drawer content. The button manages its own open state
   * so a caller can wire `<HelpButton title="…">{…}</HelpButton>` without
   * threading `open`/`setOpen` through every page. Pass `as` to make a
   * controlled version when you need to share state with another control.
   */
  title: React.ReactNode;
  children: React.ReactNode;
  /** Overrides the shared "Show help for this page" label. */
  ariaLabel?: string;
};

/**
 * Compact `?` trigger that opens a self-contained `HelpDrawer`. Designed
 * to live in `PageHeader`'s `actions` slot or anywhere else the UX
 * principle "contextual help everywhere" needs to appear. Renders a
 * 28×28 button with a centered glyph + visible focus ring.
 */
export function HelpButton({ title, children, ariaLabel }: HelpButtonProps) {
  const [open, setOpen] = React.useState(false);
  const ui = useUiStrings();
  return (
    <>
      <button
        type="button"
        className="lbr-help-button"
        aria-label={ariaLabel ?? ui.helpShow}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">?</span>
      </button>
      <HelpDrawer open={open} onClose={() => setOpen(false)} title={title}>
        {children}
      </HelpDrawer>
    </>
  );
}
