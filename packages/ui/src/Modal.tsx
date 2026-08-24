'use client';
import * as React from 'react';
import { Banner } from './Banner';
import { registerOpenModal } from './layers';
import { useUiStrings } from './ui-strings';

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
  /**
   * A failure that happened while this dialog was open — a rejected checkout,
   * a 409, a quota refusal. Rendered as a critical banner at the top of the
   * body and focused, because a toast cannot serve here: a modal dialog makes
   * everything outside itself inert, so a toast fired from a modal can be read
   * but never clicked (frontend-05). Report the failure where the librarian
   * still is.
   */
  error?: React.ReactNode;
  /** Overrides the shared "Close" label for this dialog's × button. */
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
 *
 * The title id is per-instance (`useId`). It used to be the literal
 * `lbr-modal-title`, and pages like the loan detail keep three modals mounted
 * at once differing only by `open`, so three elements carried the same id and
 * `aria-labelledby` resolved to whichever came first in the document — a
 * screen-reader user opening "Mark lost" was told they were in "Return «Dune»"
 * (frontend-12).
 *
 * The header and actions rows are plain `<div>`s. `<header>`/`<footer>` map to
 * the `banner`/`contentinfo` landmarks unless they sit inside an `article`,
 * `aside`, `main`, `nav` or `section` — and `<dialog>` is not on that list, so
 * every mounted modal was donating a second page header and footer to landmark
 * navigation (frontend-24).
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  error,
  closeLabel,
  role = 'dialog',
}: ModalProps) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const errorRef = React.useRef<HTMLDivElement>(null);
  const ui = useUiStrings();
  const instanceId = React.useId();
  const titleId = `${instanceId}-title`;
  const errorId = `${instanceId}-error`;

  React.useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  // Tell the toast stack a dialog has entered the browser top layer, so it can
  // re-promote itself above us instead of being painted under the backdrop.
  React.useEffect(() => {
    if (!open) return undefined;
    return registerOpenModal();
  }, [open]);

  // Focus the failure so it is both announced and scrolled into view — the
  // body scrolls independently and a long form can push the banner off-screen.
  React.useEffect(() => {
    if (open && error) errorRef.current?.focus();
  }, [open, error]);

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
      aria-labelledby={titleId}
      aria-describedby={error ? errorId : undefined}
      role={role}
      onCancel={handleCancel}
      onClick={(e) => {
        // Click on the backdrop (the dialog itself, not its content) closes.
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="lbr-modal__inner">
        <div className="lbr-modal__header">
          <h2 id={titleId} className="lbr-modal__title">
            {title}
          </h2>
          <button
            type="button"
            className="lbr-modal__close"
            aria-label={closeLabel ?? ui.close}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="lbr-modal__body">
          {error ? (
            <div ref={errorRef} id={errorId} tabIndex={-1} className="lbr-modal__error">
              <Banner severity="critical">{error}</Banner>
            </div>
          ) : null}
          {children}
        </div>
        {actions ? <div className="lbr-modal__actions">{actions}</div> : null}
      </div>
    </dialog>
  );
}
