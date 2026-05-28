'use client';
import * as React from 'react';

type ModalProps = {
  /** Whether the modal is currently shown. */
  open: boolean;
  /** Called when the user dismisses (overlay click, Esc, close button). */
  onClose: () => void;
  /** Visible title above the body. */
  title: React.ReactNode;
  /** Body content. */
  children: React.ReactNode;
  /** Trailing buttons (Cancel, Confirm, etc.). Right-aligned. */
  actions?: React.ReactNode;
  /** Aria label for the close button; localized by the caller. */
  closeLabel?: string;
  /**
   * Accessibility: tag for the underlying `<dialog>` element. Most modals
   * are conventional dialogs; "alertdialog" is for confirmations where the
   * user must explicitly acknowledge (e.g. "delete forever").
   */
  role?: 'dialog' | 'alertdialog';
};

/**
 * Minimal accessible modal. Wraps the native `<dialog>` element so the
 * platform handles focus trapping, Esc, and overlay backdrop. Falls back
 * to a CSS-only modal for browsers without `<dialog>` support.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  closeLabel = 'Close',
  role = 'dialog',
}: ModalProps) {
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  // Native <dialog> dispatches a `cancel` event when the user hits Esc.
  // We swallow the default (which would just close it) and route through
  // our `onClose` so parents can run side effects (e.g. clear form state).
  const handleCancel = (event: React.SyntheticEvent<HTMLDialogElement, Event>) => {
    event.preventDefault();
    onClose();
  };

  return (
    <dialog
      ref={ref}
      className="lbr-modal"
      aria-labelledby="lbr-modal-title"
      role={role}
      onCancel={handleCancel}
      onClick={(e) => {
        // Click on the backdrop (the dialog itself, not its content) closes.
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="lbr-modal__inner">
        <header className="lbr-modal__header">
          <h2 id="lbr-modal-title" className="lbr-modal__title">
            {title}
          </h2>
          <button
            type="button"
            className="lbr-modal__close"
            aria-label={closeLabel}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="lbr-modal__body">{children}</div>
        {actions ? <footer className="lbr-modal__actions">{actions}</footer> : null}
      </div>
    </dialog>
  );
}
